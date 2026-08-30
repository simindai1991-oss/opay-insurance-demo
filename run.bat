@echo off
cd /d "%~dp0"
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python -m uvicorn server.app:app --reload --host 127.0.0.1 --port 8787
) else (
  echo Python not found on PATH. Activate your conda/venv then run:
  echo   python -m uvicorn server.app:app --reload --host 127.0.0.1 --port 8787
  exit /b 1
)
