// 应用入口：装配设置、路由、大厅与游玩界面
import { loadSettings, saveSettings, $, toast } from "./common.js"
import { net } from "./network.js"
import { initRouter, gotoPage } from "./router.js"
import { initHome, initRoomFlow, gotoHome } from "./home.js"
import { initPlay, openGame, openJoined } from "./play.js"
import { initSettings, applyLive } from "./ui.js"

// settings 全局用户设置，进入页面时从 localStorage 恢复
const settings = loadSettings()

// 在顶部右侧显示当前用户状态
function updateUserArea() {
  const area = $("#user-area")
  area.innerHTML = ""
  if (settings.name) {
    const chip = document.createElement("div")
    chip.className = "user-chip"
    const dot = document.createElement("span")
    dot.className = "dot"
    const name = document.createElement("b")
    name.textContent = settings.name
    chip.appendChild(dot)
    chip.appendChild(name)
    area.appendChild(chip)
  }
}

// 启动应用
function main() {
  initRouter()
  applyLive(settings)
  updateUserArea()
  net.connect()

  // 登录应答：成功后更新顶栏，失败提示改名
  net.on("hello_ok", (m) => {
    if (!m.ok) {
      console.warn("昵称被拒绝:", m.error)
      toast(m.error || "昵称被拒绝", true)
      return
    }
    net.loggedIn = true
    updateUserArea()
  })

  initSettings(settings, (s) => {
    saveSettings(s)
    if (s.name) net.login(s.name)
    updateUserArea()
  })

  // 把房主或单人开局请求转给游玩界面
  const open = (game, isRoom, roomId) => openGame(game, isRoom, roomId)

  initHome((game, isRoom, roomId) => open(game, isRoom, roomId))
  initRoomFlow((game, isRoom, roomId) => open(game, isRoom, roomId), openJoined)
  initPlay(settings, saveSettings)
  gotoPage("home")
}

main()
