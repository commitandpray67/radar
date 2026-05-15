@echo off
setlocal enabledelayedexpansion
title CS2 Demo Radar - Launcher

set "ROOT=%~dp0"
set "LOG=%ROOT%start_log.txt"

call :log "================================================"
call :log " CS2 Demo Radar - Windows Launcher"
call :log " Log file: %LOG%"
call :log "================================================"
call :log ""

set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"
set "VENV=%BACKEND%\.venv"
set "BACKEND_LOG=%BACKEND%\logs\backend.log"
set "FRONTEND_LOG=%FRONTEND%\logs\frontend.log"

:: -------------------------------------------------------
:: Step 1: Find Python
:: -------------------------------------------------------
call :log "[1/5] Looking for Python..."
set "PYTHON_CMD="

python --version >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_CMD=python"
    for /f "tokens=*" %%v in ('python --version 2^>^&1') do call :log "      Found: %%v"
    goto :found_python
)
py --version >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_CMD=py"
    for /f "tokens=*" %%v in ('py --version 2^>^&1') do call :log "      Found: %%v"
    goto :found_python
)
call :log "      ERROR: Python not found. Install from https://www.python.org/downloads/"
call :log "             Tick 'Add Python to PATH' in the installer!"
call :err
:found_python

:: -------------------------------------------------------
:: Step 2: Find Node.js
:: -------------------------------------------------------
call :log "[2/5] Looking for Node.js..."
node --version >nul 2>&1
if errorlevel 1 (
    call :log "      ERROR: Node.js not found. Install from https://nodejs.org/ (LTS)"
    call :err
)
for /f "tokens=*" %%v in ('node --version 2^>^&1') do call :log "      Found: Node.js %%v"

:: -------------------------------------------------------
:: Step 3: Python venv + packages
:: -------------------------------------------------------
call :log "[3/5] Setting up Python environment..."

if not exist "%VENV%" (
    call :log "      Creating virtual environment..."
    %PYTHON_CMD% -m venv "%VENV%" >> "%LOG%" 2>&1
    if errorlevel 1 (
        call :log "      ERROR: Could not create virtual environment."
        call :err
    )
)

set "PYTHON=%VENV%\Scripts\python.exe"
set "PIP=%VENV%\Scripts\pip.exe"

call :log "      Installing Python packages (1-2 min first time)..."
"%PIP%" install -q -r "%BACKEND%\requirements.txt" >> "%LOG%" 2>&1
if errorlevel 1 (
    call :log "      ERROR: pip install failed. Check internet connection."
    call :err
)
call :log "      [OK] Python packages ready."

:: -------------------------------------------------------
:: Step 4: npm install
:: -------------------------------------------------------
call :log "[4/5] Setting up frontend..."

if not exist "%FRONTEND%\node_modules" (
    call :log "      Running npm install (1-2 min first time)..."
    cd /d "%FRONTEND%"
    npm install >> "%LOG%" 2>&1
    if errorlevel 1 (
        call :log "      ERROR: npm install failed."
        call :err
    )
    cd /d "%ROOT%"
)
call :log "      [OK] Frontend packages ready."

:: -------------------------------------------------------
:: Step 5: Kill leftovers, start servers (hidden)
:: -------------------------------------------------------
call :log "[5/5] Starting servers..."

:: Free ports if something is already using them.
call :log "      Freeing ports 8000 and 5173..."
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":8000 "') do (
    if not "%%p"=="" taskkill /F /PID %%p >nul 2>&1
)
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":5173 "') do (
    if not "%%p"=="" taskkill /F /PID %%p >nul 2>&1
)
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8000,5173 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 2 /nobreak >nul

:: Make sure log dirs exist
if not exist "%BACKEND%\logs"  mkdir "%BACKEND%\logs"  >nul 2>&1
if not exist "%FRONTEND%\logs" mkdir "%FRONTEND%\logs" >nul 2>&1

:: Start backend HIDDEN — run_server.bat logs to backend\logs\backend.log itself
call :log "      Starting backend (hidden, log: backend\logs\backend.log)..."
powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath '%BACKEND%\.venv\Scripts\uvicorn.exe' -ArgumentList 'main:app','--host','0.0.0.0','--port','8000' -WorkingDirectory '%BACKEND%' -RedirectStandardOutput '%BACKEND%\logs\backend.log' -RedirectStandardError '%BACKEND%\logs\backend.err'"
if errorlevel 1 (
    call :log "      ERROR: Could not launch backend."
    call :err
)

:: Wait up to 30s for backend
call :log "      Waiting for backend (up to 30s)..."
set TRIES=0
:wait_backend
set /a TRIES+=1
if %TRIES% gtr 30 (
    call :log "      ERROR: Backend never responded after 30 seconds."
    call :log "      Check the backend log: %BACKEND_LOG%"
    call :err
)
timeout /t 1 /nobreak >nul
"%PYTHON%" -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/maps', timeout=2)" >nul 2>&1
if errorlevel 1 goto :wait_backend
call :log "      [OK] Backend running (after %TRIES%s)"

:: Start frontend HIDDEN — npm.cmd is a batch shim, so wrap it in cmd /c with
:: redirection. Using ^ to escape > and & so batch parses them correctly.
call :log "      Starting frontend (hidden, log: frontend\logs\frontend.log)..."
powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList '/c','npm run dev ^> logs\frontend.log 2^>^&1' -WorkingDirectory '%FRONTEND%'"
if errorlevel 1 (
    call :log "      ERROR: Could not launch frontend."
    call :err
)

:: Wait up to 60s for frontend (Vite first-compile is slow)
call :log "      Waiting for frontend (up to 60s, first run compiles code)..."
set TRIES=0
:wait_frontend
set /a TRIES+=1
if %TRIES% gtr 60 (
    call :log "      ERROR: Frontend never responded after 60 seconds."
    call :log "      Check the frontend log: %FRONTEND_LOG%"
    call :err
)
timeout /t 1 /nobreak >nul
"%PYTHON%" -c "import urllib.request; urllib.request.urlopen('http://localhost:5173', timeout=2)" >nul 2>&1
if errorlevel 1 goto :wait_frontend
call :log "      [OK] Frontend running (after %TRIES%s)"

:: -------------------------------------------------------
:: Done
:: -------------------------------------------------------
call :log ""
call :log "================================================"
call :log " SUCCESS - CS2 Demo Radar is running!"
call :log " URL: http://localhost:5173"
call :log "================================================"

start "" "http://localhost:5173"

echo.
echo  Backend log:  %BACKEND_LOG%
echo  Frontend log: %FRONTEND_LOG%
echo  Launcher log: %LOG%
echo.
echo  Press any key in THIS window to STOP the servers and exit.
echo  (Closing this window is the same as stopping.)
echo.
pause >nul

:: -------------------------------------------------------
:: Stop hidden servers on exit
:: -------------------------------------------------------
echo.
echo  Stopping servers...
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":8000 "') do (
    if not "%%p"=="" taskkill /F /PID %%p >nul 2>&1
)
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":5173 "') do (
    if not "%%p"=="" taskkill /F /PID %%p >nul 2>&1
)
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8000,5173 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
echo  Servers stopped.
timeout /t 1 /nobreak >nul
goto :eof

:: -------------------------------------------------------
:: Subroutines
:: -------------------------------------------------------
:log
echo %~1
echo %~1 >> "%LOG%"
goto :eof

:err
echo.
echo ================================================
echo  FAILED - see error above.
echo  Full log: %LOG%
echo  Share that file for help.
echo ================================================ >> "%LOG%"
echo.
pause >nul
exit /b 1
