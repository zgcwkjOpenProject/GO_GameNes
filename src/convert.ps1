#Requires -Version 7.0
<#
.SYNOPSIS
    批量将源码文件的换行符统一转换为 LF 或 CRLF，递归处理子目录。

.DESCRIPTION
    扫描指定目录（默认脚本所在目录）下的源码文件，按扩展名筛选，
    交互选择要统一使用的换行符。已经符合目标格式的文件会跳过，
    并保留文件原有的 UTF-8 BOM。

.PARAMETER Path
    要处理的目录，默认为脚本自身所在的目录。

.EXAMPLE
    .\convert.ps1
    交互选择换行符格式并处理脚本所在目录。

.EXAMPLE
    .\convert.ps1 -Path "D:\MyProject"
    交互选择换行符格式并处理 D:\MyProject 目录。
#>

[CmdletBinding()]
param(
    [string]$Path = $(if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path })
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Extensions = @(
    '.cs', '.json', '.js', '.css', '.txt', '.c', '.cpp', '.h', '.hpp', '.java',
    '.py', '.html', '.htm', '.xml', '.sql', '.md', '.markdown', '.ts', '.tsx',
    '.jsx', '.vue', '.yml', '.yaml', '.ini', '.conf', '.config', '.csv', '.log',
    '.bat', '.ps1', '.asm', '.go', '.rs', '.rb', '.php', '.swift', '.kt',
    '.scala', '.lua', '.sh', '.pl', '.gradle', '.props', '.targets', '.csproj',
    '.vbproj', '.sln', '.resx', '.gitignore', '.editorconfig', '.gitattributes',
    '.mod', '.sum', '.cnf', '.pem', '.sc', '.service', '.properties', ''
)

$ExtSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($extension in $Extensions) { [void]$ExtSet.Add($extension) }

if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "目录不存在: $Path"
}

$Root = (Resolve-Path -LiteralPath $Path).Path
$formats = @('LF', 'CRLF')

Write-Host "`n可用的换行符格式：" -ForegroundColor Cyan
for ($index = 0; $index -lt $formats.Count; $index++) {
    Write-Host ("  {0}. {1}" -f ($index + 1), $formats[$index])
}

$selection = Read-Host '请输入编号（默认 1）'
if ([string]::IsNullOrWhiteSpace($selection)) {
    $targetFormat = $formats[0]
}
else {
    $selectedIndex = 0
    if (-not [int]::TryParse($selection.Trim(), [ref]$selectedIndex) -or
        $selectedIndex -lt 1 -or $selectedIndex -gt $formats.Count) {
        throw "无效的格式编号：$selection，请输入 1-$($formats.Count)"
    }
    $targetFormat = $formats[$selectedIndex - 1]
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "   批量转换源码文件换行符为 $targetFormat" -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "   目标目录: $Root"
Write-Host ''

$changed = 0
$skipped = 0
$failed = 0

$files = Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
        $_.DirectoryName -notmatch '\\build\\' -and
        $_.DirectoryName -notmatch '\\dist\\' -and
        ($ExtSet.Contains($_.Extension) -or $ExtSet.Contains($_.Name))
    }

foreach ($file in $files) {
    try {
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        if ($bytes.Length -eq 0) { continue }

        $needsConversion = if ($targetFormat -eq 'LF') {
            $bytes -contains [byte]13
        }
        else {
            $hasLoneLf = $false
            for ($index = 0; $index -lt $bytes.Length; $index++) {
                if ($bytes[$index] -eq 10 -and ($index -eq 0 -or $bytes[$index - 1] -ne 13)) {
                    $hasLoneLf = $true
                    break
                }
            }
            $hasLoneLf
        }

        if (-not $needsConversion) {
            $skipped++
            Write-Host "  [已是$targetFormat] $($file.FullName)" -ForegroundColor DarkGray
            continue
        }

        $hasBom = ($bytes.Length -ge 3 -and
            $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
        $encoding = [System.Text.UTF8Encoding]::new($hasBom)
        $content = $encoding.GetString($bytes)
        $content = $content -replace "`r`n", "`n"
        $content = $content -replace "`r", "`n"
        if ($targetFormat -eq 'CRLF') {
            $content = $content -replace "`n", "`r`n"
        }

        [System.IO.File]::WriteAllText($file.FullName, $content, $encoding)
        $changed++
        Write-Host "  [已转换]   $($file.FullName)" -ForegroundColor Green
    }
    catch {
        $failed++
        Write-Host "  [失败]      $($file.FullName) : $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "  已转换: $changed 个文件" -ForegroundColor Green
Write-Host "  已跳过(已是$targetFormat): $skipped 个" -ForegroundColor DarkGray
Write-Host "  失败: $failed 个" -ForegroundColor Red
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''
