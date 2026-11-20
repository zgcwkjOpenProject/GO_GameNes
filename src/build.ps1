#Requires -Version 7.0
<#
.SYNOPSIS
构建 NesGame 的 Windows 发布目录

.EXAMPLE
.\build.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dist = Join-Path $Root 'dist'
$FrontendSource = Join-Path $Root 'frontend'
$RomsSource = Join-Path $Root 'roms'
$Utf8 = [System.Text.UTF8Encoding]::new($false)

# 判断当前位置的 / 是否更可能是正则字面量起点
function Test-JsRegexStart([char]$Left) {
    if ($Left -eq [char]0) { return $true }
    return '([{=,:;!&|?+-*~^<>'.Contains([string]$Left)
}

# 压缩 JavaScript，同时保护字符串、模板字符串和正则字面量
function Minify-JsText([string]$Text) {
    $sb = [System.Text.StringBuilder]::new()
    $state = 'code'
    $pendingSpace = $false
    $pendingNewline = $false
    $lastCodeChar = [char]0
    $regexClass = $false

    for ($i = 0; $i -lt $Text.Length;) {
        $c = $Text[$i]
        $n = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }

        if ($state -eq 'line-comment') {
            if ($c -eq "`r" -or $c -eq "`n") { $state = 'code'; $pendingNewline = $true }
            $i++
            continue
        }
        if ($state -eq 'block-comment') {
            if ($c -eq '*' -and $n -eq '/') { $state = 'code'; $pendingSpace = $true; $i += 2 }
            else { $i++ }
            continue
        }
        if ($state -eq 'sq' -or $state -eq 'dq' -or $state -eq 'tpl' -or $state -eq 'regex') {
            [void]$sb.Append($c)
            if ($c -eq '\' -and $n) { [void]$sb.Append($n); $i += 2; continue }
            if ($state -eq 'sq' -and $c -eq "'") { $state = 'code'; $lastCodeChar = $c }
            elseif ($state -eq 'dq' -and $c -eq '"') { $state = 'code'; $lastCodeChar = $c }
            elseif ($state -eq 'tpl' -and $c -eq '`') { $state = 'code'; $lastCodeChar = $c }
            elseif ($state -eq 'regex') {
                if ($c -eq '[') { $regexClass = $true }
                elseif ($c -eq ']') { $regexClass = $false }
                elseif ($c -eq '/' -and -not $regexClass) { $state = 'code'; $lastCodeChar = $c }
            }
            $i++
            continue
        }

        if ($c -eq '/' -and $n -eq '/') { $state = 'line-comment'; $i += 2; continue }
        if ($c -eq '/' -and $n -eq '*') { $state = 'block-comment'; $i += 2; continue }
        if ($c -eq "`r" -or $c -eq "`n") { $pendingNewline = $true; $pendingSpace = $false; $i++; continue }
        if ([char]::IsWhiteSpace($c)) { $pendingSpace = $true; $i++; continue }

        if ($pendingNewline) {
            $left = if ($sb.Length -gt 0) { $sb[$sb.Length - 1] } else { [char]0 }
            $canEnd = [char]::IsLetterOrDigit($left) -or '_$)]}'.Contains([string]$left) -or $left -eq "'" -or $left -eq '"' -or $left -eq [char]96
            if (($left -eq '+' -or $left -eq '-') -and $sb.Length -gt 1 -and $sb[$sb.Length - 2] -eq $left) { $canEnd = $true }
            $continues = ',.;:)]}([+-*/%&|=!<>?'.Contains([string]$c)
            if ($canEnd -and -not $continues) { [void]$sb.Append(';') }
        }
        elseif ($pendingSpace -and $lastCodeChar -ne [char]0) {
            $leftText = [string]$lastCodeChar
            if ($leftText -match '[A-Za-z0-9_$]' -and [string]$c -match '[A-Za-z0-9_$]') { [void]$sb.Append(' ') }
        }
        $pendingSpace = $false
        $pendingNewline = $false
        [void]$sb.Append($c)
        if ($c -eq "'") { $state = 'sq' }
        elseif ($c -eq '"') { $state = 'dq' }
        elseif ($c -eq '`') { $state = 'tpl' }
        elseif ($c -eq '/' -and (Test-JsRegexStart $lastCodeChar)) { $state = 'regex'; $regexClass = $false }
        $lastCodeChar = $c
        $i++
    }
    return $sb.ToString().Trim()
}

# 压缩 CSS 文本
function Minify-CssText([string]$Text) {
    $Text = [regex]::Replace($Text, '(?s)/\*.*?\*/', '')
    $Text = [regex]::Replace($Text, '\s+', ' ')
    $Text = [regex]::Replace($Text, '\s*([{}:;,>+~])\s*', '$1')
    return ($Text -replace ';}', '}').Trim()
}

