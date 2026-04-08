@echo off
setlocal enabledelayedexpansion
title CS2 Demo Radar - Launcher

set "ROOT=%~dp0"
set "LOG=%ROOT%start_log.txt"

:: Always write to log AND show on screen
call :log "================================================"
call :log " CS2 Demo Radar - Windows Launcher"
call :log " Log file: %LOG%"
call :log "================================================"
call :log ""

set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"
set "VENV=%BACKEND%\.venv"

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

call :log "      ERROR: Python not found in PATH."
call :log "      Install from https://www.python.org/downloads/"
call :log "      IMPORTANT: tick 'Add Python to PATH' in the installer."
call :err

:found_python

:: -------------------------------------------------------
:: Step 2: Find Node.js
:: -------------------------------------------------------
call :log "[2/5] Looking for Node.js..."
node --version >nul 2>&1
if errorlevel 1 (
    call :log "      ERROR: Node.js not found."
    call :log "      Install from https://nodejs.org/ (LTS version)"
    call :err
)
for /f "tokens=*" %%v in ('node --version 2^>^&1') do call :log "      Found: Node.js %%v"

:: -------------------------------------------------------
:: Step 3: Create venv and install Python packages
:: -------------------------------------------------------
call :log "[3/5] Setting up Python environment..."

if not exist "%VENV%" (
    call :log "      Creating virtual environment..."
    %PYTHON_CMD% -m venv "%VENV%" >> "%LOG%" 2>&1
    if errorlevel 1 (
        call :log "      ERROR: Could not create virtual environment."
        call :log "      This usually means Python is broken or not fully installed."
        call :err
    )
    call :log "      Virtual environment created."
)

set "PYTHON=%VENV%\Scripts\python.exe"
set "PIP=%VENV%\Scripts\pip.exe"
set "UVICORN=%VENV%\Scripts\uvicorn.exe"

call :log "      Installing Python packages (may take 1-2 min first time)..."
"%PIP%" install -r "%BACKEND%\requirements.txt" >> "%LOG%" 2>&1
if errorlevel 1 (
    call :log "      ERROR: pip install failed."
    call :log "      Check your internet connection."
    call :log "      See full error above in this log."
    call :err
)
call :log "      [OK] Python packages installed."

:: -------------------------------------------------------
:: Step 4: npm install
:: -------------------------------------------------------
call :log "[4/5] Setting up frontend..."

if not exist "%FRONTEND%\node_modules" (
    call :log "      Running npm install (may take 1-2 min first time)..."
    cd /d "%FRONTEND%"
    npm install >> "%LOG%" 2>&1
    if errorlevel 1 (
        call :log "      ERROR: npm install failed."
        call :log "      Check your internet connection."
        call :err
    )
    cd /d "%ROOT%"
)
call :log "      [OK] Frontend packages ready."

:: -------------------------------------------------------
:: Step 5: Kill leftovers on ports 8000 and 5173
:: -------------------------------------------------------
call :log "[5/5] Starting servers..."

call :log "      Freeing ports 8000 and 5173 if in use..."
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":8000 "') do (
    taskkill /F /PID %%p >nul 2>&1
)
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":5173 "') do (
    taskkill /F /PID %%p >nul 2>&1
)

:: -------------------------------------------------------
:: Start backend
:: -------------------------------------------------------
call :log "      Launching backend window..."
start "CS2Radar-Backend" cmd /k "title CS2Radar-Backend && cd /d "%BACKEND%" && "%UVICORN%" main:app --host 0.0.0.0 --port 8000 --reload"

call :log "      Waiting for backend on port 8000 (up to 30s)..."
set TRIES=0
:wait_backend
set /a TRIES+=1
if %TRIES% gtr 30 (
    call :log "      ERROR: Backend did not respond after 30 seconds."
    call :log "      Look at the CS2Radar-Backend window for the error."
    call :log "      Common cause: demoparser2 has no Windows binary."
    call :log "      See TROUBLESHOOTING section at bottom of this log."
    call :err
)
timeout /t 1 /nobreak >nul
"%PYTHON%" -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/maps', timeout=2)" >nul 2>&1
if errorlevel 1 goto :wait_backend
call :log "      [OK] Backend is running (try %TRIES%/30)"

:: -------------------------------------------------------
:: Start frontend
:: -------------------------------------------------------
call :log "      Launching frontend window..."
start "CS2Radar-Frontend" cmd /k "title CS2Radar-Frontend && cd /d "%FRONTEND%" && npm run dev"

call :log "      Waiting for frontend on port 5173 (up to 60s, first run compiles)..."
set TRIES=0
:wait_frontend
set /a TRIES+=1
if %TRIES% gtr 60 (
    call :log "      ERROR: Frontend did not respond after 60 seconds."
    call :log "      Look at the CS2Radar-Frontend window for the error."
    call :err
)
timeout /t 1 /nobreak >nul
"%PYTHON%" -c "import urllib.request; urllib.request.urlopen('http://localhost:5173', timeout=2)" >nul 2>&1
if errorlevel 1 goto :wait_frontend
call :log "      [OK] Frontend is running (try %TRIES%/60)"

:: -------------------------------------------------------
:: Success
:: -------------------------------------------------------
call :log ""
call :log "================================================"
call :log " SUCCESS - App is running!"
call :log " Open: http://localhost:5173"
call :log "================================================"
call :log ""
call :log " To stop: close the CS2Radar-Backend and"
call :log "          CS2Radar-Frontend windows."
call :log ""

start "" "http://localhost:5173"

echo.
echo  Log saved to: %LOG%
echo  Share this file if you need help debugging.
echo.
echo  Press any key to close this launcher...
pause >nul
goto :eof

:: -------------------------------------------------------
:: Helpers
:: -------------------------------------------------------

:log
echo %~1
echo %~1 >> "%LOG%"
goto :eof

:err
echo.
echo ================================================
echo  FAILED. Read the error above.
echo  Full log saved to:
echo  %LOG%
echo.
echo  Share that file for help debugging.
echo ================================================
echo.
echo  --- TROUBLESHOOTING ---
echo  If the error says "demoparser2":
echo    This package needs a Rust compiler on Windows.
echo    Try: pip install demoparser2 --pre
echo    Or open an issue for a pre-built wheel.
echo.
echo  If the error says "port in use":
echo    Open Task Manager, find python.exe or node.exe
echo    and End Task, then run start.bat again.
echo.
echo  Press any key to exit.
echo ================================================ >> "%LOG%"
pause >nul
exit /b 1
