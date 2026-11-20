// Package api 扫描本地 NES ROM 目录并提供文件下载
package api

import (
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Game 描述一款游戏的基本信息
type Game struct {
	ID    string `json:"id"`              // 相对路径，作为唯一标识
	Name  string `json:"name"`            // 展示名称：优先取同名 txt 第一行，否则用文件名
	Desc  string `json:"desc,omitempty"`  // 游戏介绍：同名 txt 第二行
	Size  int64  `json:"size"`            // 文件大小，用于前端粗略展示
	Cover string `json:"cover,omitempty"` // 封面图片相对路径（同名 png/jpg 等时存在）
}

// coverExts 是可识别的封面图片扩展名（小写）
var coverExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true,
}

// GameLib 维护 ROM 目录的内存索引，支持运行期重新扫描
type GameLib struct {
	dir   string
	mu    sync.RWMutex
	games []Game
	index map[string]Game
}

// NewGameLib 扫描目录建立初始索引
func NewGameLib(dir string) *GameLib {
	lib := &GameLib{dir: dir, index: map[string]Game{}}
	lib.Reload()
	return lib
}

// Reload 重新扫描 ROM 目录，收录全部 .nes 文件（含子目录）
// 同名 txt 存在时：第一行作为展示名称、第二行作为介绍
// 同名图片（png/jpg/webp/gif）存在时作为封面
func (l *GameLib) Reload() {
	list := []Game{}
	_ = filepath.WalkDir(l.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".nes") {
			return nil
		}
		rel, err := filepath.Rel(l.dir, p)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		info, err := d.Info()
		if err != nil {
			return nil
		}
		g := Game{
			ID:   rel,
			Name: strings.TrimSuffix(filepath.Base(rel), filepath.Ext(rel)),
			Size: info.Size(),
		}
		base := strings.TrimSuffix(p, filepath.Ext(p))
		// 同名 txt：第一行名称，第二行介绍
		if name, desc, ok := readGameText(base + ".txt"); ok {
			if name != "" {
				g.Name = name
			}
			g.Desc = desc
		}
		// 同名图片：按优先级找一张作为封面
		if cover := findCover(l.dir, base); cover != "" {
			g.Cover = cover
		}
		list = append(list, g)
		return nil
	})
	sort.Slice(list, func(i, j int) bool {
		// 有封面的游戏优先；同组内继续按名称排序，保证列表稳定易查找
		if (list[i].Cover != "") != (list[j].Cover != "") {
			return list[i].Cover != ""
		}
		return list[i].Name < list[j].Name
	})
	l.mu.Lock()
	l.games = list
	l.index = make(map[string]Game, len(list))
	for _, g := range list {
		l.index[g.ID] = g
	}
	l.mu.Unlock()
}

// readGameText 读取游戏配套 txt：第一行是名称，第二行是介绍；文件不存在时返回 ok=false
func readGameText(path string) (name, desc string, ok bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", false
	}
	// 统一按行拆分，兼容 \r\n 与 \n
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	if len(lines) > 0 {
		name = strings.TrimSpace(lines[0])
	}
	if len(lines) > 1 {
		desc = strings.TrimSpace(lines[1])
	}
	return name, desc, true
}

// findCover 在 ROM 同名位置查找封面图片，按 png/jpg/jpeg/webp/gif 优先级返回相对斜杠路径
func findCover(romDir, nesPath string) string {
	for _, ext := range []string{".png", ".jpg", ".jpeg", ".webp", ".gif"} {
		candidate := nesPath + ext
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			rel, err := filepath.Rel(romDir, candidate)
			if err != nil {
				return ""
			}
			return filepath.ToSlash(rel)
		}
	}
	return ""
}

// List 返回全部游戏副本
func (l *GameLib) List() []Game {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return append([]Game(nil), l.games...)
}

// SearchPage 按名称、描述或 ID 搜索游戏，并返回指定页的数据
func (l *GameLib) SearchPage(query string, page, pageSize int) ([]Game, int) {
	query = strings.ToLower(strings.TrimSpace(query))
	l.mu.RLock()
	defer l.mu.RUnlock()

	matched := make([]Game, 0, len(l.games))
	for _, g := range l.games {
		if query == "" || strings.Contains(strings.ToLower(g.Name), query) ||
			strings.Contains(strings.ToLower(g.Desc), query) ||
			strings.Contains(strings.ToLower(g.ID), query) {
			matched = append(matched, g)
		}
	}
	total := len(matched)
	start := (page - 1) * pageSize
	if start >= total {
		return []Game{}, total
	}
	end := start + pageSize
	if end > total {
		end = total
	}
	return append([]Game(nil), matched[start:end]...), total
}

// NameMap 返回游戏ID到展示名的映射，供大厅列表翻译
func (l *GameLib) NameMap() map[string]string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	m := make(map[string]string, len(l.index))
	for id, g := range l.index {
		m[id] = g.Name
	}
	return m
}

// Has 判断游戏 ID 是否存在于当前索引
func (l *GameLib) Has(id string) bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	_, ok := l.index[id]
	return ok
}

// ServeCover 输出指定游戏的封面图片；游戏或封面不存在时返回 404
func (l *GameLib) ServeCover(w http.ResponseWriter, r *http.Request, id string) {
	l.mu.RLock()
	g, ok := l.index[id]
	l.mu.RUnlock()
	if !ok || g.Cover == "" {
		http.Error(w, "封面不存在", http.StatusNotFound)
		return
	}
	full := filepath.Join(l.dir, filepath.FromSlash(g.Cover))
	file, err := os.Open(full)
	if err != nil {
		http.Error(w, "读取封面失败", http.StatusInternalServerError)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		http.Error(w, "读取封面失败", http.StatusInternalServerError)
		return
	}
	// 按扩展名推断图片类型；允许浏览器缓存，封面一般不变
	w.Header().Set("Content-Type", mime.TypeByExtension(strings.ToLower(filepath.Ext(full))))
	w.Header().Set("Cache-Control", "public, max-age=300")
	http.ServeContent(w, r, filepath.Base(full), info.ModTime(), file)
}

// ServeROM 输出游戏本体文件内容
func (l *GameLib) ServeROM(w http.ResponseWriter, r *http.Request, id string) {
	l.mu.RLock()
	g, ok := l.index[id]
	l.mu.RUnlock()
	if !ok {
		http.Error(w, "游戏不存在", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	full := filepath.Join(l.dir, filepath.FromSlash(id))
	file, err := os.Open(full)
	if err != nil {
		http.Error(w, "读取游戏失败", http.StatusInternalServerError)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		http.Error(w, "读取游戏失败", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	// 启用断点续传，模拟器加载中断后可恢复
	http.ServeContent(w, r, g.Name+".nes", info.ModTime(), file)
}
