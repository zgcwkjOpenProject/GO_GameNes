// 游玩界面：加载 ROM、驱动模拟器并维护单一的房主帧同步
import { $, toast, assetPath, el, showModal, closeModal } from "./common.js"
import { NesRunner } from "./emulator.js"
import { Input, bindTouchPad } from "./input.js"
import { session } from "./session.js"
import { registerPage, gotoPage } from "./router.js"
import { gotoHome } from "./home.js"

// playState 保存游玩界面的状态，不再保存多套同步队列
const playState = {
  runner: null,
  game: null,
  roomId: "",
  isOwner: false,
  peerName: "",
  peerReady: false,
  initialStateSent: false,
  initialStateReady: false,
  initialStateFrame: 0,
  initialStateSending: false,
  pendingFrame: null,
  waiting: false,
  stateEpoch: 0,
  pendingState: null,
  stateChain: Promise.resolve(),
  lastLocalMask: null,
  lastGuestMask: 0,
  guestInputFrame: 0,
  guestStarted: false,
  guestFrames: new Map(),
  nextGuestFrame: 1,
  clearTouchPad: null,
}

// 每个房主帧只发送帧号和两个手柄掩码
const MAX_FRAME_BUFFER = 8
const KEY_MASK = {
  a: 1 << 0, b: 1 << 1, select: 1 << 2, start: 1 << 3,
  up: 1 << 4, down: 1 << 5, left: 1 << 6, right: 1 << 7,
  aa: 1 << 8, bb: 1 << 9,
}
const input = new Input()
const MODE_TEXT = { local: "单机", p2p: "P2P 直连", relay: "服务器中转" }

// 初始化游玩页面和输入设备
export function initPlay(settings, saveSettings) {
  window.__settings = settings
  window.__saveSettings = saveSettings
  input.attach(settings.keys)
  input.onChanged(() => handleLocalInput())
  playState.clearTouchPad = bindTouchPad(input)

  $("#btn-back").addEventListener("click", () => gotoPage("home"))
  $("#btn-reset").addEventListener("click", () => playState.runner?.reset())
  $("#btn-pause").addEventListener("click", (event) => {
    const runner = playState.runner
    if (!runner) return
    runner.setPaused(!runner.paused)
    event.target.textContent = runner.paused ? "继续" : "暂停"
  })
  $("#btn-fullscreen").addEventListener("click", toggleFullscreen)
  $("#btn-save").addEventListener("click", openSaveModal)
  document.addEventListener("fullscreenchange", handleFullscreenChange)

  const unlockAudio = () => {
    if (playState.runner && window.__settings.volume > 0) {
      playState.runner.enableAudio(window.__settings.volume).catch(() => {})
    }
  }
  window.addEventListener("pointerdown", unlockAudio)
  window.addEventListener("keydown", unlockAudio)
  $("#stage").addEventListener("click", unlockAudio)
  registerPage("play", () => {
    input.enabled = true
    unlockAudio()
  }, leavePlay)
  input.enabled = false
}

// 切换全屏并在支持时锁定横屏
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      return
    }
    const page = $("#page-play")
    if (!page.requestFullscreen) {
      toast("当前浏览器不支持全屏", true)
      return
    }
    await page.requestFullscreen()
    try {
      await window.screen.orientation?.lock("landscape")
    } catch {
      // 部分移动浏览器不允许网页锁定方向
    }
  } catch {
    toast("无法进入全屏，请检查浏览器权限", true)
  }
}

// 全屏退出后释放方向锁
function handleFullscreenChange() {
  if (document.fullscreenElement || !window.screen.orientation?.unlock) return
  try {
    window.screen.orientation.unlock()
  } catch {
    // 忽略不支持方向解锁的浏览器
  }
}

