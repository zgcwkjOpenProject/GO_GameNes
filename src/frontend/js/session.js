// 联机会话：房主与 P2 通过服务器信令建立 WebRTC DataChannel
// 打洞失败时自动降级为服务器中转输入，保证任何网络下都能联机
import { net } from "./network.js"

// 管理一次对战的联机状态
export class Session {
  constructor() {
    this.roomId = ""
    this.isOwner = false
    this.peerName = ""
    this.mode = "local"      // local | p2p | relay
    this.pc = null           // RTCPeerConnection（房主侧持有）
    this.dc = null           // DataChannel
    this.onPeerMessage = null
    this.onStatus = null
    this.onPeerJoined = null
    this.onPeerLeft = null
    this.onRoomClosed = null
    this.onPeerReady = null  // 通道可用（P2P 打开或可走中转）时触发，用于同步开局状态
    this._bindNet()
  }

  // 订阅服务器消息
  _bindNet() {
    net.on("peer_joined", (m) => {
      this.peerName = m.name || "玩家2"
      if (this.onPeerJoined) this.onPeerJoined(m.name, m.from)
      if (this.isOwner) {
        // 先用服务器中转同步一次状态，P2P 建好后再同步一次，打洞失败也能对齐
        this._ready()
        this._setupOwnerSide()
      }
    })
    net.on("peer_left", (m) => {
      this.peerName = ""
      this._teardownPeer()
      if (this.onPeerLeft) this.onPeerLeft(m.name)
    })
    net.on("room_closed", () => {
      this._reset()
      if (this.onRoomClosed) this.onRoomClosed()
    })
    net.on("signal", (m) => this._onSignal(m))
    net.on("relay", (m) => {
      // 服务器中转消息，P2 接收房主状态，房主接收 P2 的状态请求
      if (this.isOwner) {
        if (m.payload && this.onPeerMessage) {
          this.onPeerMessage(m.payload)
        }
        return
      }
      if (this.onPeerMessage) this.onPeerMessage(m.payload)
    })
    net.on("q", (m) => {
      // 紧凑帧使用专用消息，避免 relay/payload 的双层 JSON 开销
      if (this.isOwner || !m.d || !this.onPeerMessage) return
      this.onPeerMessage(m.d)
    })
    net.on("input", (m) => {
      // 服务器中转的 P2 按键掩码和输入帧号
      if (!this.isOwner) return
      if (this.onPeerMessage) this.onPeerMessage({ type: "keys", mask: m.mask, keys: m.keys, frame: m.frame })
    })
    net.on("ready", () => {
      // P2 载入完成，房主需要再同步一次对局状态
      if (!this.isOwner) return
      if (this.onPeerMessage) this.onPeerMessage({ type: "ready" })
    })
  }

  // 房主开局并等待 P2 加入
  startOwner(roomId) {
    this._reset()
    this.roomId = roomId
    this.isOwner = true
    this.mode = "local"
  }

  // P2 加入并默认使用服务器中转
  startGuest(roomId, ownerName) {
    this._reset()
    this.roomId = roomId
    this.isOwner = false
    this.peerName = ownerName || "房主"
    this.mode = "relay"
  }

