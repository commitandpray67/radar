@echo off
setlocal enabledelayedexpansion
title CS2 Demo Radar - Launcher

echo.
echo  ======================================
echo   CS2 Demo Radar - Windows Launcher
echo  ======================================
echo.

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"
set "VENV=%BACKEND%\.venv"

:: -------------------------------------------------------
:: Step 1: Find Python (try both "python" and "py")
:: -------------------------------------------------------
echo  [1/5] Checking Python...
set "PYTHON_CMD="

python --version >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_CMD=python"
    goto :found_python
)
py --version >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_CMD=py"
    goto :found_python
)

echo.
echo  ERROR: Python was not found!
echo.
echo  Fix: Go to https://www.python.org/downloads/
echo       Download and run the installer.
echo       On the FIRST screen of the installer, tick the checkbox:
echo       "Add Python to PATH"  ^<-- very important!
echo       Then click "Install Now".
echo.
echo  After installing, close this window and run start.bat again.
echo.
pause
exit /b 1

:found_python
for /f "tokens=*" %%v in ('%PYTHON_CMD% --version 2^>^&1') do echo  [OK] %%v

:: -------------------------------------------------------
:: Step 2: Find Node.js
:: -------------------------------------------------------
echo  [2/5] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: Node.js was not found!
    echo.
    echo  Fix: Go to https://nodejs.org/
    echo       Click the big "LTS" button to download.
    echo       Run the installer and click Next through everything.
    echo.
    echo  After installing, close this window and run start.bat again.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>^&1') do echo  [OK] Node.js %%v

:: -------------------------------------------------------
:: Step 3: Set up Python virtual environment
:: -------------------------------------------------------
echo  [3/5] Setting up Python environment...

if not exist "%VENV%" (
    echo        Creating virtual environment for the first time...
    %PYTHON_CMD% -m venv "%VENV%"
    if errorlevel 1 (
        echo.
        echo  ERROR: Could not create Python virtual environment.
        echo  Make sure Python installed correctly with "Add to PATH" checked.
        echo.
        pause
        exit /b 1
    )
)

set "PYTHON=%VENV%\Scripts\python.exe"
set "PIP=%VENV%\Scripts\pip.exe"
set "UVICORN=%VENV%\Scripts\uvicorn.exe"

echo        Installing Python packages (this takes ~1 min the first time)...
"%PIP%" install -q -r "%BACKEND%\requirements.txt" 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: Failed to install Python packages.
    echo  Check your internet connection is working, then try again.
    echo.
    pause
    exit /b 1
)
echo  [OK] Python packages ready

:: -------------------------------------------------------
:: Step 4: Set up frontend (npm)
:: -------------------------------------------------------
echo  [4/5] Setting up frontend...

if not exist "%FRONTEND%\node_modules" (
    echo        Installing JavaScript packages (this takes ~1 min the first time)...
    cd /d "%FRONTEND%"
    npm install
    if errorlevel 1 (
        echo.
        echo  ERROR: npm install failed.
        echo  Check your internet connection, then try again.
        echo.
        pause
        exit /b 1
    )
    cd /d "%ROOT%"
)
echo  [OK] Frontend packages ready

:: -------------------------------------------------------
:: Step 5: Start both servers
:: -------------------------------------------------------
echo  [5/5] Starting servers...
echo.

:: Kill anything already on these ports (in case of leftover processes)
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":8000 "') do (
    taskkill /F /PID %%p >nul 2>&1
)
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":5173 "') do (
    taskkill /F /PID %%p >nul 2>&1
)

:: Start backend in its own visible window
echo  Starting backend (http://localhost:8000)...
start "CS2Radar-Backend" cmd /k "title CS2Radar-Backend && cd /d "%BACKEND%" && "%UVICORN%" main:app --host 0.0.0.0 --port 8000 --reload"

:: Wait up to 30 seconds for backend
echo  Waiting for backend to start...
set BACKEND_READY=0
for /l %%i in (1,1,30) do (
    if !BACKEND_READY!==0 (
        timeout /t 1 /nobreak >nul
        "%PYTHON%" -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/maps')" >nul 2>&1
        if not errorlevel 1 set BACKEND_READY=1
    )
)

if %BACKEND_READY%==0 (
    echo.
    echo  ERROR: Backend did not start within 30 seconds.
    echo.
    echo  Look at the "CS2Radar-Backend" window that opened.
    echo  Read the red error text — it will say what went wrong.
    echo  Common fix: make sure no other program is using port 8000.
    echo.
    pause
    exit /b 1
)
echo  [OK] Backend is running

:: Start frontend in its own visible window
echo  Starting frontend (http://localhost:5173)...
start "CS2Radar-Frontend" cmd /k "title CS2Radar-Frontend && cd /d "%FRONTEND%" && npm run dev"

:: Wait up to 45 seconds for frontend (Vite first-compile takes longer)
echo  Waiting for frontend to start (first launch compiles code - up to 45s)...
set FRONTEND_READY=0
for /l %%i in (1,1,45) do (
    if !FRONTEND_READY!==0 (
        timeout /t 1 /nobreak >nul
    )
    if !FRONTEND_READY!==0 (
        "%PYTHON%" -c "import urllib.request; urllib.request.urlopen('http://localhost:5173')" >nul 2>&1
        if not errorlevel 1 set FRONTEND_READY=1
    )
)

if %FRONTEND_READY%==0 (
    echo.
    echo  ERROR: Frontend did not start within 45 seconds.
    echo.
    echo  Look at the "CS2Radar-Frontend" window that opened.
    echo  Read the error text there.
    echo.
    pause
    exit /b 1
)
echo  [OK] Frontend is running

:: -------------------------------------------------------
:: Done - open browser
:: -------------------------------------------------------
echo.
echo  ============================================
echo   SUCCESS!  CS2 Demo Radar is running.
echo  ============================================
echo.
echo   Open this in your browser if it doesn't open:
echo   --^>  http://localhost:5173
echo.
echo   Two windows are now running in the background:
echo     - CS2Radar-Backend  (the server)
echo     - CS2Radar-Frontend (the web app)
echo.
echo   To stop the app: close those two windows.
echo.

:: Open browser
start "" "http://localhost:5173"

echo  Press any key to close this launcher window...
pause >nul