// 房主开始单机或联机游戏
export async function openGame(game, isRoom, roomId) {
  gotoPage("play")
  prepareGame(game, true, roomId || "")
  session.startOwner(roomId || "")
  session.onPeerJoined = (name) => {
    playState.peerName = name
    playState.peerReady = false
    playState.waiting = false
    hideOverlay()
    toast(`${name} 已加入`)
    updateStatus()
  }
  session.onPeerLeft = () => {
    playState.peerName = ""
    playState.peerReady = false
    playState.initialStateSent = false
    playState.initialStateReady = false
    playState.initialStateFrame = 0
    playState.initialStateSending = false
    playState.pendingFrame = null
    playState.waiting = true
    playState.guestFrames.clear()
    toast("对手已离开", true)
    updateStatus()
    if (playState.isOwner) showWaitingOverlay()
  }
  session.onPeerReady = null
  session.onRoomClosed = () => {
    toast("房间已解散", true)
    gotoHome()
  }
  session.onStatus = updateStatus
  session.onPeerMessage = handleOwnerMessage
  await loadAndStart(game, false)
  if (isRoom) showWaitingOverlay()
  updateStatus()
  window.dispatchEvent(new CustomEvent("nes-play-ready"))
}

// P2 加入并等待房主帧驱动
export async function openJoined(game, roomId, ownerName) {
  gotoPage("play")
  prepareGame(game, false, roomId)
  playState.peerName = ownerName || "房主"
  session.startGuest(roomId, ownerName)
  session.onStatus = updateStatus
  session.onPeerMessage = handleGuestMessage
  session.onPeerReady = null
  session.onRoomClosed = () => {
    toast("房主已离开，房间解散", true)
    gotoHome()
  }
  session.onPeerLeft = () => {
    toast("房主已离开", true)
    gotoHome()
  }
  await loadAndStart(game, true)
  session.sendReady()
  updateStatus()
  window.dispatchEvent(new CustomEvent("nes-play-ready"))
}

// 初始化一局游戏的通用状态
function prepareGame(game, isOwner, roomId) {
  playState.game = game
  playState.isOwner = isOwner
  playState.roomId = roomId
  playState.peerName = isOwner ? "" : playState.peerName
  playState.peerReady = false
  playState.initialStateSent = false
  playState.initialStateReady = false
  playState.initialStateFrame = 0
  playState.initialStateSending = false
  playState.pendingFrame = null
  playState.waiting = false
  playState.pendingState = null
  playState.stateEpoch++
  playState.lastLocalMask = null
  playState.lastGuestMask = 0
  playState.guestInputFrame = 0
  playState.guestStarted = isOwner
  playState.guestFrames.clear()
  playState.nextGuestFrame = 1
  updatePlayControls()
}

// 下载 ROM 并启动房主或 P2 模拟器
async function loadAndStart(game, externalClock) {
  input.releaseAll()
  if (!playState.runner) {
    playState.runner = new NesRunner($("#screen"))
    window.__runner = playState.runner
    playState.runner.onFps = (fps) => { $("#fps-tag").textContent = fps + " FPS" }
  }
  const runner = playState.runner
  $("#play-title").textContent = game.name
  const fpsTag = $("#fps-tag")
  fpsTag.hidden = externalClock
  if (externalClock) fpsTag.textContent = ""
  $("#btn-pause").textContent = "暂停"
  showOverlay("正在加载游戏…")
  try {
    const response = await fetch(assetPath("rom") + "?id=" + encodeURIComponent(game.id))
    if (!response.ok) throw new Error("加载失败 " + response.status)
    runner.load(await response.arrayBuffer())
    runner.start(externalClock)
    runner.onStep = externalClock ? null : (step) => broadcastCurrentFrame(step)
    if (window.__settings && window.__settings.volume > 0) {
      runner.enableAudio(window.__settings.volume).catch(() => {})
    }
    hideOverlay()
  } catch (error) {
    console.error(error)
    showOverlay("游戏加载失败：" + error.message)
  }
}

// 房主收到 P2 的最新输入，写入待广播帧而不立即改变本地模拟器
function handleOwnerMessage(message) {
  if (!message) return
  if (message.type === "keys") {
    playState.lastGuestMask = normalizeMask(message.mask, message.keys)
    playState.guestInputFrame = Number.isInteger(message.frame) ? message.frame : 0
    if (playState.isOwner && playState.runner) {
      playState.runner.setKeyState(input.keys, decodeKeys(playState.lastGuestMask))
    }
    return
  }
  if (message.type === "ready") {
    playState.peerReady = true
    if (!playState.initialStateSent) sendInitialState()
    return
  }
  if (message.type === "state_ack") {
    if (!Number.isInteger(message.frame) || message.frame === playState.initialStateFrame) {
      playState.initialStateReady = true
    }
    return
  }
  if (message.type === "state_request") sendInitialState()
}

