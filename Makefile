# CS2 Demo Radar — convenience targets
# Run with: make <target>

PYTHON     := backend/.venv/bin/python
UVICORN    := backend/.venv/bin/uvicorn
FRONTEND   := frontend

.PHONY: start stop build setup test help

## Default: start dev mode
start: setup
	@./start.sh

## Build & run in production mode (single port 8000)
prod: setup
	@./start.sh --prod

## Stop all running instances
stop:
	@./start.sh --stop

## Install all dependencies
setup:
	@echo "Setting up Python backend…"
	@cd backend && python3 -m venv .venv 2>/dev/null || true
	@backend/.venv/bin/pip install --quiet -r backend/requirements.txt
	@echo "Setting up frontend…"
	@npm --prefix $(FRONTEND) install --silent
	@echo "Done."

## Build the frontend bundle
build:
	@npm --prefix $(FRONTEND) run build

## Run the test suite
test:
	@cd backend && .venv/bin/pytest -v

## Run only backend (no frontend)
backend-only:
	@cd backend && $(UVICORN) main:app --host 0.0.0.0 --port 8000 --reload

## Run only frontend dev server
frontend-only:
	@npm --prefix $(FRONTEND) run dev

## Show this help
help:
	@echo ""
	@echo "  CS2 Demo Radar"
	@echo ""
	@echo "  make start         Start dev servers (backend :8000, frontend :5173)"
	@echo "  make prod          Build + serve everything from :8000"
	@echo "  make stop          Kill running instances"
	@echo "  make setup         Install all dependencies"
	@echo "  make build         Build frontend bundle"
	@echo "  make test          Run backend test suite"
	@echo "  make backend-only  Backend only"
	@echo "  make frontend-only Frontend only"
	@echo ""
