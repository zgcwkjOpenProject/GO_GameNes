package game

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// 开启 permessage-deflate，压缩信令、按键和中转消息的 WebSocket 包体
	EnableCompression: true,
	// 页面可能通过局域网 IP 访问，校验来源主机而不是无条件放行
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		return err == nil && u.Host != "" && strings.EqualFold(u.Host, r.Host)
	},
}

// ServeWS 升级 HTTP 连接为 WebSocket 并进入收发循环
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.EnableWriteCompression(true)
	c := &Client{hub: h, conn: conn, send: make(chan []byte, sendBuffer), closed: make(chan struct{}), id: newID()}
	h.addClient(c)
	go c.writePump()
	go c.readPump()
}
