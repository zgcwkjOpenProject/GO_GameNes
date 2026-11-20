// 模拟器层：驱动 jsnes、渲染画面并提供房主帧驱动接口
import { toast, assetPath } from "./common.js"

// KEY_INDEX 是按键名到 jsnes Controller 索引的映射
const KEY_INDEX = {
  a: 0, b: 1, select: 2, start: 3,
  up: 4, down: 5, left: 6, right: 7,
}

// NTSC 制式的真实帧率
const TARGET_FPS = 60.0988
const FRAME_MS = 1000 / TARGET_FPS
const MAX_CATCHUP = 4
const RUNTIME_STATE_GZ = "rsgz:"
const RUNTIME_STATE_RAW = "rsraw:"

// 把输入统一成 Set
function toKeySet(keys) {
  if (!keys) return new Set()
  return keys instanceof Set ? keys : new Set(keys)
}

// 把连发键转换为当前帧实际使用的普通键
function effectiveKeys(keys, turboPhase) {
  const result = new Set()
  for (const key of toKeySet(keys)) {
    if (key === "aa") {
      if (turboPhase) result.add("a")
    } else if (key === "bb") {
      if (turboPhase) result.add("b")
    } else if (KEY_INDEX[key] !== undefined) {
      result.add(key)
    }
  }
  return result
}

// 把字节数组编码为 base64
function u8ToBase64(u8) {
  let result = ""
  const chunk = 0x8000
  for (let i = 0; i < u8.length; i += chunk) {
    result += String.fromCharCode.apply(null, u8.subarray(i, i + chunk))
  }
  return btoa(result)
}

// 把 base64 解码为字节数组
function base64ToU8(value) {
  const binary = atob(value)
  const result = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i)
  return result
}

