package game

import "sync"

// Room 是一个对战房间：房主运行模拟器渲染画面，P2 通过 WebRTC 观看并参与输入
// P2P 打洞失败时房间退化为服务器中转输入模式
type Room struct {
	ID     string
	GameID string
	Owner  *Client

	mu      sync.Mutex
	player  *Client // P2 玩家，nil 表示空位
	created int64   // 创建时间戳，用于大厅排序
}

// seatTaken 判断指定座位是否已有玩家
func (r *Room) seatTaken(seat int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seat == 0 {
		return r.Owner != nil
	}
	return r.player != nil
}

// addPlayer 让一名连接占用空余的 P2 座位，满员返回 false
func (r *Room) addPlayer(c *Client) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.player != nil {
		return false
	}
	r.player = c
	return true
}

// removePlayer 把连接移出房间并清空其座位
func (r *Room) removePlayer(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.player == c {
		r.player = nil
	}
}

// nameUsed 判断昵称是否已被房间内成员占用，避免联机时昵称混淆
func (r *Room) nameUsed(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return (r.Owner != nil && r.Owner.name == name) || (r.player != nil && r.player.name == name)
}

// memberCount 返回房间当前人数，含房主
func (r *Room) memberCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	if r.Owner != nil {
		n++
	}
	if r.player != nil {
		n++
	}
	return n
}

// peerOf 返回同房间内另一名成员，找不到返回 nil
func (r *Room) peerOf(c *Client) *Client {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c == r.Owner {
		return r.player
	}
	return r.Owner
}
