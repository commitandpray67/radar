@echo off
REM -------------------------------------------------------------------------
REM  task_scheduler_setup.bat
REM  Registers a Windows Task Scheduler job that runs excel_to_whatsapp.py
REM  every day at 08:45.
REM
REM  Run this script ONCE as Administrator to set up the scheduled task.
REM  Edit START_TIME and PYTHON_PATH below before running.
REM -------------------------------------------------------------------------

set TASK_NAME=DailyExcelWhatsApp
set START_TIME=08:45
set PYTHON_PATH=C:\Python311\python.exe
set SCRIPT_PATH=%~dp0excel_to_whatsapp.py

echo Creating scheduled task "%TASK_NAME%" to run daily at %START_TIME% ...

schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "\"%PYTHON_PATH%\" \"%SCRIPT_PATH%\"" ^
  /sc DAILY ^
  /st %START_TIME% ^
  /f ^
  /rl HIGHEST

if %errorlevel% == 0 (
    echo.
    echo Task created successfully.
    echo To verify:  schtasks /query /tn "%TASK_NAME%"
    echo To delete:  schtasks /delete /tn "%TASK_NAME%" /f
) else (
    echo.
    echo ERROR: Could not create task. Make sure you are running as Administrator.
)

pause
