// 页面路由：大厅 / 游玩 / 设置三个界面的切换与状态维护
import { $, $$ } from "./common.js"

// 保存当前页面与各页面的进入回调
const pages = { home: null, play: null, settings: null }
let current = "home"

// 注册页面切换时的回调
export function registerPage(name, onEnter, onLeave) {
  pages[name] = { onEnter, onLeave }
}

// 切换到指定页面
export function gotoPage(name) {
  if (name === current) return
  const prev = pages[current]
  if (prev && prev.onLeave) prev.onLeave()
  $$(".page").forEach((p) => p.classList.remove("active"))
  $("#page-" + name).classList.add("active")
  // 当前页面标记在 body 上，样式据此决定顶栏内容（如游玩页的工具栏）
  document.body.dataset.page = name
  $$(".topnav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === name || (name === "play" && a.dataset.nav === "home")))
  current = name
  const next = pages[name]
  if (next && next.onEnter) next.onEnter()
}

// 绑定导航点击事件
export function initRouter() {
  $$("[data-nav]").forEach((node) => {
    node.addEventListener("click", (e) => {
      e.preventDefault()
      gotoPage(node.dataset.nav)
    })
  })
}
