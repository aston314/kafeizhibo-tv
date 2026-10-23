package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	product "cc.kafeizhibo.tv"
	"cc.kafeizhibo.tv/core/internal/server"
)

var buildVersion string

func main() {
	port := flag.Int("port", 0, "loopback port")
	instance := flag.String("instance-id", "desktop", "runtime identity")
	fixture := flag.Bool("fixture", false, "serve deterministic data")
	flag.Parse()
	listener, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(*port))
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	version := buildVersion
	if version == "" {
		version = product.Load().VersionName + "-dev"
	}
	core := server.New(product.Load(), version, *instance, *fixture)
	httpServer := &http.Server{Handler: core, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 45 * time.Second}
	fmt.Printf("KAFEI_TV_READY %d %s\n", listener.Addr().(*net.TCPAddr).Port, *instance)
	go func() { <-ctx.Done(); _ = httpServer.Close() }()
	if err := httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
