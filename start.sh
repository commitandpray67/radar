#!/usr/bin/env bash
# =============================================================================
# CS2 Demo Radar — one-shot start script
# Starts the FastAPI backend and the Vite frontend, then opens the browser.
#
# Usage:
#   ./start.sh           # starts both servers (default ports 8000 + 5173)
#   ./start.sh --prod    # builds frontend, serves everything from port 8000
#   ./start.sh --stop    # kills any running instances
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
PIDFILE="$SCRIPT_DIR/.radar_pids"
LOGFILE="$SCRIPT_DIR/.radar.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# --stop flag: kill previously started processes
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--stop" ]]; then
  if [[ -f "$PIDFILE" ]]; then
    echo -e "${YELLOW}Stopping CS2 Radar…${NC}"
    while IFS= read -r pid; do
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" && echo "  killed PID $pid"
      fi
    done < "$PIDFILE"
    rm -f "$PIDFILE"
    echo -e "${GREEN}Stopped.${NC}"
  else
    echo "No running instance found (no .radar_pids file)."
  fi
  exit 0
fi

echo -e "${BOLD}${CYAN}"
echo "  ██████╗███████╗██████╗      ██████╗  █████╗ ██████╗  █████╗ ██████╗ "
echo " ██╔════╝██╔════╝╚════██╗     ██╔══██╗██╔══██╗██╔══██╗██╔══██╗██╔══██╗"
echo " ██║     ███████╗ █████╔╝     ██████╔╝███████║██║  ██║███████║██████╔╝"
echo " ██║     ╚════██║██╔═══╝      ██╔══██╗██╔══██║██║  ██║██╔══██║██╔══██╗"
echo " ╚██████╗███████║███████╗     ██║  ██║██║  ██║██████╔╝██║  ██║██║  ██║"
echo "  ╚═════╝╚══════╝╚══════╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝"
echo -e "${NC}"
echo -e " CS2 Demo Radar  —  startup script"
echo ""

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------
check_dep() {
  if ! command -v "$1" &>/dev/null; then
    echo -e "${RED}Error: '$1' not found. $2${NC}"
    exit 1
  fi
}
check_dep python3 "Install Python 3.11+ from https://python.org"
check_dep node    "Install Node.js 18+ from https://nodejs.org"
check_dep npm     "Install Node.js 18+ (npm comes with it)"

# ---------------------------------------------------------------------------
# Radar image check
# ---------------------------------------------------------------------------
MAPS_DIR="$FRONTEND_DIR/public/maps"
PNG_COUNT=$(find "$MAPS_DIR" -name "*.png" 2>/dev/null | wc -l)
if [[ "$PNG_COUNT" -eq 0 ]]; then
  echo -e "${YELLOW}⚠  No radar images found in frontend/public/maps/${NC}"
  echo "   The app will run with a placeholder grid until you add map images."
  echo "   Copy them from your CS2 install:"
  echo "   game/csgo/resource/overviews/<mapname>_radar.png → frontend/public/maps/"
  echo ""
else
  echo -e "${GREEN}✓  Found $PNG_COUNT radar image(s)${NC}"
fi

# ---------------------------------------------------------------------------
# Backend: create venv if needed and install dependencies
# ---------------------------------------------------------------------------
echo -e "${CYAN}▶  Setting up Python backend…${NC}"

VENV="$BACKEND_DIR/.venv"
if [[ ! -d "$VENV" ]]; then
  echo "   Creating virtual environment…"
  python3 -m venv "$VENV"
fi

PYTHON="$VENV/bin/python"
PIP="$VENV/bin/pip"

# Install / upgrade deps quietly
"$PIP" install --quiet --upgrade pip 2>/dev/null || true
"$PIP" install --quiet -r "$BACKEND_DIR/requirements.txt"
echo -e "${GREEN}✓  Backend dependencies ready${NC}"

