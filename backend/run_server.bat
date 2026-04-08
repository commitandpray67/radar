@echo off
:: Helper script launched by start.bat to run the backend server.
:: Lives in the backend\ folder so paths are always relative and unambiguous.
:: --reload is intentionally OMITTED: live-reload causes WatchFiles to
:: restart the server mid-parse (triggered by scipy/pandas imports inside
:: .venv), killing the SSE stream and failing every upload.
title CS2Radar-Backend
cd /d "%~dp0"
echo  [Backend] Starting uvicorn on http://localhost:8000
echo  [Backend] Keep this window open. Close it to stop the server.
echo  [Backend] Logs are written to: logs\backend.log
echo.
.venv\Scripts\uvicorn.exe main:app --host 0.0.0.0 --port 8000
echo.
echo  [Backend] Server stopped. Press any key to close.
pause >nul
