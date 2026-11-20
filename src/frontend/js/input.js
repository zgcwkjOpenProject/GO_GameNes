// 输入层：键盘与触屏统一映射为 NES 按键集合，P1/P2 使用同一套键位
import { $$ } from "./common.js"

// KEY_BIT 是 NES 手柄按键的位掩码，与 jsnes 的常量保持一致
export const KEY_BIT = {
  a: 0x01, b: 0x02, select: 0x04, start: 0x08,
  up: 0x10, down: 0x20, left: 0x40, right: 0x80,
}

// ALT_KEYS 是默认键位之外永远可用的「习惯键位」
// 方向键/WASD 都能移动，Z/X、U/I、空格都能射击，避免用户按了没反应
// 用户自行改键时以自定义映射优先（同键码不会被覆盖）
export const ALT_KEYS = {
  KeyW: "up", KeyA: "left", KeyS: "down", KeyD: "right",
  KeyZ: "b", KeyX: "a",
  KeyU: "b", KeyI: "a",
  Space: "a",
}

// 把物理输入（键盘和触屏）转成按键名集合，并支持状态监听
export class Input {
  constructor() {
    this.keys = new Set()       // 当前按下的按键名
    this.keyboardKeys = new Set()
    this.touchKeys = new Set()
    this.gamepadKeys = new Set()
    this.listeners = []         // 按键变化监听器
    this.keymap = {}            // 键盘键码 -> 按键名
    this.gamepadMap = {}        // 手柄输入标识 -> 按键名
    this.gamepadState = new Set()
    this._gamepadFrame = 0
    this._pollGamepads = this._pollGamepads.bind(this)
    this.enabled = true
    this._onKeyDown = this._onKeyDown.bind(this)
    this._onKeyUp = this._onKeyUp.bind(this)
    this._onBlur = () => this.releaseAll()
    this.attached = false
  }

  // 开始监听键盘事件
  attach(keymap) {
    this.setKeymap(keymap)
    if (this.attached) return
    this.attached = true
    window.addEventListener("keydown", this._onKeyDown)
    window.addEventListener("keyup", this._onKeyUp)
    window.addEventListener("blur", this._onBlur)
    this._gamepadFrame = requestAnimationFrame(this._pollGamepads)
  }

  // 停止监听键盘事件
  detach() {
    if (!this.attached) return
    this.attached = false
    window.removeEventListener("keydown", this._onKeyDown)
    window.removeEventListener("keyup", this._onKeyUp)
    window.removeEventListener("blur", this._onBlur)
    cancelAnimationFrame(this._gamepadFrame)
    this._gamepadFrame = 0
    this.releaseAll()
  }

  // 更新键位映射，键盘码与手柄标识都使用同一份设置
  setKeymap(keymap) {
    const map = {}
    const gamepadMap = {}
    for (const [btn, code] of Object.entries(keymap || {})) {
      if (!code) continue
      if (code.startsWith("Gamepad")) gamepadMap[code] = btn
      else map[code] = btn
    }
    // 补充习惯键位：只在用户没占用该键码时生效
    for (const [code, btn] of Object.entries(ALT_KEYS)) {
      if (!map[code]) map[code] = btn
    }
    this.keymap = map
    this.gamepadMap = gamepadMap
  }

  // 处理键盘按下事件，映射为按键名并去重
  _onKeyDown(e) {
    if (!this.enabled) return
    // 避免输入框打字触发游戏按键
    const tag = document.activeElement && document.activeElement.tagName
    if (tag === "INPUT" || tag === "TEXTAREA") return
    const btn = this.keymap[e.code]
    if (!btn) return
    e.preventDefault()
    if (!this.keyboardKeys.has(btn)) {
      this.keyboardKeys.add(btn)
      this.keys = mergeSets(this.keyboardKeys, this.touchKeys, this.gamepadKeys)
      this._changed()
    }
  }

  // 处理键盘抬起事件
  _onKeyUp(e) {
    const btn = this.keymap[e.code]
    if (!btn) return
    e.preventDefault()
    if (this.keyboardKeys.delete(btn)) {
      this.keys = mergeSets(this.keyboardKeys, this.touchKeys, this.gamepadKeys)
      this._changed()
    }
  }

  // 每帧读取标准 Gamepad API，把按下的手柄输入转换为 NES 按键
  _pollGamepads() {
    const active = new Set()
    if (this.enabled && navigator.getGamepads) {
      for (const pad of navigator.getGamepads() || []) {
        if (!pad) continue
        for (let i = 0; i < pad.buttons.length; i++) {
          if (pad.buttons[i].pressed) active.add(`GamepadButton${i}`)
        }
        for (let i = 0; i < pad.axes.length; i++) {
          if (pad.axes[i] <= -0.5) active.add(`GamepadAxis${i}-`)
          if (pad.axes[i] >= 0.5) active.add(`GamepadAxis${i}+`)
        }
      }
    }
    const next = new Set()
    for (const code of active) {
      const btn = this.gamepadMap[code]
      if (btn) next.add(btn)
    }
    if (!sameSet(next, this.gamepadKeys)) {
      this.gamepadKeys = next
      this.keys = mergeSets(this.keyboardKeys, this.touchKeys, this.gamepadKeys)
      this._changed()
    }
    this.gamepadState = active
    this._gamepadFrame = requestAnimationFrame(this._pollGamepads)
  }

  // 提供给触屏按钮调用
  press(btn) {
    if (!this.touchKeys.has(btn)) {
      this.touchKeys.add(btn)
      this.keys = mergeSets(this.keyboardKeys, this.touchKeys, this.gamepadKeys)
      this._changed()
    }
  }

