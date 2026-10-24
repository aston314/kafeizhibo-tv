package server

import (
	"context"
	"errors"
	"net"
	"net/http"
)

func upstreamFailure(source string, err error) (int, string) {
	label := "咖啡直播"
	if source == "doubao" {
		label = "豆包直播"
	}
	var networkError net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkError) && networkError.Timeout()) {
		return http.StatusGatewayTimeout, label + "连接超时，请重试"
	}
	return http.StatusBadGateway, label + "暂时连接失败，请重试"
}

func writeUpstreamError(w http.ResponseWriter, source string, err error) {
	status, message := upstreamFailure(source, err)
	writeJSON(w, status, map[string]interface{}{"success": false, "code": status, "message": message})
}
