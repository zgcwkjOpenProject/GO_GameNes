package game

import (
	"log"
	"time"
)

// handleHello 处理昵称登记，昵称重复时拒绝
func (h *Hub) handleHello(c *Client, msg inbound) {
	name := sanitizeName(msg.Name)
	if name == "" {
		c.sendJSON(outbound{T: "hello_ok", OK: false, Error: "昵称不能为空"})
		return
	}
	if name != c.name && h.nameTaken(name, c) {
		c.sendJSON(outbound{T: "hello_ok", OK: false, Error: "昵称已被使用"})
		return
	}
	c.name = name
	c.sendJSON(outbound{T: "hello_ok", OK: true, Name: name})
}

// handleCreateRoom 由未来房主发起，指定游戏路径建立房间
func (h *Hub) handleCreateRoom(c *Client, msg inbound) {
	if c.name == "" {
		c.sendJSON(outbound{T: "create_room_ok", OK: false, Error: "请先设置昵称"})
		return
	}
	if c.room != nil {
		c.sendJSON(outbound{T: "create_room_ok", OK: false, Error: "已在房间中"})
		return
	}
	if !ValidGameID(msg.GameID) || (h.gameValidator != nil && !h.gameValidator(msg.GameID)) {
		c.sendJSON(outbound{T: "create_room_ok", OK: false, Error: "游戏不存在"})
		return
	}
	r := h.createRoom(msg.GameID, c)
	c.room = r
	c.isOwner = true
	c.seat = 0
	h.stats.recordGame(1, time.Now())
	c.sendJSON(outbound{T: "create_room_ok", OK: true, RoomID: r.ID, GameID: r.GameID})
}

// handleJoinRoom 让玩家进入指定房间的 P2 座位
func (h *Hub) handleJoinRoom(c *Client, msg inbound) {
	if c.name == "" {
		c.sendJSON(outbound{T: "join_room_ok", OK: false, Error: "请先设置昵称"})
		return
	}
	if c.room != nil {
		c.sendJSON(outbound{T: "join_room_ok", OK: false, Error: "已在房间中"})
		return
	}
	h.mu.Lock()
	r := h.rooms[msg.RoomID]
	h.mu.Unlock()
	if r == nil {
		c.sendJSON(outbound{T: "join_room_ok", OK: false, Error: "房间不存在或已结束"})
		return
	}
	if r.nameUsed(c.name) {
		c.sendJSON(outbound{T: "join_room_ok", OK: false, Error: "房主使用了相同昵称"})
		return
	}
	if !r.addPlayer(c) {
		c.sendJSON(outbound{T: "join_room_ok", OK: false, Error: "房间已满"})
		return
	}
	log.Printf("[联机] P2 加入 room=%s 玩家=%s(%s)", r.ID, c.name, c.id)
	c.room = r
	c.isOwner = false
	c.seat = 1
	h.stats.recordGame(1, time.Now())
	owner := r.peerOf(c)
	if owner != nil {
		owner.sendJSON(outbound{T: "peer_joined", Name: c.name, From: c.id})
	}
	c.sendJSON(outbound{T: "join_room_ok", OK: true, RoomID: r.ID, GameID: r.GameID, Name: ownerName(r)})
}

// handleLeaveRoom 主动退出当前房间；房主退出则解散
func (h *Hub) handleLeaveRoom(c *Client) {
	if c.room == nil {
		return
	}
	room := c.room
	peer := room.peerOf(c)
	room.removePlayer(c)
	c.room = nil
	if c.isOwner {
		h.closeRoom(room.ID)
		if peer != nil {
			peer.room = nil
			peer.isOwner = false
			peer.sendJSON(outbound{T: "room_closed"})
		}
	} else if peer != nil {
		peer.sendJSON(outbound{T: "peer_left", Name: c.name})
	}
	c.sendJSON(outbound{T: "leave_room_ok", OK: true})
}

// handleSignal 转发 WebRTC 信令给同房间对端，完成 P2P 打洞协商
func (h *Hub) handleSignal(c *Client, msg inbound) {
	if c.room == nil {
		return
	}
	peer := c.room.peerOf(c)
	if peer == nil {
		return
	}
	peer.sendJSON(outbound{T: "signal", From: c.id, Signal: msg.Signal})
}

// handleInput 中转输入：P2 把按键掩码发给房主，旧客户端仍可使用按键数组
func (h *Hub) handleInput(c *Client, msg inbound) {
	if c.room == nil || c.isOwner {
		return
	}
	peer := c.room.peerOf(c)
	if peer != nil {
		peer.sendJSON(outbound{T: "input", From: c.id, Frame: msg.Frame, Keys: msg.Keys, Mask: msg.Mask})
	}
}

// handleRelay 把房主消息经服务器转发给 P2，供 P2P 打洞失败时兜底
func (h *Hub) handleRelay(c *Client, msg inbound) {
	if c.room == nil || !c.isOwner {
		return
	}
	peer := c.room.peerOf(c)
	if peer != nil {
		peer.sendJSON(outbound{T: "relay", Payload: msg.Payload})
	}
}

// handleCompactFrame 把房主的紧凑同步帧直接转发给 P2
func (h *Hub) handleCompactFrame(c *Client, msg inbound) {
	if c.room == nil || !c.isOwner || msg.Data == "" {
		return
	}
	peer := c.room.peerOf(c)
	if peer != nil {
		peer.sendJSON(outbound{T: "q", Data: msg.Data})
	}
}

// handleRelayToOwner 把 P2 的状态请求转发给房主
func (h *Hub) handleRelayToOwner(c *Client, msg inbound) {
	if c.room == nil || c.isOwner {
		return
	}
	peer := c.room.peerOf(c)
	if peer != nil {
		peer.sendJSON(outbound{T: "relay", Payload: msg.Payload})
	}
}

// handleReady 是 P2 就绪握手：P2 载入 ROM 后通知房主补发一次对局状态
func (h *Hub) handleReady(c *Client) {
	if c.room == nil || c.isOwner {
		return
	}
	peer := c.room.peerOf(c)
	if peer != nil {
		peer.sendJSON(outbound{T: "ready", From: c.id})
	}
}

// handleChat 把聊天文本转发给同房间另一名成员
func (h *Hub) handleChat(c *Client, msg inbound) {
	if c.room == nil {
		return
	}
	peer := c.room.peerOf(c)
	if peer != nil {
		peer.sendJSON(outbound{T: "chat", From: c.id, Name: c.name, Text: sanitizeText(msg.Text)})
	}
}

// ownerName 读取房间房主昵称
func ownerName(r *Room) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Owner == nil {
		return ""
	}
	return r.Owner.name
}