// P2 接收房主的两帧进度包或初始状态
function handleGuestMessage(message) {
  if (!message) return
  if (typeof message === "string") {
    const compact = decodeCompactFrame(message, playState.nextGuestFrame)
    if (compact) handleGuestMessage(compact)
    return
  }
  if (message.type === "f2") {
    const frame = Number.isInteger(message.frame) ? message.frame : 0
    if (frame > 1) {
      const p1 = unpackPair(message.p1)
      const p2 = unpackPair(message.p2)
      enqueueGuestFrame(frame - 1, p1[0], p2[0], Number(message.turbo) & 1)
      enqueueGuestFrame(frame, p1[1], p2[1], (Number(message.turbo) >> 1) & 1)
      drainGuestFrames()
    }
    return
  }
  if (message.type === "f" || message.type === "frame") {
    const frame = Number.isInteger(message.frame) ? message.frame : 0
    if (frame > 0 && frame >= playState.nextGuestFrame) {
      playState.guestFrames.set(frame, message)
      drainGuestFrames()
      if (!playState.guestStarted) {
        while (playState.guestFrames.size > MAX_FRAME_BUFFER) {
          const first = playState.guestFrames.keys().next().value
          playState.guestFrames.delete(first)
        }
      }
    }
    return
  }
  if (message.type === "state") {
    queueInitialState(message)
  }
}

// P2 按房主帧号推进，遇到传输缺口时从最早可用帧恢复，避免永久黑屏
function drainGuestFrames() {
  const runner = playState.runner
  if (!runner || !runner.running) return
  if (!playState.guestFrames.has(playState.nextGuestFrame) && playState.guestStarted && playState.guestFrames.size > 0) {
    const first = playState.guestFrames.keys().next().value
    if (first > playState.nextGuestFrame) {
      playState.nextGuestFrame = first
      runner.setFrameCount(first - 1)
    }
  }
  while (playState.guestFrames.has(playState.nextGuestFrame)) {
    const message = playState.guestFrames.get(playState.nextGuestFrame)
    playState.guestFrames.delete(playState.nextGuestFrame)
    const ok = runner.advanceFrame(
      decodeKeys(message.p1 ?? message.p1Mask, message.p1Keys),
      decodeKeys(message.p2 ?? message.p2Mask, message.p2Keys),
      message.turbo ?? message.turboPhase,
    )
    if (!ok) return
    playState.nextGuestFrame++
  }
  for (const frame of playState.guestFrames.keys()) {
    if (frame > playState.nextGuestFrame + MAX_FRAME_BUFFER) {
      playState.guestFrames.delete(frame)
    }
  }
}

// 房主每完成两帧发送一个紧凑进度包
function broadcastCurrentFrame(step) {
  if (!playState.isOwner || !playState.peerReady || !playState.peerName || !playState.initialStateReady || playState.initialStateSending || !playState.runner) return
  if (!playState.pendingFrame) {
    playState.pendingFrame = step
    return
  }
  const previous = playState.pendingFrame
  playState.pendingFrame = null
  const p1 = packPair(encodeKeys(previous.p1), encodeKeys(step.p1))
  const p2 = packPair(encodeKeys(previous.p2), encodeKeys(step.p2))
  const turbo = (previous.turboPhase ? 1 : 0) | (step.turboPhase ? 2 : 0)
  session.sendToPeer(encodeCompactFrame(step.frame, p1, p2, turbo))
}

// P2 输入只在掩码变化时发给房主，房主下一帧开始使用
function handleLocalInput() {
  const mask = input.keyBits() | (encodeKeys(input.keys) & 0x300)
  if (playState.isOwner) {
    if (!playState.roomId) {
      playState.runner?.setKeyState(input.keys, [])
      return
    }
    playState.runner?.setKeyState(input.keys, decodeKeys(playState.lastGuestMask))
    return
  }
  if (mask === playState.lastLocalMask) return
  playState.lastLocalMask = mask
  session.sendKeys(mask, playState.nextGuestFrame - 1)
}

