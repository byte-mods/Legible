#!/usr/bin/env bash
#
# Start Legible and put a public https:// URL in front of it.
#
# The app stays on this Mac, so the Claude/Codex CLIs and the `say` narration
# voices keep working — Cloudflare only forwards traffic to it. The URL lives
# as long as this script runs.
#
#   ./host.sh              public URL (Cloudflare quick tunnel)
#   ./host.sh --local      this machine only, no auth, no tunnel
#   ./host.sh --lan        your Wi-Fi only, password on, no tunnel
#
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-4317}"
MODE="${1:---public}"

cleanup() {
  echo ""
  echo "  shutting down…"
  [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${AWAKE_PID:-}" ]] && kill "$AWAKE_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# a stale server on the port would silently win the bind
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "  port $PORT was busy — stopping the old instance"
  kill "$(lsof -ti:"$PORT")" 2>/dev/null || true
  sleep 1
fi

case "$MODE" in
  --local)
    HOST=127.0.0.1 PORT="$PORT" node server/index.js
    ;;

  --lan)
    HOST=0.0.0.0 PORT="$PORT" node server/index.js &
    SERVER_PID=$!
    sleep 2
    IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo localhost)"
    echo ""
    echo "  On this Wi-Fi:  http://$IP:$PORT"
    echo "  Password is in data/ACCESS.txt the first time."
    echo ""
    wait "$SERVER_PID"
    ;;

  --public)
    command -v cloudflared >/dev/null || {
      echo "  cloudflared is not installed.  brew install cloudflared" >&2
      exit 1
    }

    DR_PUBLIC=1 HOST=0.0.0.0 PORT="$PORT" node server/index.js &
    SERVER_PID=$!
    sleep 3

    LOG="$(mktemp -t dr_tunnel)"
    # QUIC (UDP 7844) is blocked on many corporate networks; http2 survives those
    cloudflared tunnel --url "http://localhost:$PORT" --protocol http2 >"$LOG" 2>&1 &
    TUNNEL_PID=$!

    # the Mac going to sleep takes the URL down with it
    caffeinate -s -w $$ &
    AWAKE_PID=$!

    echo "  opening a tunnel…"
    for _ in $(seq 1 40); do
      URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
      [[ -n "$URL" ]] && break
      sleep 1
    done

    if [[ -z "${URL:-}" ]]; then
      echo "  the tunnel did not come up — see $LOG" >&2
      cleanup
    fi

    echo ""
    echo "  ┌──────────────────────────────────────────────────────────┐"
    printf "  │  %-54s  │\n" "$URL"
    echo "  └──────────────────────────────────────────────────────────┘"
    echo ""
    echo "  Password: data/ACCESS.txt (first run only — then change it in Settings)"
    echo "  This Mac will stay awake while the tunnel is up. Ctrl-C to stop."
    echo ""
    wait "$SERVER_PID"
    ;;

  *)
    echo "usage: ./host.sh [--public|--lan|--local]" >&2
    exit 1
    ;;
esac