  release(btn) {
    if (this.touchKeys.delete(btn)) {
      this.keys = mergeSets(this.keyboardKeys, this.touchKeys, this.gamepadKeys)
      this._changed()
    }
  }

  // 释放全部按键，避免窗口失焦时出现卡键
  releaseAll() {
    if (this.keys.size) {
      this.keyboardKeys.clear()
      this.touchKeys.clear()
      this.gamepadKeys.clear()
      this.keys.clear()
      this._changed()
    }
  }

  // 把按键名集合转成 NES 手柄位掩码
  keyBits() {
    let bits = 0
    for (const k of this.keys) bits |= KEY_BIT[k] || 0
    return bits
  }

  // 返回按键名数组，用于联机传输
  keyNames() {
    return Array.from(this.keys)
  }

  // 用远端按键名集合整体替换本地状态
  setKeys(names) {
    this.keys = new Set(names || [])
    this.keyboardKeys = new Set(this.keys)
    this.touchKeys.clear()
    this.gamepadKeys.clear()
    this._changed()
  }

  // 注册按键变化回调
  onChanged(fn) {
    this.listeners.push(fn)
  }

  // 通知监听者按键状态发生变化
  _changed() {
    for (const fn of this.listeners) fn(this.keys)
  }
}

function sameSet(a, b) {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

function mergeSets(...sets) {
  return new Set(sets.flatMap((set) => [...set]))
}

// 把触屏虚拟手柄按钮接入输入对象，并返回清理当前触摸状态的方法
export function bindTouchPad(input) {
  const pad = document.querySelector("#touch-pad")
  if (!pad) return () => {}

  // 一个指针对应一组当前按键，允许单指斜向和多指组合操作
  // 使用计数避免多个手指同时按住同一个按钮时提前释放
  const pointers = new Map()
  const keyCounts = new Map()
  const buttons = new Map($$("#touch-pad .tp").map((btn) => [btn.dataset.key, btn]))
  const directions = new Set(["up", "down", "left", "right"])

  const press = (key) => {
    const count = keyCounts.get(key) || 0
    keyCounts.set(key, count + 1)
    if (count === 0) {
      buttons.get(key)?.classList.add("pressed")
      input.press(key)
    }
  }

  const release = (key) => {
    const count = keyCounts.get(key) || 0
    if (count <= 1) {
      keyCounts.delete(key)
      buttons.get(key)?.classList.remove("pressed")
      input.release(key)
    } else {
      keyCounts.set(key, count - 1)
    }
  }

  const buttonAt = (e, preferredTarget = null) => {
    const button = preferredTarget?.closest?.("#touch-pad .tp")
      || document.elementFromPoint(e.clientX, e.clientY)?.closest?.("#touch-pad .tp")
    return button && pad.contains(button) ? button.dataset.key : null
  }

  // 根据方向区内的触点位置返回一个或两个方向键
  const directionKeysAt = (e, preferredTarget = null) => {
    const target = preferredTarget?.closest?.(".pad-left")
      || document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".pad-left")
    if (!target || !pad.contains(target)) return []
    const rect = target.getBoundingClientRect()
    const dx = e.clientX - (rect.left + rect.width / 2)
    const dy = e.clientY - (rect.top + rect.height / 2)
    const deadX = rect.width * 0.08
    const deadY = rect.height * 0.08
    const keys = []
    if (Math.abs(dx) > deadX) keys.push(dx < 0 ? "left" : "right")
    if (Math.abs(dy) > deadY) keys.push(dy < 0 ? "up" : "down")
    return keys
  }

  // 返回触点当前覆盖的全部虚拟按键
  const keysAt = (e, preferredTarget = null) => {
    const directionKeys = directionKeysAt(e, preferredTarget)
    if (directionKeys.length) return directionKeys
    const key = buttonAt(e, preferredTarget)
    return key && !directions.has(key) ? [key] : []
  }

  const updatePointer = (e, preferredTarget = null) => {
    const next = new Set(keysAt(e, preferredTarget))
    const previous = pointers.get(e.pointerId) || new Set()
    for (const key of previous) {
      if (!next.has(key)) release(key)
    }
    for (const key of next) {
      if (!previous.has(key)) press(key)
    }
    if (next.size) {
      pointers.set(e.pointerId, next)
    } else {
      pointers.delete(e.pointerId)
    }
  }

  const endPointer = (e) => {
    const keys = pointers.get(e.pointerId)
    if (!keys) return
    pointers.delete(e.pointerId)
    for (const key of keys) release(key)
  }

  pad.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return
    e.preventDefault()
    try { pad.setPointerCapture?.(e.pointerId) } catch {}
    updatePointer(e, e.target)
  })
  // 某些移动浏览器在按钮默认点击流程中延迟合成事件，直接阻止默认行为
  for (const button of buttons.values()) {
    button.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return
      e.preventDefault()
      try { pad.setPointerCapture?.(e.pointerId) } catch {}
      updatePointer(e, button)
    })
  }
  pad.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return
    e.preventDefault()
    updatePointer(e)
  })
  pad.addEventListener("pointerup", endPointer)
  pad.addEventListener("pointercancel", endPointer)
  pad.addEventListener("lostpointercapture", endPointer)

  const clearPointers = () => {
    for (const key of keyCounts.keys()) {
      buttons.get(key)?.classList.remove("pressed")
      input.release(key)
    }
    keyCounts.clear()
    pointers.clear()
  }
  window.addEventListener("blur", clearPointers)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearPointers()
  })
  return clearPointers
}