// 首次对齐只发送一次完整运行时状态
async function sendInitialState(force = false) {
  const runner = playState.runner
  if ((!force && playState.initialStateSent) || playState.initialStateSending || !playState.isOwner || !runner || !playState.peerReady || !playState.peerName) return
  playState.initialStateSending = true
  const wasPaused = runner.paused
  runner.setPaused(true)
  try {
    const frame = runner.frameCount
    const data = await runner.saveRuntimeState()
    playState.initialStateFrame = frame
    playState.initialStateReady = false
    playState.pendingFrame = null
    session.sendToPeer({
      type: "state",
      frame,
      data,
      p1: encodeKeys(runner._keys1),
      p2: playState.lastGuestMask,
      turbo: runner._turboPhase ? 1 : 0,
    })
    playState.initialStateSent = true
  } catch (error) {
    console.warn("导出对局状态失败", error)
  } finally {
    playState.initialStateSending = false
    runner.setPaused(wasPaused)
  }
}

// P2 排队解压初始状态，避免旧消息覆盖新一局
function queueInitialState(message) {
  const epoch = playState.stateEpoch
  playState.pendingState = { message, epoch }
  playState.stateChain = playState.stateChain.then(async () => {
    const pending = playState.pendingState
    playState.pendingState = null
    if (!pending || pending.epoch !== playState.stateEpoch) return
    const runner = playState.runner
    if (!runner || !runner.running) return
    runner.setPaused(true)
    try {
      if (!await runner.loadRuntimeState(pending.message.data)) return
      runner.setFrameCount(pending.message.frame)
      runner.setInputState(
        decodeKeys(pending.message.p1 ?? pending.message.p1Mask, pending.message.p1Keys),
        decodeKeys(pending.message.p2 ?? pending.message.p2Mask, pending.message.p2Keys),
        pending.message.turbo ?? pending.message.turboPhase,
      )
      playState.nextGuestFrame = runner.frameCount + 1
      for (const frame of playState.guestFrames.keys()) {
        if (frame < playState.nextGuestFrame) playState.guestFrames.delete(frame)
      }
      playState.guestStarted = true
      session.sendToOwner({ type: "state_ack", frame: pending.message.frame })
    } finally {
      runner.setPaused(false)
    }
    drainGuestFrames()
  }).catch(() => {})
}

// 把按键名称集合转换为紧凑掩码
function encodeKeys(keys) {
  let mask = 0
  for (const key of keys || []) mask |= KEY_MASK[key] || 0
  return mask
}

// 把两帧的十位按键掩码压进一个数字
function packPair(first, second) {
  return (first & 0x3ff) | ((second & 0x3ff) << 10)
}

// 解出两帧的十位按键掩码
function unpackPair(value) {
  const packed = Number.isInteger(value) ? value : 0
  return [packed & 0x3ff, (packed >> 10) & 0x3ff]
}

// 把 16 位环形帧号、两组输入和连发相位压成 8 字节短字符串
function encodeCompactFrame(frame, p1, p2, turbo) {
  let packed = BigInt(frame & 0xffff)
  packed |= BigInt(p1 & 0xfffff) << 16n
  packed |= BigInt(p2 & 0xfffff) << 36n
  packed |= BigInt(turbo & 3) << 56n
  const bytes = new Uint8Array(8)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number((packed >> BigInt(i * 8)) & 0xffn)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return "q" + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

// 解码短字符串帧包，返回旧格式对象以复用现有接收流程
function decodeCompactFrame(value, expectedFrame = 1) {
  if (!value.startsWith("q")) return null
  try {
    const encoded = value.slice(1).replaceAll("-", "+").replaceAll("_", "/")
    const binary = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4))
    let packed = 0n
    for (let i = 0; i < binary.length; i++) packed |= BigInt(binary.charCodeAt(i)) << BigInt(i * 8)
    if (binary.length === 8) {
      const lowFrame = Number(packed & 0xffffn)
      const expected = Number.isInteger(expectedFrame) && expectedFrame > 0 ? expectedFrame : lowFrame
      let frame = (expected & ~0xffff) | lowFrame
      while (frame - expected > 0x8000) frame -= 0x10000
      while (expected - frame > 0x8000) frame += 0x10000
      return {
        type: "f2",
        frame,
        p1: Number((packed >> 16n) & 0xfffffn),
        p2: Number((packed >> 36n) & 0xfffffn),
        turbo: Number((packed >> 56n) & 3n),
      }
    }
    // 兼容此前使用 32 位帧号的 10 字节紧凑包
    if (binary.length !== 10) return null
    return {
      type: "f2",
      frame: Number(packed & 0xffffffffn),
      p1: Number((packed >> 32n) & 0xfffffn),
      p2: Number((packed >> 52n) & 0xfffffn),
      turbo: Number((packed >> 72n) & 3n),
    }
  } catch {
    return null
  }
}