  // 房主侧创建 RTCPeerConnection，主动发送 offer 等待 P2 应答
  async _setupOwnerSide() {
    this._teardownPeer()
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] })
    this.pc = pc
    // 有序可靠通道足够承载低频按键消息
    this.dc = pc.createDataChannel("nes", { ordered: true })
    this._bindChannel()
    pc.onicecandidate = (e) => {
      if (e.candidate) net.signal({ kind: "ice", candidate: e.candidate })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        this.mode = "p2p"
        this._status()
      } else if (pc.connectionState === "failed") {
        // 打洞失败：P2 会自动走服务器中转，房主保持本地输入
        this._teardownPeer()
        this._status()
      }
    }
    try {
      await pc.setLocalDescription(await pc.createOffer())
      net.signal({ kind: "offer", sdp: pc.localDescription })
    } catch (err) {
      console.warn("创建 offer 失败", err)
    }
  }

  // 绑定 DataChannel 消息
  _bindChannel() {
    if (!this.dc) return
    this.dc.onopen = () => {
      // 双方都通过 DataChannel 直连成功
      this.mode = "p2p"
      this._status()
      this._ready()
    }
    this.dc.onclose = () => {
      // 通道断开：房主回到本地输入，P2 落回服务器中转
      if (this.mode === "p2p") {
        this.mode = this.isOwner ? "local" : "relay"
        this._status()
      }
    }
    this.dc.onmessage = (e) => {
      if (typeof e.data === "string" && e.data.startsWith("q")) {
        if (this.onPeerMessage) this.onPeerMessage(e.data)
        return
      }
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (this.onPeerMessage) this.onPeerMessage(msg)
    }
  }

  // 处理对端信令，房主接收 answer，P2 接收 offer
  async _onSignal(m) {
    const sig = m.signal
    if (!sig) return
    try {
      if (sig.kind === "offer" && !this.isOwner) {
        this._teardownPeer()
        const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] })
        this.pc = pc
        pc.onicecandidate = (e) => {
          if (e.candidate) net.signal({ kind: "ice", candidate: e.candidate })
        }
        pc.ondatachannel = (e) => {
          this.dc = e.channel
          this._bindChannel()
        }
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed") {
            // 打洞失败：保持服务器中转输入
            this.mode = "relay"
            this._status()
          }
        }
        await pc.setRemoteDescription(sig.sdp)
        await pc.setLocalDescription(await pc.createAnswer())
        net.signal({ kind: "answer", sdp: this.pc.localDescription })
      } else if (sig.kind === "answer" && this.isOwner && this.pc) {
        await this.pc.setRemoteDescription(sig.sdp)
      } else if (sig.kind === "ice" && this.pc) {
        try {
          await this.pc.addIceCandidate(sig.candidate)
        } catch {
          // 候选可能晚于连接关闭到达
        }
      }
    } catch (err) {
      console.warn("信令处理失败", err)
    }
  }

  // 关闭 P2P 通道
  _teardownPeer() {
    if (this.dc) {
      try {
        this.dc.close()
      } catch {
        // 忽略
      }
      this.dc = null
    }
    if (this.pc) {
      try {
        this.pc.close()
      } catch {
        // 忽略
      }
      this.pc = null
    }
  }

  // 整体复位会话
  _reset() {
    this._teardownPeer()
    this.roomId = ""
    this.isOwner = false
    this.peerName = ""
    this.mode = "local"
  }

  // 向界面报告当前联机模式
  _status() {
    if (this.onStatus) this.onStatus(this.mode, this.peerName)
  }

  // 通知外部通道已可用
  _ready() {
    if (!this.roomId || !this.peerName) return
    if (this.onPeerReady) this.onPeerReady()
  }

  // 把本地按键掩码发给对端
  sendKeys(mask, frame = 0) {
    if (this.isOwner) return
    if (this.mode === "p2p" && this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify({ type: "keys", mask, frame }))
    } else if (this.mode === "relay") {
      net.input(mask, frame)
    }
  }

  // 向房主请求一份完整对局状态
  requestState() {
    if (this.isOwner || !this.roomId) return
    const msg = JSON.stringify({ type: "state_request" })
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(msg)
      return
    }
    net.relayToOwner({ type: "state_request" })
  }

  // 向房主发送状态确认或其他控制消息
  sendToOwner(msg) {
    if (this.isOwner || !this.roomId) return
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(msg))
      return
    }
    net.relayToOwner(msg)
  }

  // 房主向 P2 发送任意消息，优先走 P2P，未建立时退回服务器中转
  sendToPeer(msg) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(typeof msg === "string" ? msg : JSON.stringify(msg))
      return
    }
    if (!this.roomId) return
    if (typeof msg === "string") net.frame(msg)
    else net.relay(msg)
  }

  // 通知房主自己已就绪，请补发对局状态
  sendReady() {
    if (this.isOwner || !this.roomId) return
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify({ type: "ready" }))
      return
    }
    net.ready()
  }

  // 退出会话并通知服务器
  leave() {
    net.leaveRoom()
    this._reset()
  }
}

// 全局共享一个会话实例
export const session = new Session()
