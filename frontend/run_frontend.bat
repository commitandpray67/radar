@echo off
:: Helper script launched by start.bat to run the Vite dev server.
:: Lives in the frontend\ folder so paths are always relative and unambiguous.
title CS2Radar-Frontend
cd /d "%~dp0"
echo  [Frontend] Starting Vite on http://localhost:5173
echo  [Frontend] Keep this window open. Close it to stop the app.
echo.
npm run dev
echo.
echo  [Frontend] Server stopped. Press any key to close.
pause >nul
