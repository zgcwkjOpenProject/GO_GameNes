// Package game 提供 NES 对战的房间大厅与联机中转服务
package game

import (
	"crypto/rand"
	"encoding/hex"
)

// newID 生成一段随机十六进制标识符，用于连接与房间编号
func newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
