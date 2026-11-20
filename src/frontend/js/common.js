// DOM 查询与轻量工具函数，全部前端模块共用

// $ 按选择器查找单个元素
export function $(sel, root = document) {
  return root.querySelector(sel)
}

// 根据页面 base 标签生成站点资源路径，兼容根路径和子路径部署
export function assetPath(path) {
  return new URL(path.replace(/^\//, ""), document.baseURI).toString()
}

// $$ 按选择器查找全部元素
export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel))
}

// 创建元素并用 textContent 填充文本，避免外部文本拼进 innerHTML
export function el(tag, props = {}, text = "") {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v
    else if (k === "dataset") Object.assign(node.dataset, v)
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v)
  }
  if (text) node.textContent = text
  return node
}

// 显示轻提示，2.5 秒后消失；isErr 为真时红色样式
let toastTimer = 0
export function toast(text, isErr = false) {
  const node = $("#toast")
  node.textContent = text
  node.classList.toggle("err", isErr)
  node.classList.remove("hidden")
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.add("hidden"), 2500)
}

// 打开模态框并填充内容，onClose 在关闭时回调
export function showModal(node, onClose = null) {
  const modal = $("#modal")
  const body = $("#modal-body")
  body.innerHTML = ""
  body.appendChild(node)
  modal.classList.remove("hidden")
  modal._onClose = onClose
}

// 关闭模态框
export function closeModal() {
  const modal = $("#modal")
  modal.classList.add("hidden")
  if (modal._onClose) {
    const fn = modal._onClose
    modal._onClose = null
    fn()
  }
}

// 点击遮罩关闭模态框
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) closeModal()
})

// 把字节数格式化为可读文本
export function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB"
  return Math.max(1, Math.round(bytes / 1024)) + " KB"
}

// 读取 localStorage 中的用户设置并合并默认值
export function loadSettings() {
  let saved = {}
  try {
    saved = JSON.parse(localStorage.getItem("nesbattle.settings") || "{}")
  } catch {
    saved = {}
  }
  return {
    ...saved,
    name: saved.name || "",
    keys: { ...defaultKeys, ...(saved.keys || {}) },
    volume: typeof saved.volume === "number" ? saved.volume : 60,
    crt: !!saved.crt,
    touch: !!saved.touch,
  }
}

// 把用户设置写入 localStorage
export function saveSettings(s) {
  localStorage.setItem("nesbattle.settings", JSON.stringify(s))
}

// defaultKeys 是 NES 按键到键盘键码的默认映射（P1/P2 通用）
export const defaultKeys = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  a: "KeyJ",
  b: "KeyK",
  aa: "KeyU",
  bb: "KeyI",
  start: "Enter",
  select: "ShiftRight",
}

// 把键码翻译成短名称用于展示
export function keyName(code) {
  if (!code) return "未设置"
  if (code.startsWith("GamepadButton")) return "手柄按钮 " + code.slice(13)
  if (code.startsWith("GamepadAxis")) return "手柄摇杆 " + code.slice(11).replace("-", "←").replace("+", "→")
  if (code.startsWith("Key")) return code.slice(3)
  if (code.startsWith("Digit")) return code.slice(5)
  if (code.startsWith("Arrow")) return { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }[code] || code
  if (code.startsWith("Numpad")) return "Num" + code.slice(6)
  const map = {
    Enter: "回车", Space: "空格", ShiftLeft: "LShift", ShiftRight: "RShift",
    ControlLeft: "LCtrl", ControlRight: "RCtrl", AltLeft: "LAlt", AltRight: "RAlt",
  }
  return map[code] || code
}
