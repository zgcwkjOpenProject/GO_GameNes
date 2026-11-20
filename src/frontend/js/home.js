// 首页大厅：展示正在游玩的对局与可游玩的游戏库
import { $, el, toast, fmtSize, showModal, closeModal, assetPath } from "./common.js"
import { net, ensureLogin } from "./network.js"
import { gotoPage } from "./router.js"

// 游戏封面用名称首字与配色生成，避免额外请求图片资源
const COVER_COLORS = ["#e5484d", "#4d8de5", "#46c46f", "#e5a248", "#a25de5", "#e55d9a"]
const COVER_ICONS = ["🎮", "👾", "🕹️", "🏰", "🚀", "⚔️", "🍄", "🐢"]

// 按游戏名稳定地生成封面样式
function coverFor(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return {
    color: COVER_COLORS[h % COVER_COLORS.length],
    icon: COVER_ICONS[(h >> 3) % COVER_ICONS.length],
  }
}

// 获取游戏封面地址，同名图片存在时使用封面接口，否则返回空串
function coverURL(game) {
  return game.cover ? assetPath("cover") + "?id=" + encodeURIComponent(game.id) : ""
}

// 保存当前游戏库与大厅数据
const PAGE_SIZE = 10
const RECENT_STORAGE_KEY = "nesbattle-recent-games"
const VERSION_CHECK_INTERVAL = 60 * 1000
const state = { games: [], rooms: [], filter: "", gamePage: 1, gamePageCount: 0 }
const gameCache = new Map()
let updatePromptShown = false

// 检查发布目录中的版本文件，开发环境没有该文件时直接跳过
async function checkForUpdate() {
  if (updatePromptShown) return
  try {
    const current = document.querySelector('meta[name="app-version"]')?.content || "dev"
    const res = await fetch(assetPath(`version.json?_=${Date.now()}`), { cache: "no-store" })
    if (!res.ok) return
    const data = await res.json()
    const latest = String(data.version || "").trim()
    if (!latest || latest === current) return

    updatePromptShown = true
    if (window.confirm(`检测到新版本（${latest}），是否立即刷新页面？`)) {
      window.location.reload()
    }
  } catch {
    // 版本文件不存在或网络暂时不可用时不影响正常游玩
  }
}

// 读取最近游玩的游戏
function readRecentGames() {
  try {
    const games = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || "[]")
    return Array.isArray(games) ? games.slice(0, 5) : []
  } catch {
    return []
  }
}

// 保存最近游玩的游戏并刷新列表
function saveRecentGame(game) {
  const games = [game, ...readRecentGames().filter((item) => item.id !== game.id)].slice(0, 5)
  localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(games))
  renderRecent()
}

// 渲染最近游玩的游戏
function renderRecent() {
  const box = $("#recent-grid")
  if (!box) return
  box.innerHTML = ""
  const games = readRecentGames()
  if (!games.length) {
    box.appendChild(el("div", { class: "placeholder" }, "还没有常玩游戏"))
    return
  }
  for (const game of games) box.appendChild(createGameCard(game))
}

// 加载游戏库并启动大厅轮询
export function initHome(openGame) {
  // 保存开局回调供渲染时使用
  state.openGame = openGame
  $("#app-version").textContent = document.querySelector('meta[name="app-version"]')?.content || "dev"
  $("#clear-recent").addEventListener("click", () => {
    localStorage.removeItem(RECENT_STORAGE_KEY)
    renderRecent()
  })
  $("#game-search").addEventListener("input", (e) => {
    state.filter = e.target.value.trim().toLowerCase()
    state.gamePage = 1
    loadGames()
  })
  $("#game-prev").addEventListener("click", () => {
    if (state.gamePage > 1) {
      state.gamePage--
      loadGames()
    }
  })
  $("#game-next").addEventListener("click", () => {
    if (state.gamePage < state.gamePageCount) {
      state.gamePage++
      loadGames()
    }
  })
  loadGames()
  renderRecent()
  loadOnline()
  setInterval(loadOnline, 4000)
  checkForUpdate()
  setInterval(checkForUpdate, VERSION_CHECK_INTERVAL)
  net.on("_open", () => loadOnline())
}

