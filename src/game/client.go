package game

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second // 单次写超时
	pongWait   = 60 * time.Second // 读超时，收到pong后重置
	pingPeriod = 25 * time.Second // 心跳间隔，须小于 pongWait
	sendBuffer = 256              // 发送队列长度，写满即断开避免阻塞Hub
)

// Client 是一条 WebSocket 连接的生命周期封装，收发各占一个 goroutine
type Client struct {
	hub       *Hub
	conn      *websocket.Conn
	send      chan []byte
	closed    chan struct{}
	closeOnce sync.Once

	id   string // 连接唯一标识，作为 P2P 信令地址
	name string // 服务端校验后的昵称，空串表示未登录

	room    *Room // 所在房间，nil 表示大厅
	isOwner bool  // 是否房主
	seat    int   // 玩家座位：0=P1 1=P2
}

// sendJSON 把消息推入发送队列，队列满时关闭连接触发统一清理
func (c *Client) sendJSON(msg outbound) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[连接] 编码消息失败 id=%s name=%s err=%v", c.id, c.name, err)
		return
	}
	select {
	case c.send <- data:
	case <-c.closed:
		return
	default:
		log.Printf("[连接] 发送队列已满，关闭连接 id=%s name=%s", c.id, c.name)
		c.closeConn()
	}
}

// readPump 循环读取浏览器消息并转交 Hub，连接断开时注销
func (c *Client) readPump() {
	defer func() {
		select {
		case c.hub.commands <- command{client: c, msg: inbound{T: "_closed"}}:
		case <-c.hub.done:
		}
	}()
	// 消息上限放宽到 4MB：对局快照本身已压缩，这里只作为兜底保护
	c.conn.SetReadLimit(4 << 20)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		var msg inbound
		if err := c.conn.ReadJSON(&msg); err != nil {
			log.Printf("[连接] 读取结束 id=%s name=%s err=%v", c.id, c.name, err)
			return
		}
		select {
		case c.hub.commands <- command{client: c, msg: msg}:
		case <-c.hub.done:
			return
		case <-c.closed:
			return
		}
	}
}

// writePump 独占写操作，按队列顺序发送并定时心跳
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()
	for {
		select {
		case data, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				log.Printf("[连接] 写出错 id=%s name=%s 长度=%d err=%v", c.id, c.name, len(data), err)
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Printf("[连接] 心跳出错 id=%s name=%s err=%v", c.id, c.name, err)
				return
			}
		case <-c.hub.done:
			return
		case <-c.closed:
			return
		}
	}
}

// closeConn 只关闭一次底层连接，解除读写协程阻塞
func (c *Client) closeConn() {
	c.closeOnce.Do(func() {
		close(c.closed)
		_ = c.conn.Close()
	})
}