// 把收到的帧写入队列，兼容旧版单帧字段
function enqueueGuestFrame(frame, p1, p2, turbo) {
  if (frame <= 0 || frame < playState.nextGuestFrame) return
  playState.guestFrames.set(frame, { p1, p2, turbo })
  if (!playState.guestStarted) {
    while (playState.guestFrames.size > MAX_FRAME_BUFFER) {
      const first = playState.guestFrames.keys().next().value
      playState.guestFrames.delete(first)
    }
  }
}

// 兼容新旧消息中的掩码和按键数组
function normalizeMask(mask, keys) {
  return Number.isInteger(mask) ? mask : encodeKeys(keys)
}

// 把掩码还原成按键名称集合
function decodeKeys(mask, keys) {
  const value = normalizeMask(mask, keys)
  return Object.entries(KEY_MASK).filter(([, bit]) => (value & bit) !== 0).map(([key]) => key)
}

// 更新状态标签
function updateStatus() {
  updatePlayControls()
  const seat = $("#seat-tag")
  const modeTag = $("#net-tag")
  seat.textContent = playState.isOwner ? "1P · 房主" : "2P · " + (playState.peerName || "")
  seat.className = "tag ok"
  const mode = playState.isOwner
    ? (playState.peerName ? (session.mode === "p2p" ? "p2p" : "relay") : "local")
    : session.mode
  modeTag.textContent = MODE_TEXT[mode] || mode
  modeTag.className = "tag" + (mode === "p2p" ? " ok" : mode === "relay" ? " warn" : "")
}

// 联机时隐藏单机专用控制按钮
function updatePlayControls() {
  const online = Boolean(playState.roomId)
  $("#btn-reset")?.classList.toggle("hidden", online)
  $("#btn-pause")?.classList.toggle("hidden", online)
}

// 房主等待 P2 加入时显示提示，加入后交给帧同步驱动
function showWaitingOverlay() {
  const overlay = $("#play-overlay")
  overlay.classList.remove("hidden")
  overlay.innerHTML = ""
  const title = document.createElement("h3")
  title.textContent = "等待对手加入…"
  const tip = document.createElement("p")
  tip.textContent = "把大厅中的对局分享给对手，对方点击“加入”即可开始联机对战。"
  overlay.append(title, tip)
}

// 更新音量设置
export function applyVolume(volume) {
  playState.runner?.setVolume(volume)
}

// 更新键位设置
export function applyKeys(keys) {
  input.setKeymap(keys)
  if (window.__settings) window.__settings.keys = keys
}

// 显示纯文本遮罩
function showOverlay(text) {
  const overlay = $("#play-overlay")
  overlay.classList.remove("hidden")
  overlay.innerHTML = ""
  const tip = document.createElement("p")
  tip.textContent = text
  overlay.appendChild(tip)
}

// 隐藏遮罩
function hideOverlay() {
  const overlay = $("#play-overlay")
  overlay.classList.add("hidden")
  overlay.innerHTML = ""
}

// 存档槽位数量，可按需调整
const SAVE_SLOTS = 5
// 存档在 localStorage 中的前缀，按游戏 ID 分开存放
const SAVE_PREFIX = "nesbattle.save."

