/**
 * 抓取 classicgamezone.com NES 游戏
 * 从详情页提取当前游戏的 NES ROM
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://classicgamezone.com/zh-cn/nes-games';
const TOTAL_PAGES = 16;
const ROMS_DIR = path.join(__dirname, 'roms');

if (!fs.existsSync(ROMS_DIR)) fs.mkdirSync(ROMS_DIR, { recursive: true });

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redir = res.headers.location.startsWith('http')
          ? res.headers.location : `https://classicgamezone.com${res.headers.location}`;
        return httpGet(redir).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadBin(url, filePath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redir = res.headers.location.startsWith('http')
          ? res.headers.location : `https://classicgamezone.com${res.headers.location}`;
        return downloadBin(redir, filePath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const stream = fs.createWriteStream(filePath);
      res.pipe(stream);
      stream.on('finish', () => { stream.close(); resolve(); });
      stream.on('error', reject);
    }).on('error', reject);
  });
}

function extractGames(html) {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) return [];
  try {
    const json = JSON.parse(match[1]);
    if (!json.hasPart) return [];
    return json.hasPart.itemListElement.map(item => {
      const g = item.item;
      const slug = g.url.match(/\/games\/([^\/]+)$/);
      return {
        name: g.name, description: g.description, image: g.image,
        detailUrl: g.url, slug: slug ? slug[1] : '',
        genre: g.genre, year: g.datePublished, series: g.gameSeries || ''
      };
    });
  } catch { return []; }
}

// 从详情页提取当前游戏的 NES ROM（只匹配当前游戏的 romUrl 块）
function extractNesRoms(html, slug) {
  const roms = new Set();
  
  // 找到 "game":{"id":"slug" 后紧跟的第一个 romUrl 块
  // 在 React Server Components 中格式为: {\"game\":{\"id\":\"slug\",...,\"romUrl\":[...]}}
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  
  // 搜索当前游戏的数据块: "id":"slug" 后面紧跟 "romUrl"
  // 但要排除其他游戏的数据
  const allRomUrlBlocks = [...html.matchAll(/romUrl.*?:.*?\[(.*?)\]/gs)];
  
  for (const block of allRomUrlBlocks) {
    const blockStart = block.index;
    
    // 检查这个 romUrl 块前面最近的 "id" 是否是当前 slug
    const beforeBlock = html.substring(Math.max(0, blockStart - 500), blockStart);
    
    // 找到这个块前面最近的 "id":"xxx"
    const lastIdMatch = [...beforeBlock.matchAll(/\\?"id\\?"\s*:\s*\\?"([^"\\]+)/g)];
    if (lastIdMatch.length > 0) {
      const lastId = lastIdMatch[lastIdMatch.length - 1][1];
      if (lastId === slug) {
        // 这是当前游戏的 romUrl 块
        const nesInBlock = block[1].matchAll(/\/games\/roms\/nes\/[^"'\s\\]+\.nes/g);
        for (const nes of nesInBlock) {
          roms.add(nes[0]);
        }
      }
    }
  }
  
  return [...roms];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processGame(game, index, total) {
  console.log(`[${index}/${total}] ${game.name}`);
  
  let romUrls = [];
  try {
    const html = await httpGet(game.detailUrl);
    romUrls = extractNesRoms(html, game.slug);
  } catch (e) {
    console.log(`  详情页失败: ${e.message}`);
  }
  
  // 兜底：如果详情页没列出 NES ROM，尝试默认 URL
  if (romUrls.length === 0) {
    const defaultUrl = `/games/roms/nes/${game.slug}.nes`;
    try {
      await httpGet(`https://classicgamezone.com${defaultUrl}`);
      romUrls = [defaultUrl];
    } catch {}
  }
  
  if (romUrls.length > 0) {
    console.log(`  找到 ${romUrls.length} 个 ROM`);
  } else {
    console.log(`  无 NES ROM`);
  }
  
  for (const romUrl of romUrls) {
    const filename = path.basename(romUrl);
    const savePath = path.join(ROMS_DIR, filename);
    if (!fs.existsSync(savePath)) {
      try {
        await downloadBin(`https://classicgamezone.com${romUrl}`, savePath);
        console.log(`    ${filename}: ${(fs.statSync(savePath).size / 1024).toFixed(0)} KB`);
      } catch (e) {
        console.log(`    ${filename}: 失败 (${e.message})`);
        if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
      }
    }
  }
  
  if (game.image) {
    const ext = game.image.match(/\.(jpg|jpeg|png|webp)/i)?.[0] || '.webp';
    const coverPath = path.join(ROMS_DIR, `${game.slug}${ext}`);
    if (!fs.existsSync(coverPath)) {
      try { await downloadBin(game.image, coverPath); } catch {}
    }
  }
  
  fs.writeFileSync(path.join(ROMS_DIR, `${game.slug}.txt`), [
    game.name, game.description || '', '',
    `类型: ${game.genre || ''}`, `年份: ${game.year || ''}`,
    `系列: ${game.series || ''}`, `封面: ${game.image || ''}`,
    `详情: ${game.detailUrl || ''}`,
    `ROM: ${romUrls.join(', ') || '无'}`
  ].join('\n'), 'utf-8');
  
  await sleep(200);
}

async function main() {
  console.log('=== NES 游戏抓取工具 ===\n');
  for (let page = 1; page <= TOTAL_PAGES; page++) {
    const url = page === 1 ? BASE_URL : `${BASE_URL}?page=${page}`;
    console.log(`\n第 ${page}/${TOTAL_PAGES} 页`);
    try {
      const html = await httpGet(url);
      const games = extractGames(html);
      console.log(`找到 ${games.length} 个游戏\n`);
      for (let i = 0; i < games.length; i++) {
        await processGame(games[i], i + 1, games.length);
      }
    } catch (e) {
      console.error(`失败: ${e.message}`);
    }
  }
  console.log('\n=== 完成 ===');
}

main().catch(console.error);
