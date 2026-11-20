// Package game 定义 WebSocket 联机协议及其编解码
package game

import "encoding/json"

// inbound 是浏览器发来的一条消息，字段按消息类型取用
type inbound struct {
	T       string          `json:"t"`                 // 消息类型
	Name    string          `json:"name"`              // 昵称
	RoomID  string          `json:"roomId,omitempty"`  // 目标房间号
	GameID  string          `json:"gameId,omitempty"`  // 游戏相对路径
	Text    string          `json:"text,omitempty"`    // 聊天文本
	Data    string          `json:"d,omitempty"`       // 紧凑同步帧数据
	To      string          `json:"to,omitempty"`      // 信令目标连接
	From    string          `json:"from,omitempty"`    // 信令来源连接
	Frame   int             `json:"frame,omitempty"`   // 兼容旧客户端的输入帧号
	Keys    []string        `json:"keys,omitempty"`    // 兼容旧客户端的按键名集合
	Mask    *uint16         `json:"mask,omitempty"`    // 新客户端使用的按键位掩码
	Signal  json.RawMessage `json:"signal,omitempty"`  // WebRTC 信令原文
	Payload json.RawMessage `json:"payload,omitempty"` // 中转的房主消息原文
}

// outbound 是服务器发给浏览器的一条消息，字段按消息类型取用
type outbound struct {
	T       string          `json:"t"`
	OK      bool            `json:"ok,omitempty"`
	Error   string          `json:"error,omitempty"`
	RoomID  string          `json:"roomId,omitempty"`
	GameID  string          `json:"gameId,omitempty"`
	Name    string          `json:"name,omitempty"`
	From    string          `json:"from,omitempty"`
	Text    string          `json:"text,omitempty"`
	Data    string          `json:"d,omitempty"` // 紧凑同步帧数据
	Frame   int             `json:"frame,omitempty"`
	Keys    []string        `json:"keys,omitempty"`
	Mask    *uint16         `json:"mask,omitempty"`
	Signal  json.RawMessage `json:"signal,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// lobbyRoom 是大厅“正在游玩”列表中的一项
type lobbyRoom struct {
	RoomID  string `json:"roomId"`
	GameID  string `json:"gameId"`
	Game    string `json:"game"`
	Owner   string `json:"owner"`
	Players int    `json:"players"`
	Cap     int    `json:"cap"`
}