// 拉取游戏库
async function loadGames() {
  try {
    const params = new URLSearchParams({
      q: state.filter,
      page: String(state.gamePage),
      pageSize: String(PAGE_SIZE),
    })
    const res = await fetch(assetPath("api/games") + "?" + params)
    const data = await res.json()
    state.games = data.games || []
    state.gamePage = data.page || 1
    state.gamePageCount = data.totalPages || 0
    for (const game of state.games) gameCache.set(game.id, game)
  } catch {
    state.games = []
    state.gamePageCount = 0
  }
  renderGames()
}

// 拉取正在游玩的对局
async function loadOnline() {
  try {
    const res = await fetch(assetPath("api/online"))
    const data = await res.json()
    state.rooms = data.rooms || []
    $("#online-count").textContent = data.online ? `在玩 ${data.online} 人` : "暂无玩家在线游玩"
    const stats = data.stats || data
    $("#today-play-count").textContent = stats.today ?? 0
    $("#history-play-count").textContent = stats.history ?? stats.total ?? 0
  } catch {
    state.rooms = []
  }
  renderLive()
}

// 渲染正在游玩的对局列表
function renderLive() {
  const box = $("#live-list")
  box.innerHTML = ""
  if (!state.rooms.length) {
    box.appendChild(el("div", { class: "placeholder" }, "暂无进行中的对局，挑一款游戏创建房间吧"))
    return
  }
  for (const r of state.rooms) {
    const full = r.players >= r.cap
    const card = el("div", { class: "live-card" })
    // 优先用游戏库中该游戏的封面图片，找不到再用生成封面
    const gameInfo = gameCache.get(r.gameId)
    const cover = coverFor(r.game)
    const thumb = el("div", { class: "thumb" })
    const url = gameInfo ? coverURL(gameInfo) : ""
    if (url) {
      const img = el("img", { class: "cover-img", alt: r.game, src: url, draggable: "false" })
      img.addEventListener("error", () => {
        img.remove()
        thumb.textContent = cover.icon
        thumb.style.background = `linear-gradient(135deg, ${cover.color}55, var(--bg))`
      })
      thumb.appendChild(img)
    } else {
      thumb.textContent = cover.icon
      thumb.style.background = `linear-gradient(135deg, ${cover.color}55, var(--bg))`
    }
    card.appendChild(thumb)
    const info = el("div", { class: "info" })
    info.appendChild(el("div", { class: "g" }, r.game))
    info.appendChild(el("div", { class: "m" }, `房主 ${r.owner} · ${r.players}/${r.cap} 人`))
    card.appendChild(info)
    if (full) {
      card.appendChild(el("span", { class: "full" }, "已满"))
    } else {
      card.appendChild(el("button", {
        class: "join",
        onclick: (e) => {
          e.stopPropagation()
          joinRoom(r)
        },
      }, "加入"))
    }
    card.addEventListener("click", () => {
      if (!full) joinRoom(r)
    })
    box.appendChild(card)
  }
}

// 渲染游戏库卡片
function renderGames() {
  const box = $("#game-grid")
  box.innerHTML = ""
  if (!state.games.length) {
    box.appendChild(el("div", { class: "placeholder" },
      state.filter ? "没有匹配的游戏" : "roms 目录还没有游戏，请放入 .nes 文件后重启服务"))
    $("#game-pagination").classList.add("hidden")
    return
  }
  const pageCount = state.gamePageCount
  for (const g of state.games) {
    box.appendChild(createGameCard(g))
  }
  const pagination = $("#game-pagination")
  pagination.classList.toggle("hidden", pageCount <= 1)
  $("#game-page-info").textContent = `${state.gamePage} / ${pageCount}`
  $("#game-prev").disabled = state.gamePage <= 1
  $("#game-next").disabled = state.gamePage >= pageCount
}

