package game

import (
	"context"
	"log"
	"sync"
	"time"
)

// Hub 拥有全部房间与成员状态，所有状态只在 handleCommands 单循环中读写，
// WebSocket 收发 goroutine 通过 commands 通道与之通信，避免加锁
type Hub struct {
	commands chan command

	mu            sync.Mutex
	clients       map[string]*Client // 按连接ID索引的全部在线连接
	rooms         map[string]*Room   // 按房间号索引的全部房间
	order         []string           // 房间创建顺序，保持大厅列表稳定
	done          chan struct{}      // Hub 退出通知
	stats         *playerStats       // 首页今日/历史游玩人数统计
	gameValidator func(string) bool  // 游戏索引校验函数
}

// SetGameValidator 设置创建房间时使用的游戏索引校验函数
func (h *Hub) SetGameValidator(validator func(string) bool) {
	h.gameValidator = validator
}

// command 是读协程提交给 Hub 的一条待处理消息
type command struct {
	client *Client
	msg    inbound
}

// NewHub 创建空的房间大厅
func NewHub() *Hub {
	return NewHubWithStats(defaultStatsPath())
}

// NewHubWithStats 创建使用指定文件保存人数统计的房间大厅
func NewHubWithStats(statsPath string) *Hub {
	return &Hub{
		commands: make(chan command, 256),
		clients:  make(map[string]*Client),
		rooms:    make(map[string]*Room),
		done:     make(chan struct{}),
		stats:    newPlayerStats(statsPath),
	}
}

// Run 启动 Hub 主循环，直到上下文取消
func (h *Hub) Run(ctx context.Context) {
	go func() {
		<-ctx.Done()
		close(h.done)
	}()
	h.handleCommands()
}

// handleCommands 串行处理全部客户端消息
func (h *Hub) handleCommands() {
	for {
		select {
		case cmd := <-h.commands:
			h.dispatch(cmd)
		case <-h.done:
			h.closeClients()
			return
		}
	}
}

// closeClients 关闭 Hub 中的全部连接，唤醒其读写协程
func (h *Hub) closeClients() {
	h.mu.Lock()
	clients := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		clients = append(clients, c)
	}
	h.clients = make(map[string]*Client)
	h.rooms = make(map[string]*Room)
	h.order = nil
	h.mu.Unlock()
	for _, c := range clients {
		c.closeConn()
	}
}

// dispatch 按消息类型分发到对应处理函数
func (h *Hub) dispatch(cmd command) {
	switch cmd.msg.T {
	case "_closed":
		h.removeClient(cmd.client)
	case "hello":
		h.handleHello(cmd.client, cmd.msg)
	case "create_room":
		h.handleCreateRoom(cmd.client, cmd.msg)
	case "join_room":
		h.handleJoinRoom(cmd.client, cmd.msg)
	case "leave_room":
		h.handleLeaveRoom(cmd.client)
	case "signal":
		h.handleSignal(cmd.client, cmd.msg)
	case "input":
		h.handleInput(cmd.client, cmd.msg)
	case "relay":
		h.handleRelay(cmd.client, cmd.msg)
	case "q":
		h.handleCompactFrame(cmd.client, cmd.msg)
	case "relay_to_owner":
		h.handleRelayToOwner(cmd.client, cmd.msg)
	case "ready":
		h.handleReady(cmd.client)
	case "chat":
		h.handleChat(cmd.client, cmd.msg)
	}
}

// addClient 登记新连接
func (h *Hub) addClient(c *Client) {
	h.mu.Lock()
	h.clients[c.id] = c
	h.mu.Unlock()
}

// removeClient 注销连接并把它从房间中清出，同时通知对端
func (h *Hub) removeClient(c *Client) {
	log.Printf("[连接] 断开 id=%s name=%s owner=%v room=%v", c.id, c.name, c.isOwner, c.room != nil)
	h.mu.Lock()
	delete(h.clients, c.id)
	room := c.room
	h.mu.Unlock()
	if room != nil {
		peer := room.peerOf(c)
		room.removePlayer(c)
		if c.isOwner {
			h.closeRoom(room.ID)
			// 房主离开即解散房间，通知另一名成员
			if peer != nil {
				peer.room = nil
				peer.isOwner = false
				peer.sendJSON(outbound{T: "room_closed"})
			}
		} else if peer != nil {
			peer.sendJSON(outbound{T: "peer_left", Name: c.name})
		}
	}
}

// closeRoom 从大厅索引里移除房间
func (h *Hub) closeRoom(roomID string) {
	log.Printf("[房间] 解散 room=%s", roomID)
	h.mu.Lock()
	delete(h.rooms, roomID)
	for i, id := range h.order {
		if id == roomID {
			h.order = append(h.order[:i], h.order[i+1:]...)
			break
		}
	}
	h.mu.Unlock()
}

// createRoom 建立新房间并登记进大厅
func (h *Hub) createRoom(gameID string, owner *Client) *Room {
	r := &Room{ID: newID(), GameID: gameID, Owner: owner, created: time.Now().Unix()}
	h.mu.Lock()
	h.rooms[r.ID] = r
	h.order = append(h.order, r.ID)
	h.mu.Unlock()
	return r
}

// LobbyList 返回当前进行中的对局列表，供首页“正在游玩”展示
func (h *Hub) LobbyList(gameNames map[string]string) []lobbyRoom {
	h.mu.Lock()
	defer h.mu.Unlock()
	list := make([]lobbyRoom, 0, len(h.order))
	for _, id := range h.order {
		r, ok := h.rooms[id]
		if !ok {
			continue
		}
		game := r.GameID
		if name, ok := gameNames[r.GameID]; ok && name != "" {
			game = name
		}
		owner := ""
		if r.Owner != nil {
			owner = r.Owner.name
		}
		list = append(list, lobbyRoom{
			RoomID: r.ID, GameID: r.GameID, Game: game,
			Owner: owner, Players: r.memberCount(), Cap: 2,
		})
	}
	return list
}

// OnlineCount 返回当前正在房间中游玩的玩家数，供首页统计展示
func (h *Hub) OnlineCount() int {
	h.mu.Lock()
	rooms := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.Unlock()
	count := 0
	for _, r := range rooms {
		count += r.memberCount()
	}
	return count
}

// PlayStats 返回首页展示的今日与历史游玩人数
func (h *Hub) PlayStats() PlayerStatsView {
	return h.stats.view()
}

// RecordPlay 记录一次单人模式进入游戏
func (h *Hub) RecordPlay() {
	h.stats.recordGame(1, time.Now())
}