# 压缩 HTML 文本
function Minify-HtmlText([string]$Text) {
    $Text = [regex]::Replace($Text, '(?s)<!--.*?-->', '')
    $Text = [regex]::Replace($Text, '>\s+<', '><')
    return ([regex]::Replace($Text, '\s{2,}', ' ')).Trim()
}

# 按扩展名压缩单个前端资源
function Optimize-TextAsset([string]$Path) {
    $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    $content = [System.IO.File]::ReadAllText($Path)
    switch ($ext) {
        '.js' { $content = Minify-JsText $content }
        '.css' { $content = Minify-CssText $content }
        '.html' { $content = Minify-HtmlText $content }
        default { return }
    }
    [System.IO.File]::WriteAllText($Path, $content, $Utf8)
}

# 递归压缩发布目录内的文本资源
function Optimize-TextAssets([string]$RootPath) {
    Get-ChildItem -LiteralPath $RootPath -Recurse -File | ForEach-Object { Optimize-TextAsset $_.FullName }
}

# 生成本次发布使用的静态资源版本号
function Get-AssetVersion {
    return "v$(Get-Date -Format 'yyMMddHHmmss')"
}

# 给 HTML 引用和 ES Module 相对导入追加缓存版本
function Add-AssetVersion([string]$RootPath, [string]$Version) {
    $htmlPattern = '(href|src)=((?:\x22|\x27))((?!https?:|//|about:|data:)[^\x22\x27]*?\.(?:css|js))(?:\?[^\x22\x27]*)?'
    Get-ChildItem -LiteralPath $RootPath -Recurse -File -Filter '*.html' | ForEach-Object {
        $content = [System.IO.File]::ReadAllText($_.FullName)
        $next = [regex]::Replace($content, $htmlPattern, "`$1=`$2`$3?v=$Version")
        [System.IO.File]::WriteAllText($_.FullName, $next, $Utf8)
    }
    $modulePattern = '((?:from|import)\s*(?:\x22|\x27))(\./|\.\./)([^\x22\x27]*?\.js)(?:\?[^\x22\x27]*)?'
    Get-ChildItem -LiteralPath $RootPath -Recurse -File -Filter '*.js' | ForEach-Object {
        $content = [System.IO.File]::ReadAllText($_.FullName)
        $next = [regex]::Replace($content, $modulePattern, "`$1`$2`$3?v=$Version")
        [System.IO.File]::WriteAllText($_.FullName, $next, $Utf8)
    }
}

# 写入发布版本文件
function Add-BuildVersion([string]$RootPath, [string]$Version) {
    $indexPath = Join-Path $RootPath 'index.html'
    $content = [System.IO.File]::ReadAllText($indexPath)
    $next = $content -replace '(<meta name="app-version" content=")[^"]*', ('$1' + $Version)
    [System.IO.File]::WriteAllText($indexPath, $next, $Utf8)
    [System.IO.File]::WriteAllText((Join-Path $RootPath 'version.json'), ('{"version":"' + $Version + '"}'), $Utf8)
}

# 执行命令并在失败时停止构建
function Invoke-Checked([string]$Name, [scriptblock]$Action) {
    Write-Host "[build] $Name" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "$Name 失败，退出码 $LASTEXITCODE" }
}

Push-Location $Root
try {
    if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw '未找到 Go 工具链' }
    if (-not (Test-Path -LiteralPath $FrontendSource -PathType Container)) { throw '未找到 frontend 目录' }
    if (-not (Test-Path -LiteralPath $RomsSource -PathType Container)) { throw '未找到 roms 目录' }

    $assetVersion = Get-AssetVersion
    Write-Host "[version] 发布版本: $assetVersion" -ForegroundColor Green
    Invoke-Checked '检查 Go 工具链' { go version }
    Invoke-Checked '运行测试' { go test ./... }
    Invoke-Checked '运行静态检查' { go vet ./... }

    if (Test-Path -LiteralPath $Dist) { Remove-Item -LiteralPath $Dist -Recurse -Force }
    New-Item -ItemType Directory -Path $Dist -Force | Out-Null
    $frontendOut = Join-Path $Dist 'frontend'
    Copy-Item -LiteralPath $FrontendSource -Destination $frontendOut -Recurse -Force
    Copy-Item -LiteralPath $RomsSource -Destination (Join-Path $Dist 'roms') -Recurse -Force
    Add-BuildVersion $frontendOut $assetVersion
    Optimize-TextAssets $frontendOut
    Add-AssetVersion $frontendOut $assetVersion
    Copy-Item -LiteralPath (Join-Path $Root 'config.json') -Destination (Join-Path $Dist 'config.json') -Force

    Invoke-Checked '编译服务端' { go build '-ldflags=-s -w' -trimpath -o (Join-Path $Dist 'nesbattle.exe') . }
    Write-Host "[done] 发布目录: $Dist" -ForegroundColor Green
}
finally {
    Pop-Location
}
