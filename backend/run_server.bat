@echo off
:: Helper script that runs the backend uvicorn server.
:: Logs all output to logs\backend.log so this can be launched either
:: visibly (double-click, for debugging) or hidden from start.bat.
:: --reload is intentionally OMITTED: live-reload causes WatchFiles to
:: restart the server mid-parse (triggered by scipy/pandas imports inside
:: .venv), killing the SSE stream and failing every upload.
title CS2Radar-Backend
cd /d "%~dp0"
if not exist logs mkdir logs
echo  [Backend] Starting uvicorn on http://localhost:8000
echo  [Backend] Logs: logs\backend.log
echo.
.venv\Scripts\uvicorn.exe main:app --host 0.0.0.0 --port 8000 >> logs\backend.log 2>&1
echo.
echo  [Backend] Server stopped. Press any key to close.
pause >nul
