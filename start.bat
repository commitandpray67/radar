@echo off
setlocal enabledelayedexpansion

echo.
echo  ======================================
echo   CS2 Demo Radar - Windows Launcher
echo  ======================================
echo.

:: -------------------------------------------------------
:: Handle --stop flag
:: -------------------------------------------------------
if "%1"=="--stop" (
    echo Stopping CS2 Radar...
    taskkill /F /FI "WINDOWTITLE eq CS2Radar-Backend*" >nul 2>&1
    taskkill /F /FI "WINDOWTITLE eq CS2Radar-Frontend*" >nul 2>&1
    if exist "%~dp0.radar_pids.txt" del "%~dp0.radar_pids.txt"
    echo Stopped.
    goto :eof
)

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"
set "VENV=%BACKEND%\.venv"
set "PYTHON=%VENV%\Scripts\python.exe"
set "PIP=%VENV%\Scripts\pip.exe"
set "UVICORN=%VENV%\Scripts\uvicorn.exe"

:: -------------------------------------------------------
:: Check Python is installed
:: -------------------------------------------------------
where python >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: Python not found!
    echo.
    echo  Please install Python 3.11 from:
    echo  https://www.python.org/downloads/
    echo.
    echo  IMPORTANT: On the installer, check the box that says
    echo  "Add Python to PATH" before clicking Install Now.
    echo.
    pause
    exit /b 1
)

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo  [OK] Python %PYVER% found

:: -------------------------------------------------------
:: Check Node.js is installed
:: -------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: Node.js not found!
    echo.
    echo  Please install Node.js from:
    echo  https://nodejs.org/  (click the "LTS" version)
    echo.
    pause
    exit /b 1
)

for /f "tokens=1" %%v in ('node --version 2^>^&1') do set NODEVER=%%v
echo  [OK] Node.js %NODEVER% found

:: -------------------------------------------------------
:: Warn if no radar images
:: -------------------------------------------------------
set "MAPS_DIR=%FRONTEND%\public\maps"
set PNG_COUNT=0
for %%f in ("%MAPS_DIR%\*.png") do set /a PNG_COUNT+=1
if %PNG_COUNT%==0 (
    echo.
    echo  [!] No radar images found in frontend\public\maps\
    echo      The app will show a grid instead of the real map.
    echo      Copy *_radar.png files from your CS2 install there.
    echo.
) else (
    echo  [OK] Found %PNG_COUNT% radar image(s^)
)

:: -------------------------------------------------------
:: Create Python virtual environment if needed
:: -------------------------------------------------------
echo.
echo  Setting up Python backend...
if not exist "%VENV%" (
    echo  Creating virtual environment (first time only^)...
    python -m venv "%VENV%"
)

echo  Installing Python dependencies...
"%PIP%" install --quiet -r "%BACKEND%\requirements.txt"
if errorlevel 1 (
    echo  ERROR: Failed to install Python packages.
    echo  Check your internet connection and try again.
    pause
    exit /b 1
)
echo  [OK] Backend ready

:: -------------------------------------------------------
:: Install Node dependencies if needed
:: -------------------------------------------------------
echo.
echo  Setting up frontend...
if not exist "%FRONTEND%\node_modules" (
    echo  Installing npm packages (first time - may take a minute^)...
    npm --prefix "%FRONTEND%" install --silent
)
echo  [OK] Frontend ready

:: -------------------------------------------------------
:: Start backend in a new window
:: -------------------------------------------------------
echo.
echo  Starting backend on http://localhost:8000 ...
start "CS2Radar-Backend" /D "%BACKEND%" "%UVICORN%" main:app --host 0.0.0.0 --port 8000 --reload

:: Wait for backend to come up
echo  Waiting for backend to start...
:wait_backend
timeout /t 1 /nobreak >nul
curl -s http://localhost:8000/api/maps >nul 2>&1
if errorlevel 1 goto wait_backend
echo  [OK] Backend is running

:: -------------------------------------------------------
:: Start frontend in a new window
:: -------------------------------------------------------
echo  Starting frontend on http://localhost:5173 ...
start "CS2Radar-Frontend" /D "%FRONTEND%" cmd /c "npm run dev"

:: Wait for frontend
echo  Waiting for frontend to start...
:wait_frontend
timeout /t 2 /nobreak >nul
curl -s http://localhost:5173 >nul 2>&1
if errorlevel 1 goto wait_frontend
echo  [OK] Frontend is running

:: -------------------------------------------------------
:: Open browser
:: -------------------------------------------------------
echo.
echo  ======================================
echo   App is ready!
echo   Opening http://localhost:5173
echo  ======================================
echo.
echo  To stop: close the two command prompt
echo  windows, or run:  start.bat --stop
echo.
start "" "http://localhost:5173"

pause
