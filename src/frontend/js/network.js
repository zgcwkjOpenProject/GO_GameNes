// WebSocket 联机层：登录、建房、加入、信令转发与输入中转
import { toast, assetPath } from "./common.js"

// 封装与服务器的 WebSocket 会话，并按消息类型分发回调
export class Net {
  constructor() {
    this.ws = null
    this.handlers = {}
    this.alive = false
    this.loggedIn = false
  }

  // 建立连接，断开后自动重连
  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return
    const proto = location.protocol === "https:" ? "wss://" : "ws://"
    // 保留当前站点前缀，再将 HTTP(S) 地址切换为 WebSocket 协议
    const wsURL = new URL(assetPath("ws"))
    wsURL.protocol = proto === "wss://" ? "wss:" : "ws:"
    this.ws = new WebSocket(wsURL)
    this.ws.onopen = () => {
      this.alive = true
      // 重连后需要重新登记昵称
      this.loggedIn = false
      this.emit("_open", {})
    }
    this.ws.onclose = () => {
      this.alive = false
      this.emit("_close", {})
      setTimeout(() => this.connect(), 3000)
    }
    this.ws.onerror = () => this.ws.close()
    this.ws.onmessage = (e) => {
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      this.emit(msg.t, msg)
    }
  }

  // 注册某类消息的回调
  on(type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn)
  }

  // 取消注册的回调
  off(type, fn) {
    const list = this.handlers[type]
    if (!list) return
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }

  // 分发消息给已注册的回调
  emit(type, msg) {
    for (const fn of this.handlers[type] || []) fn(msg)
  }

  // 发送一条消息给服务器
  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg))
  }

  // 使用昵称登录，服务器确认后触发回调
  login(name) {
    this.send({ t: "hello", name })
  }

  // 请求创建房间
  createRoom(gameId) {
    this.send({ t: "create_room", gameId })
  }

  // 请求加入房间
  joinRoom(roomId) {
    this.send({ t: "join_room", roomId })
  }

  // 请求退出房间
  leaveRoom() {
    this.send({ t: "leave_room" })
  }

  // 发送 WebRTC 信令给对端
  signal(payload) {
    this.send({ t: "signal", signal: payload })
  }

  // 把本地按键掩码发给房主
  input(mask, frame = 0) {
    this.send({ t: "input", mask, frame })
  }

  // 把房主消息经服务器转发给 P2
  relay(payload) {
    this.send({ t: "relay", payload })
  }

  // 把紧凑同步帧经服务器转发给 P2
  frame(data) {
    this.send({ t: "q", d: data })
  }

  // 将消息经服务器转发给房主
  relayToOwner(payload) {
    this.send({ t: "relay_to_owner", payload })
  }

  // 通知房主自己已载入 ROM，请补发一次对局状态
  ready() {
    this.send({ t: "ready" })
  }

  // 发送房间内聊天
  chat(text) {
    this.send({ t: "chat", text })
  }
}

// 全局共享一个连接实例
export const net = new Net()

// 随机生成一个昵称，形如“玩家3f2a”
function randomName() {
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")
  return "玩家" + hex
}

// 确保已设置昵称，没有则随机生成一个并登记，成功后触发回调
export function ensureLogin(settings, saveFn, onReady) {
  if (!settings.name) {
    // 未设置昵称：自动随机生成，用户可在设置页修改
    settings.name = randomName()
    saveFn(settings)
  }
  const proceed = () => {
    if (onReady) onReady()
  }
  if (net.loggedIn) {
    proceed()
    return
  }
  // 等待服务器确认昵称后再进入房间流程
  const handler = (m) => {
    if (!m.ok) {
      // 昵称冲突：换一个再试一次
      settings.name = randomName()
      saveFn(settings)
      net.login(settings.name)
      return
    }
    net.off("hello_ok", handler)
    proceed()
  }
  net.on("hello_ok", handler)
  net.login(settings.name)
}
