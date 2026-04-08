@echo off
:: Helper script launched by start.bat to run the backend server.
:: Lives in the backend\ folder so paths are always relative and unambiguous.
title CS2Radar-Backend
cd /d "%~dp0"
echo  [Backend] Starting uvicorn on http://localhost:8000
echo  [Backend] Keep this window open. Close it to stop the server.
echo.
::  --reload-dir restricts watchfiles to source folders only.
::  Without this, uvicorn watches .venv too and restarts the server
::  every time Python imports timezone data (tzdata), killing SSE streams.
.venv\Scripts\uvicorn.exe main:app --host 0.0.0.0 --port 8000 ^
    --reload ^
    --reload-dir api ^
    --reload-dir analytics ^
    --reload-dir db ^
    --reload-dir maps ^
    --reload-dir parser
echo.
echo  [Backend] Server stopped. Press any key to close.
pause >nul
