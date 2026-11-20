// Package game 持久化首页游玩人数统计
package game

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// playerStats 保存累计游玩人数和当日游玩人数
type playerStats struct {
	Date  string `json:"date"`
	Total int    `json:"total"`
	Today int    `json:"today"`

	path string
	mu   sync.RWMutex
}

// PlayerStatsView 是首页公开展示的游玩人数统计
type PlayerStatsView struct {
	Today int `json:"today"`
	Total int `json:"total"`
}

// newPlayerStats 从 JSON 读取统计，不存在或格式无效时从零开始
func newPlayerStats(path string) *playerStats {
	s := &playerStats{path: path}
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, s)
	}
	s.resetDay(time.Now())
	return s
}

// resetDay 在日期变化后清零今日统计
func (s *playerStats) resetDay(now time.Time) {
	date := now.Format("2006-01-02")
	if s.Date == date {
		return
	}
	s.Date = date
	s.Today = 0
}

// recordGame 记录进入对局的真人数量，不对玩家做去重
func (s *playerStats) recordGame(players int, now time.Time) {
	if players <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.resetDay(now)
	s.Total += players
	s.Today += players
	s.saveLocked()
}

// saveLocked 持久化统计，调用方必须持有写锁
func (s *playerStats) saveLocked() {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return
	}
	data, err := json.MarshalIndent(struct {
		Date  string `json:"date"`
		Total int    `json:"total"`
		Today int    `json:"today"`
	}{s.Date, s.Total, s.Today}, "", "  ")
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err == nil {
		if err := os.Rename(tmp, s.path); err != nil {
			// Windows 不允许 Rename 覆盖已存在的目标文件，重试一次替换
			_ = os.Remove(s.path)
			_ = os.Rename(tmp, s.path)
		}
	}
}

// view 返回首页公开展示的数据
func (s *playerStats) view() PlayerStatsView {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.resetDay(time.Now())
	return PlayerStatsView{Today: s.Today, Total: s.Total}
}

// defaultStatsPath 返回程序运行目录下的统计文件位置
func defaultStatsPath() string {
	return filepath.Join("data", "players.json")
}