// openSaveModal 弹出存档管理窗口：列出多个槽位，可保存或读取
function openSaveModal() {
  const runner = playState.runner
  if (!runner) return
  const gameId = playState.game?.id || ""
  // 联机 P2 的模拟器由房主帧驱动，本地读档会被房主状态覆盖，只允许房主读档后同步
  const isOnlineGuest = !playState.isOwner && !!playState.roomId
  const panel = el("div", { class: "save-panel" })
  const title = el("h3", {}, "存档管理")
  const hint = el("p", { class: "hint" }, "当前游戏：" + (playState.game?.name || ""))
  const list = el("div", { class: "save-list" })
  panel.append(title, hint, list)

  // 逐个槽位渲染保存/读取行
  for (let i = 0; i < SAVE_SLOTS; i++) {
    const slot = i + 1
    const item = el("div", { class: "save-item" })
    const name = el("div", { class: "save-name" }, "槽位 " + slot)
    const info = el("div", { class: "save-info" })
    const row = el("div", { class: "save-row" })
    row.append(name, info)
    const actions = el("div", { class: "save-actions" })
    const saveBtn = el("button", { class: "btn ghost", type: "button" }, "保存")
    const loadBtn = el("button", { class: "btn ghost", type: "button" }, "读取")
    actions.append(saveBtn, loadBtn)
    item.append(row, actions)
    list.appendChild(item)

    loadBtn.addEventListener("click", async () => {
      // 联机 P2 不本地读档，等待房主读档后通过 state 消息自动同步
      if (isOnlineGuest) {
        toast("等待房主读取存档后自动同步", true)
        return
      }
      const record = readSlot(gameId, slot)
      if (!record) {
        toast("该槽位没有存档", true)
        return
      }
      try {
        runner.setPaused(true)
        await runner.loadStatePacked(record.data)
        // 存档不含帧号，显式恢复逻辑帧号用于联机对齐
        if (Number.isInteger(record.frame)) runner.setFrameCount(record.frame)
        // 房主联机读档后重新把状态推给 P2，P2 载入后回 state_ack
        if (playState.isOwner && playState.roomId) {
          playState.initialStateSent = false
          sendInitialState(true)
        }
        toast("已读取存档（槽位 " + slot + "）")
      } catch (error) {
        console.warn("读取存档失败", error)
        toast("读取存档失败", true)
      } finally {
        runner.setPaused(false)
      }
    })
    saveBtn.addEventListener("click", async () => {
      try {
        const data = await runner.saveStatePacked()
        // 额外保存逻辑帧号，房主读档后用于把 P2 对齐到同一进度
        writeSlot(gameId, slot, { data, frame: runner.frameCount, at: Date.now() })
        renderSlotInfo(info, slot, gameId)
        toast("已保存到槽位 " + slot)
      } catch (error) {
        console.warn("保存存档失败", error)
        toast("保存存档失败", true)
      }
    })
    renderSlotInfo(info, slot, gameId)
  }

  const actionsBar = el("div", { class: "actions" })
  const closeBtn = el("button", { class: "btn primary", type: "button" }, "关闭")
  closeBtn.addEventListener("click", () => closeModal())
  actionsBar.appendChild(closeBtn)
  panel.appendChild(actionsBar)
  showModal(panel)
}

// renderSlotInfo 在槽位行显示已有存档的保存时间
function renderSlotInfo(node, slot, gameId) {
  const record = readSlot(gameId, slot)
  if (record && record.at) {
    node.textContent = "已保存于 " + new Date(record.at).toLocaleString()
  } else {
    node.textContent = "空槽位"
  }
}

// readSlot 读取某个游戏的指定槽位存档
function readSlot(gameId, slot) {
  try {
    const raw = localStorage.getItem(SAVE_PREFIX + gameId)
    if (!raw) return null
    const all = JSON.parse(raw)
    return all[slot] || null
  } catch {
    return null
  }
}

// writeSlot 写入某个游戏的指定槽位存档，保留其它槽位
function writeSlot(gameId, slot, record) {
  let all = {}
  try {
    const raw = localStorage.getItem(SAVE_PREFIX + gameId)
    if (raw) all = JSON.parse(raw) || {}
  } catch {
    all = {}
  }
  all[slot] = record
  localStorage.setItem(SAVE_PREFIX + gameId, JSON.stringify(all))
}

// 离开游玩页面并释放资源
function leavePlay() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  handleFullscreenChange()
  input.enabled = false
  playState.clearTouchPad?.()
  input.releaseAll()
  playState.runner?.stop()
  playState.runner = null
  if (session.roomId) session.leave()
  playState.roomId = ""
  playState.peerName = ""
  playState.peerReady = false
  playState.guestStarted = false
  playState.initialStateSent = false
  playState.initialStateReady = false
  playState.initialStateFrame = 0
  playState.initialStateSending = false
  playState.pendingFrame = null
  playState.guestFrames.clear()
  updatePlayControls()
}
