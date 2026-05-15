@echo off
:: Helper script that runs the Vite dev server.
:: Logs all output to logs\frontend.log so this can be launched either
:: visibly (double-click, for debugging) or hidden from start.bat.
title CS2Radar-Frontend
cd /d "%~dp0"
if not exist logs mkdir logs
echo  [Frontend] Starting Vite on http://localhost:5173
echo  [Frontend] Logs: logs\frontend.log
echo.
call npm run dev >> logs\frontend.log 2>&1
echo.
echo  [Frontend] Server stopped. Press any key to close.
pause >nul