// 创建游戏库卡片
function createGameCard(g) {
  const cover = coverFor(g.name)
  const card = el("div", { class: "game-card" })
  const cv = el("div", { class: "game-cover" })
  const url = coverURL(g)
  if (url) {
    const img = el("img", { class: "cover-img", alt: g.name, src: url, draggable: "false" })
    img.addEventListener("error", () => {
      img.remove()
      cv.textContent = cover.icon
      cv.style.background = `linear-gradient(135deg, ${cover.color}44, var(--bg-card))`
    })
    cv.appendChild(img)
  } else {
    cv.textContent = cover.icon
    cv.style.background = `linear-gradient(135deg, ${cover.color}44, var(--bg-card))`
  }
  card.appendChild(cv)
  const body = el("div", { class: "gc-body" })
  body.appendChild(el("div", { class: "gc-name" }, g.name))
  if (g.desc) body.appendChild(el("div", { class: "gc-desc" }, g.desc))
  const meta = el("div", { class: "gc-meta" })
  meta.appendChild(el("span", {}, fmtSize(g.size)))
  const playing = state.rooms.filter((r) => r.gameId === g.id).length
  meta.appendChild(el("span", { class: playing ? "badge-online" : "" }, playing ? `${playing} 个对局` : "可创建房间"))
  body.appendChild(meta)
  card.appendChild(body)
  card.addEventListener("click", () => chooseMode(g, state.openGame))
  return card
}

// 弹出单人试玩或创建房间的选择
function chooseMode(game, openGame) {
  const box = el("div", {})
  box.appendChild(el("h3", {}, game.name))
  box.appendChild(el("p", { class: "hint" }, "选择游玩方式：单人直接开始；创建房间后把房间号告诉对手即可联机对战。"))
  const actions = el("div", { class: "actions" })
  actions.appendChild(el("button", {
    class: "btn ghost",
    onclick: () => {
      closeModal()
      saveRecentGame(game)
      fetch(assetPath("api/play"), { method: "POST" }).catch(() => {})
      openGame(game, false)
    },
  }, "单人游玩"))
  actions.appendChild(el("button", {
    class: "btn primary",
    onclick: () => {
      closeModal()
      saveRecentGame(game)
      createRoom(game)
    },
  }, "创建房间"))
  box.appendChild(actions)
  showModal(box)
}

// 创建房间并进入游玩界面
function createRoom(game) {
  ensureLogin(window.__settings, window.__saveSettings, () => {
    window.__pendingRoom = { mode: "create", game }
    net.createRoom(game.id)
  })
}

// 加入指定房间
function joinRoom(room) {
  ensureLogin(window.__settings, window.__saveSettings, () => {
    window.__pendingRoom = { mode: "join", room }
    net.joinRoom(room.roomId)
  })
}

// 处理建房和加入房间的服务器应答
export function initRoomFlow(openGame, openJoined) {
  net.on("create_room_ok", (m) => {
    if (!m.ok) {
      toast(m.error || "创建房间失败", true)
      window.__pendingRoom = null
      return
    }
    const pending = window.__pendingRoom
    toast("房间已创建，等待对手加入…")
    if (pending) openGame(pending.game, true, m.roomId)
    window.__pendingRoom = null
  })
  net.on("join_room_ok", (m) => {
    if (!m.ok) {
      toast(m.error || "加入房间失败", true)
      window.__pendingRoom = null
      return
    }
    const pending = window.__pendingRoom
    const cachedGame = gameCache.get(m.gameId)
    const roomGame = pending?.room?.game
    const game = roomGame
      ? { ...(cachedGame || {}), id: m.gameId, name: roomGame }
      : cachedGame || { id: m.gameId, name: m.gameId, desc: "", cover: "" }
    toast("已加入房间")
    if (pending) openJoined(game, m.roomId, m.name)
    window.__pendingRoom = null
  })
}

// 返回大厅并刷新数据
export function gotoHome() {
  gotoPage("home")
  loadOnline()
}