# ---------------------------------------------------------------------------
# Frontend: install npm deps if needed
# ---------------------------------------------------------------------------
echo -e "${CYAN}▶  Setting up frontend…${NC}"
if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo "   Running npm install (first run — may take a minute)…"
  npm --prefix "$FRONTEND_DIR" install --silent
fi

# ---------------------------------------------------------------------------
# Production build mode
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--prod" ]]; then
  echo -e "${CYAN}▶  Building frontend for production…${NC}"
  npm --prefix "$FRONTEND_DIR" run build
  echo -e "${GREEN}✓  Frontend built to frontend/dist/${NC}"
  echo ""
  echo -e "${CYAN}▶  Starting backend (serves built frontend at http://localhost:8000)…${NC}"
  cd "$BACKEND_DIR"
  "$PYTHON" main.py
  exit 0
fi

echo -e "${GREEN}✓  Frontend dependencies ready${NC}"

# ---------------------------------------------------------------------------
# Kill any leftover processes on our ports
# ---------------------------------------------------------------------------
for port in 8000 5173; do
  pid=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -n "$pid" ]]; then
    echo -e "${YELLOW}  Killing existing process on port $port (PID $pid)…${NC}"
    kill "$pid" 2>/dev/null || true
    sleep 0.5
  fi
done

# ---------------------------------------------------------------------------
# Start backend
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}▶  Starting FastAPI backend on http://localhost:8000 …${NC}"
cd "$BACKEND_DIR"
"$VENV/bin/uvicorn" main:app \
  --host 0.0.0.0 \
  --port 8000 \
  --reload \
  --reload-dir "$BACKEND_DIR" \
  >> "$LOGFILE" 2>&1 &
BACKEND_PID=$!
echo "   PID $BACKEND_PID"

# Wait for backend to be ready
echo -n "   Waiting for backend"
for i in $(seq 1 30); do
  if curl -s http://localhost:8000/api/maps >/dev/null 2>&1; then
    echo -e " ${GREEN}ready${NC}"
    break
  fi
  echo -n "."
  sleep 0.5
done

# ---------------------------------------------------------------------------
# Start frontend dev server
# ---------------------------------------------------------------------------
echo -e "${CYAN}▶  Starting Vite frontend on http://localhost:5173 …${NC}"
npm --prefix "$FRONTEND_DIR" run dev -- --host \
  >> "$LOGFILE" 2>&1 &
FRONTEND_PID=$!
echo "   PID $FRONTEND_PID"

# Save PIDs for --stop
echo "$BACKEND_PID" > "$PIDFILE"
echo "$FRONTEND_PID" >> "$PIDFILE"

# Wait for Vite to be ready
echo -n "   Waiting for frontend"
for i in $(seq 1 30); do
  if curl -s http://localhost:5173 >/dev/null 2>&1; then
    echo -e " ${GREEN}ready${NC}"
    break
  fi
  echo -n "."
  sleep 0.5
done

# ---------------------------------------------------------------------------
# Open browser
# ---------------------------------------------------------------------------
URL="http://localhost:5173"
echo ""
echo -e "${BOLD}${GREEN}✓  CS2 Demo Radar is running!${NC}"
echo ""
echo -e "   App:      ${BOLD}$URL${NC}"
echo -e "   API docs: http://localhost:8000/docs"
echo -e "   Logs:     $LOGFILE"
echo ""
echo -e "   ${YELLOW}Press Ctrl+C to stop both servers${NC}"
echo -e "   ${YELLOW}Or run: ./start.sh --stop${NC}"
echo ""

# Try to open browser
for opener in xdg-open open; do
  if command -v "$opener" &>/dev/null; then
    "$opener" "$URL" 2>/dev/null &
    break
  fi
done

# ---------------------------------------------------------------------------
# Keep running and forward Ctrl+C to children
# ---------------------------------------------------------------------------
cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down…${NC}"
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo -e "${GREEN}Stopped.${NC}"
  exit 0
}
trap cleanup INT TERM

# Tail the log so output is visible
tail -f "$LOGFILE" &
TAIL_PID=$!
wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
kill "$TAIL_PID" 2>/dev/null || true
