// NES 在线对战平台服务启动入口
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strconv"
	"strings"
	"syscall"
	"time"

	"nesbattle/api"
	"nesbattle/game"
)

// main 加载配置，启动 HTTP 与 WebSocket 服务并处理优雅关闭
func main() {
	config, err := loadConfig("config.json")
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}
	assets, err := api.StaticFS(config.Frontend)
	if err != nil {
		log.Fatalf("加载前端资源失败: %v", err)
	}
	if err := checkRoms(config.Roms); err != nil {
		log.Fatalf("检查游戏目录失败: %v", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	hub := game.NewHub()
	go hub.Run(ctx)
	srv := &http.Server{
		Addr:              config.listenAddr(),
		Handler:           api.NewHandler(assets, config.BasePath, config.Roms, hub),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	log.Printf("NES 对战平台已运行: http://%s/", config.displayHost())
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("服务退出: %v", err)
	}
	log.Print("已停止")
}

// config 保存服务监听、前端资源、ROM 目录与可选子路由前缀
type config struct {
	Host     string `json:"host"`     // HTTP 监听主机
	Port     int    `json:"port"`     // HTTP 监听端口
	Frontend string `json:"frontend"` // 前端静态资源目录
	Roms     string `json:"roms"`     // NES 游戏文件目录
	BasePath string `json:"basePath"` // 站点子路由前缀
}

// loadConfig 读取并校验服务启动配置
func loadConfig(file string) (config, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return config{}, err
	}
	var c config
	if err := json.Unmarshal(data, &c); err != nil {
		return config{}, err
	}
	if strings.TrimSpace(c.Host) == "" {
		return config{}, errors.New("host 不能为空")
	}
	if c.Port < 1 || c.Port > 65535 {
		return config{}, errors.New("port 必须在 1 到 65535 之间")
	}
	if strings.TrimSpace(c.Frontend) == "" {
		return config{}, errors.New("frontend 不能为空")
	}
	if strings.TrimSpace(c.Roms) == "" {
		return config{}, errors.New("roms 不能为空")
	}
	basePath, err := normalizeBasePath(c.BasePath)
	if err != nil {
		return config{}, err
	}
	c.BasePath = basePath
	return c, nil
}

// listenAddr 返回 HTTP 服务使用的主机和端口地址
func (c config) listenAddr() string {
	return net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
}

// displayHost 返回日志展示用的访问地址
func (c config) displayHost() string {
	host := c.Host
	if host == "" || host == "0.0.0.0" {
		host = "localhost"
	}
	return net.JoinHostPort(host, strconv.Itoa(c.Port))
}

// normalizeBasePath 将配置中的子路由整理为无结尾斜杠的绝对路径
func normalizeBasePath(basePath string) (string, error) {
	basePath = strings.TrimSpace(basePath)
	if basePath == "" || basePath == "/" {
		return "", nil
	}
	if !strings.HasPrefix(basePath, "/") || strings.Contains(basePath, "\\") {
		return "", fmt.Errorf("basePath 必须是以 / 开头的路径: %q", basePath)
	}
	basePath = path.Clean(basePath)
	if basePath == "/" || basePath == "." {
		return "", nil
	}
	return basePath, nil
}

// checkRoms 确认 ROM 目录存在，不存在时自动创建并提示
func checkRoms(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	count := 0
	for _, e := range entries {
		if strings.EqualFold(path.Ext(e.Name()), ".nes") {
			count++
		}
	}
	if count == 0 {
		log.Printf("提示: 目录 %s 中还没有 .nes 游戏文件，请放入 ROM 后重启", dir)
	}
	return nil
}
