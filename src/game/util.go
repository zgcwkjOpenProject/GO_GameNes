package game

import (
	"path"
	"strings"
	"unicode/utf8"
)

// maxNameLen 是昵称与聊天文本的长度上限
const maxNameLen = 12

// sanitizeName 清洗昵称：去除空白与控制字符并限制长度
func sanitizeName(raw string) string {
	name := strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 {
			return -1
		}
		return r
	}, raw))
	name = strings.ReplaceAll(name, "\u3000", "")
	for utf8.RuneCountInString(name) > maxNameLen {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	return name
}

// sanitizeText 清洗聊天文本：去控制字符并限制长度
func sanitizeText(raw string) string {
	text := strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\n' {
			return -1
		}
		return r
	}, raw)
	for utf8.RuneCountInString(text) > 80 {
		_, size := utf8.DecodeLastRuneInString(text)
		text = text[:len(text)-size]
	}
	return strings.TrimSpace(text)
}

// ValidGameID 校验游戏路径形如库内允许的相对路径，阻断目录穿越
func ValidGameID(id string) bool {
	if id == "" {
		return false
	}
	if strings.ContainsRune(id, '\\') || strings.ContainsRune(id, '\x00') || path.Clean(id) != id || path.IsAbs(id) {
		return false
	}
	return strings.EqualFold(path.Ext(id), ".nes")
}

// nameTaken 检查昵称是否被其他在线连接占用
func (h *Hub) nameTaken(name string, self *Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.clients {
		if c != self && c.name == name {
			return true
		}
	}
	return false
}
