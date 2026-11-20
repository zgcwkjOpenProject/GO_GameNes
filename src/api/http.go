// Package api 提供 HTTP 路由、静态资源与游戏 ROM 接口
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"nesbattle/game"
)

// Handler 聚合静态资源、大厅数据与 WebSocket 入口
type Handler struct {
	handler http.Handler // 内部注册好路由的多路复用器
	hub     *game.Hub
	roms    string // NES ROM 目录绝对路径
	games   *GameLib
}

// NewHandler 创建 API 处理器并注册全部路由
func NewHandler(assets fs.FS, basePath, romsDir string, hub *game.Hub) http.Handler {
	// 配置校验已去除结尾斜杠，这里再次兼容直接调用 NewHandler 的场景
	basePath = strings.TrimRight(basePath, "/")
	h := &Handler{hub: hub, roms: romsDir, games: NewGameLib(romsDir)}
	hub.SetGameValidator(h.games.Has)
	mux := http.NewServeMux()
	if basePath == "" {
		// 空前缀表示直接部署在站点根路径
		registerRoutes(mux, "", hub, h)
		mux.Handle("/", spaHandler{fsys: assets, basePath: ""})
		h.handler = mux
		return h
	}
	registerRoutes(mux, basePath, hub, h)
	static := spaHandler{fsys: assets, basePath: basePath}
	mux.HandleFunc(basePath, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, basePath+"/", http.StatusMovedPermanently)
	})
	mux.Handle(basePath+"/", http.StripPrefix(basePath, static))
	h.handler = mux
	return h
}

// registerRoutes 按统一前缀注册接口和 WebSocket，避免根路径与子路径配置产生两套逻辑
func registerRoutes(mux *http.ServeMux, basePath string, hub *game.Hub, h *Handler) {
	mux.HandleFunc(basePath+"/ws", hub.ServeWS)
	mux.HandleFunc(basePath+"/api/games", h.handleGames)
	mux.HandleFunc(basePath+"/api/online", h.handleOnline)
	mux.HandleFunc(basePath+"/api/play", h.handlePlay)
	mux.HandleFunc(basePath+"/rom", h.handleROM)
	mux.HandleFunc(basePath+"/cover", h.handleCover)
}

// ServeHTTP 把请求转交给内部多路复用器
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.handler.ServeHTTP(w, r)
}

// handleGames 返回游戏库列表，供首页“可游玩的游戏”展示
func (h *Handler) handleGames(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "方法不支持", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query().Get("q")
	page, pageSize, err := parseGamePage(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	games, total := h.games.SearchPage(q, page, pageSize)
	totalPages := (total + pageSize - 1) / pageSize
	writeJSON(w, map[string]any{
		"games":      games,
		"page":       page,
		"pageSize":   pageSize,
		"total":      total,
		"totalPages": totalPages,
	})
}

// parseGamePage 解析游戏库分页参数并限制单页大小，避免一次返回过多数据
func parseGamePage(r *http.Request) (page, pageSize int, err error) {
	page, pageSize = 1, 10
	values := r.URL.Query()
	if raw := values.Get("page"); raw != "" {
		page, err = strconv.Atoi(raw)
		if err != nil || page < 1 {
			return 0, 0, fmt.Errorf("page 参数无效")
		}
	}
	if raw := values.Get("pageSize"); raw != "" {
		pageSize, err = strconv.Atoi(raw)
		if err != nil || pageSize < 1 || pageSize > 100 {
			return 0, 0, fmt.Errorf("pageSize 参数无效")
		}
	}
	return page, pageSize, nil
}

// handleOnline 返回正在进行的对局与在线人数
func (h *Handler) handleOnline(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "方法不支持", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, map[string]any{
		"rooms":  h.hub.LobbyList(h.games.NameMap()),
		"online": h.hub.OnlineCount(),
		"stats":  h.hub.PlayStats(),
	})
}

// handlePlay 记录单人模式进入一次游戏
func (h *Handler) handlePlay(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "方法不支持", http.StatusMethodNotAllowed)
		return
	}
	h.hub.RecordPlay()
	writeJSON(w, h.hub.PlayStats())
}

// handleROM 输出指定游戏的本体文件，前端模拟器据此加载
func (h *Handler) handleROM(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "方法不支持", http.StatusMethodNotAllowed)
		return
	}
	id := r.URL.Query().Get("id")
	if !game.ValidGameID(id) {
		http.Error(w, "非法的游戏路径", http.StatusBadRequest)
		return
	}
	h.games.ServeROM(w, r, id)
}

// handleCover 输出指定游戏的封面图片，前端游戏卡片优先使用
func (h *Handler) handleCover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "方法不支持", http.StatusMethodNotAllowed)
		return
	}
	id := r.URL.Query().Get("id")
	if !game.ValidGameID(id) {
		http.Error(w, "非法的游戏路径", http.StatusBadRequest)
		return
	}
	h.games.ServeCover(w, r, id)
}

// writeJSON 输出一条 JSON 响应
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

// StaticFS 从磁盘打开前端目录，不把网页资源嵌入服务端二进制
func StaticFS(dir string) (fs.FS, error) {
	if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
		return nil, err
	}
	return os.DirFS(dir), nil
}

// spaHandler 提供前端静态资源，未知路径回落到首页
type spaHandler struct {
	fsys     fs.FS  // 前端静态资源文件系统
	basePath string // 页面部署前缀，用于注入 HTML 的 base 标签
}

// ServeHTTP 输出静态文件或回落首页
func (h spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "方法不支持", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" || name == "." {
		name = "index.html"
	}
	f, err := h.fsys.Open(name)
	if err != nil {
		h.serveIndex(w, r)
		return
	}
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		_ = f.Close()
		h.serveIndex(w, r)
		return
	}
	defer f.Close()
	// 入口页面不缓存，其余静态资源要求重新验证，便于开发期修改即时生效
	if name == "index.html" {
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f.(interface {
		Read([]byte) (int, error)
		Seek(int64, int) (int64, error)
	}))
}

// serveIndex 读取首页用于前端路由回退
func (h spaHandler) serveIndex(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(h.fsys, "index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if h.basePath != "" {
		// 子路径部署时让 HTML 内的相对 CSS、JS 和接口地址都继承该前缀
		basePath := html.EscapeString(h.basePath)
		data = bytes.Replace(data, []byte("<head>"), []byte("<head><base href=\""+basePath+"/\">"), 1)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}
