// 设置界面：昵称、按键布局、音量、画面与手柄显示
import { $, el, keyName, defaultKeys, toast } from "./common.js"

// NES 按键的展示顺序与说明
const KEY_ITEMS = [
  ["up", "上"], ["down", "下"], ["left", "左"], ["right", "右"],
  ["a", "A 键"], ["b", "B 键"], ["aa", "AA 连发"], ["bb", "BB 连发"],
  ["start", "START"], ["select", "SELECT"],
]

// 渲染设置界面并绑定事件
export function initSettings(settings, saveSettings) {
  $("#set-name").value = settings.name || ""
  $("#set-volume").value = settings.volume
  $("#vol-label").textContent = settings.volume + "%"
  $("#set-crt").checked = settings.crt
  $("#set-touch").checked = settings.touch

  $("#set-volume").addEventListener("input", (e) => {
    $("#vol-label").textContent = e.target.value + "%"
  })

  renderKeymap(settings)
  $("#btn-save-settings").addEventListener("click", () => {
    settings.name = $("#set-name").value.trim()
    settings.volume = Number($("#set-volume").value)
    settings.crt = $("#set-crt").checked
    settings.touch = $("#set-touch").checked
    saveSettings(settings)
    applyLive(settings)
    toast("设置已保存")
  })
}

// 渲染改键布局
function renderKeymap(settings) {
  const box = $("#keymap")
  box.innerHTML = ""
  for (const [btn, label] of KEY_ITEMS) {
    const item = el("div", { class: "key-item" })
    item.appendChild(el("span", { class: "k-name" }, label))
    const code = el("span", { class: "k-code" }, keyName(settings.keys[btn]))
    code.addEventListener("click", () => listenKey(code, btn, settings))
    item.appendChild(code)
    box.appendChild(item)
  }
}

// 等待用户按下新按键完成改键
function listenKey(node, btn, settings) {
  if (node.classList.contains("listening")) return
  node.classList.add("listening")
  node.textContent = "按键…"
  const handler = (e) => {
    e.preventDefault()
    e.stopPropagation()
    window.removeEventListener("keydown", handler, true)
    if (e.code === "Escape") {
      node.classList.remove("listening")
      node.textContent = keyName(settings.keys[btn])
      return
    }
    settings.keys[btn] = e.code
    node.classList.remove("listening")
    node.textContent = keyName(e.code)
  }
  window.addEventListener("keydown", handler, true)
  const poll = () => {
    if (!node.classList.contains("listening")) return
    const found = findGamepadInput()
    if (found) {
      settings.keys[btn] = found
      node.classList.remove("listening")
      node.textContent = keyName(found)
      return
    }
    requestAnimationFrame(poll)
  }
  requestAnimationFrame(poll)
}

// 返回当前新按下的手柄按钮或摇杆方向
let previousGamepadInputs = new Set()
function findGamepadInput() {
  if (!navigator.getGamepads) return null
  const current = new Set()
  for (const pad of navigator.getGamepads() || []) {
    if (!pad) continue
    for (let i = 0; i < pad.buttons.length; i++) {
      if (pad.buttons[i].pressed) current.add(`GamepadButton${i}`)
    }
    for (let i = 0; i < pad.axes.length; i++) {
      if (pad.axes[i] <= -0.5) current.add(`GamepadAxis${i}-`)
      if (pad.axes[i] >= 0.5) current.add(`GamepadAxis${i}+`)
    }
  }
  for (const code of current) {
    if (!previousGamepadInputs.has(code)) {
      previousGamepadInputs = current
      return code
    }
  }
  previousGamepadInputs = current
  return null
}

// 恢复默认键位
export function resetKeys(settings) {
  settings.keys = { ...defaultKeys }
}

// 把设置即时应用到运行中的界面
export function applyLive(settings) {
  document.body.dataset.crt = settings.crt ? "1" : ""
  const stage = $("#stage")
  const screen = $("#screen")
  stage.classList.toggle("crt", settings.crt)
  screen.classList.toggle("crt", settings.crt)
  const pad = $("#touch-pad")
  const isTouch = "ontouchstart" in window
  pad.classList.toggle("show", settings.touch || isTouch)
  // runner 与输入映射都在 play.js 中，音量与改键结果实时同步
  import("./play.js").then((m) => {
    m.applyVolume(settings.volume)
    m.applyKeys(settings.keys)
  })
}