// 压缩文本，浏览器不支持时由调用方降级
async function gzipText(text) {
  if (typeof CompressionStream === "undefined") return null
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

// 解压运行时存档文本
async function gunzipText(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
  return await new Response(stream).text()
}

// 从存档中删除双方已经通过本地 ROM 加载的固定数据
function createRuntimeState(state) {
  const runtime = typeof structuredClone === "function"
    ? structuredClone(state)
    : JSON.parse(JSON.stringify(state))
  delete runtime.romData
  return runtime
}

// 封装 jsnes 实例、画布和音频输出
export class NesRunner {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext("2d", { alpha: false })
    this.image = this.ctx.createImageData(256, 240)
    this.buf = new ArrayBuffer(this.image.data.length)
    this.buf8 = new Uint8ClampedArray(this.buf)
    this.buf32 = new Uint32Array(this.buf)
    for (let i = 0; i < this.buf32.length; i++) this.buf32[i] = 0xff000000

    this.audioCtx = null
    this.scriptNode = null
    this.gainNode = null
    this.audioReady = false
    this.audioEnabled = true
    this.muted = true
    this.samples = []
    this.volume = 60
    this._initAudioContext()
    this.nes = new jsnes.NES({
      onFrame: (framebuffer) => this._onFrame(framebuffer),
      onAudioSample: (left, right) => this._onAudio(left, right),
      sampleRate: this.audioCtx ? this.audioCtx.sampleRate : 44100,
      preferredFrameRate: TARGET_FPS,
    })

    this.running = false
    this.paused = false
    this.externalClock = false
    this.frameCount = 0
    this.frames = 0
    this.fps = 0
    this._fpsTimer = performance.now()
    this._workerTimer = null
    this._lastTick = performance.now()
    this._acc = 0
    this.onFps = null
    this.onStep = null
    this._romString = null
    this._prev1 = new Set()
    this._prev2 = new Set()
    this._keys1 = new Set()
    this._keys2 = new Set()
    this._turboPhase = false
  }

  // 创建音频上下文，实际播放仍需用户手势解锁
  _initAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) return
    try {
      this.audioCtx = new AudioContextClass()
    } catch {
      this.audioCtx = null
    }
  }

  // 加载 ROM 并复位运行状态
  load(romData) {
    let data = romData
    if (romData instanceof ArrayBuffer) data = new Uint8Array(romData)
    if (ArrayBuffer.isView(romData) || romData instanceof ArrayBuffer) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(romData)
      let binary = ""
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      data = binary
    }
    this._romString = data
    this.nes.loadROM(data)
    this._releaseAll()
    this.frameCount = 0
    this.running = true
    this.paused = false
  }

  // 重新载入 ROM，保证映射器回到干净状态
  reset() {
    this._releaseAll()
    if (this._romString) this.nes.loadROM(this._romString)
    else this.nes.reset()
    this.frameCount = 0
  }

  // 释放两个手柄的当前状态
  _releaseAll() {
    for (const key of this._prev1) this.setButton(1, key, false)
    for (const key of this._prev2) this.setButton(2, key, false)
    this._prev1 = new Set()
    this._prev2 = new Set()
    this._keys1 = new Set()
    this._keys2 = new Set()
    this._turboPhase = false
  }

  // 设置 jsnes 中的单个按键
  setButton(player, button, pressed) {
    const index = KEY_INDEX[button]
    if (index === undefined) return
    if (pressed) this.nes.buttonDown(player, index)
    else this.nes.buttonUp(player, index)
  }

  // 设置两个手柄的原始输入状态
  setKeyState(p1Keys, p2Keys) {
    this._keys1 = toKeySet(p1Keys)
    this._keys2 = toKeySet(p2Keys)
    this._setKeyStateNow()
  }

  // 设置输入状态以及连发相位，用于恢复或重放房主帧
  setInputState(p1Keys, p2Keys, turboPhase = this._turboPhase) {
    this._turboPhase = Boolean(turboPhase)
    this.setKeyState(p1Keys, p2Keys)
  }

  // 返回下一模拟帧所需的最小输入数据
  getInputState() {
    return {
      p1: Array.from(this._keys1),
      p2: Array.from(this._keys2),
      turboPhase: this._turboPhase,
    }
  }

  // 立即将原始输入转换并写入 jsnes
  _setKeyStateNow() {
    const next1 = effectiveKeys(this._keys1, this._turboPhase)
    const next2 = effectiveKeys(this._keys2, this._turboPhase)
    this._applyKeys(1, this._prev1, next1)
    this._applyKeys(2, this._prev2, next2)
    this._prev1 = next1
    this._prev2 = next2
  }

  // 切换连发状态并更新 jsnes 手柄
  _applyTurbo() {
    this._turboPhase = !this._turboPhase
    this._setKeyStateNow()
  }

  // 只把发生变化的按键写入 jsnes
  _applyKeys(player, previous, next) {
    for (const key of previous) {
      if (!next.has(key)) this.setButton(player, key, false)
    }
    for (const key of next) {
      if (!previous.has(key)) this.setButton(player, key, true)
    }
  }

  // 启动模拟器，externalClock 模式由房主网络帧逐帧驱动
  start(externalClock = false) {
    if (this._workerTimer || this.externalClock) return
    this.externalClock = externalClock
    this.running = true
    this._lastTick = performance.now()
    this._acc = 0
    this.frames = 0
    this._fpsTimer = this._lastTick
    if (externalClock) return
    const beat = Math.max(8, Math.round(FRAME_MS / 4))
    const workerCode = `let timer=null;onmessage=e=>{if(e.data==='start'&&!timer){timer=setInterval(()=>postMessage(0),${beat})}else if(e.data==='stop'){clearInterval(timer);timer=null}}`
    this._workerTimer = new Worker(URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" })))
    this._workerTimer.onmessage = () => this._tick()
    this._workerTimer.postMessage("start")
  }

  // 本地时钟模式按真实时间推进模拟
  _tick() {
    const now = performance.now()
    if (!this.running || this.paused || this.externalClock) {
      this._lastTick = now
      return
    }
    const elapsed = now - this._lastTick
    this._lastTick = now
    this._acc += elapsed
    if (this._acc > 250) this._acc = FRAME_MS
    const budget = Math.min(MAX_CATCHUP, Math.floor(this._acc / FRAME_MS))
    if (budget <= 0) return
    this._acc -= budget * FRAME_MS
    for (let i = 0; i < budget; i++) {
      if (!this._stepFrame()) return
    }
    if (now - this._fpsTimer >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this._fpsTimer))
      this.frames = 0
      this._fpsTimer = now
      this.onFps?.(this.fps)
    }
  }

  // 外部时钟推进一帧，要求调用方传入该帧的完整输入
  advanceFrame(p1Keys, p2Keys, turboPhase) {
    if (!this.externalClock || !this.running || this.paused) return false
    this.setInputState(p1Keys, p2Keys, turboPhase)
    return this._stepFrame()
  }

  // 执行一帧并在完成后通知房主或界面
  _stepFrame() {
    const frame = this.frameCount + 1
    const input = this.getInputState()
    try {
      this._applyTurbo()
      this.nes.frame()
    } catch (err) {
      console.error("模拟器异常", err)
      this.stop()
      toast("模拟器运行出错，已停止", true)
      return false
    }
    this.frames++
    this.frameCount = frame
    this.onStep?.({ frame, p1: input.p1, p2: input.p2, turboPhase: input.turboPhase })
    return true
  }

  // 停止模拟器并关闭音频
  stop() {
    this.running = false
    if (this._workerTimer) {
      this._workerTimer.postMessage("stop")
      this._workerTimer.terminate()
      this._workerTimer = null
    }
    this.externalClock = false
    this.disableAudio()
  }

  // 暂停或继续模拟器
  setPaused(value) {
    this.paused = value
  }

  // 设置存档对应的逻辑帧号
  setFrameCount(frame) {
    if (!Number.isFinite(frame)) return
    this.frameCount = Math.max(0, Math.floor(frame))
  }

  // 将 jsnes 画面写入画布
  _onFrame(framebuffer) {
    for (let i = 0; i < framebuffer.length; i++) this.buf32[i] = 0xff000000 | framebuffer[i]
    this.image.data.set(this.buf8)
    this.ctx.putImageData(this.image, 0, 0)
  }

  // 收集音频样本并批量送入音频节点
  _onAudio(left, right) {
    if (!this.audioEnabled || this.muted || !this.audioReady || !this.scriptNode) return
    this.samples.push(left, right)
    if (this.samples.length < 2048) return
    try {
      this.scriptNode.port.postMessage({ samples: this.samples })
    } catch {
      // 音频节点关闭时忽略剩余样本
    }
    this.samples = []
  }

  // 建立音频节点图
  async _ensureAudioGraph() {
    if (!this.audioCtx || this.audioCtx.state === "closed") {
      this.audioReady = false
      this.scriptNode = null
      this.gainNode = null
      this._initAudioContext()
    }
    if (!this.audioCtx) return false
    try {
      if (this.audioCtx.state === "suspended") await this.audioCtx.resume()
      if (this.audioReady && this.scriptNode && this.gainNode) return true
      await this.audioCtx.audioWorklet.addModule(assetPath("js/audio-worklet.js"))
      const node = new AudioWorkletNode(this.audioCtx, "nes-audio", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      const gain = this.audioCtx.createGain()
      gain.gain.value = this.volume / 100
      node.connect(gain).connect(this.audioCtx.destination)
      this.scriptNode = node
      this.gainNode = gain
      this.audioReady = true
      return true
    } catch (err) {
      console.warn("音频初始化失败", err)
      return false
    }
  }

  // 在用户手势后启用音频
  async enableAudio(volume) {
    if (typeof volume === "number") this.volume = volume
    this.samples = []
    if (!await this._ensureAudioGraph()) return
    this.audioEnabled = true
    this.muted = false
  }

  // 关闭音频输出
  disableAudio() {
    this.audioEnabled = false
    this.muted = true
    this.samples = []
    if (!this.audioCtx) return
    try {
      this.audioCtx.close()
    } catch {
      // 忽略关闭异常
    }
    this.audioCtx = null
    this.scriptNode = null
    this.gainNode = null
    this.audioReady = false
  }

  // 调整音量
  setVolume(volume) {
    this.volume = volume
    if (this.gainNode) this.gainNode.gain.value = volume / 100
  }

  // 设置静音
  setMuted(value) {
    this.muted = value
  }

  // 导出不包含 ROM 的完整运行时存档，仅用于初始对齐或人工请求
  async saveRuntimeState() {
    const json = JSON.stringify(createRuntimeState(this.nes.toJSON()))
    const bytes = await gzipText(json)
    return bytes ? RUNTIME_STATE_GZ + u8ToBase64(bytes) : RUNTIME_STATE_RAW + json
  }

  // 恢复完整运行时存档
  async loadRuntimeState(text) {
    if (typeof text !== "string") return false
    let json
    if (text.startsWith(RUNTIME_STATE_GZ)) {
      json = await gunzipText(base64ToU8(text.slice(RUNTIME_STATE_GZ.length)))
    } else if (text.startsWith(RUNTIME_STATE_RAW)) {
      json = text.slice(RUNTIME_STATE_RAW.length)
    } else {
      return false
    }
    this.samples = []
    const runtime = JSON.parse(json)
    const current = this.nes.toJSON()
    runtime.romData = current.romData
    this.nes.fromJSON({ ...current, ...runtime })
    return true
  }

  // 导出可本地保存的压缩存档串，用于多存档位管理
  async saveStatePacked() {
    const json = JSON.stringify(createRuntimeState(this.nes.toJSON()))
    const bytes = await gzipText(json)
    return bytes ? RUNTIME_STATE_GZ + u8ToBase64(bytes) : RUNTIME_STATE_RAW + json
  }

  // 从本地保存的压缩存档串恢复，不依赖网络对局状态
  async loadStatePacked(text) {
    if (typeof text !== "string") return false
    let json
    if (text.startsWith(RUNTIME_STATE_GZ)) {
      json = await gunzipText(base64ToU8(text.slice(RUNTIME_STATE_GZ.length)))
    } else if (text.startsWith(RUNTIME_STATE_RAW)) {
      json = text.slice(RUNTIME_STATE_RAW.length)
    } else {
      return false
    }
    this.samples = []
    const runtime = JSON.parse(json)
    const current = this.nes.toJSON()
    runtime.romData = current.romData
    this.nes.fromJSON({ ...current, ...runtime })
    return true
  }
}
