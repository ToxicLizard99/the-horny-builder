@echo off
title The Horny Builder - helper (keep this window open)
cd /d "%~dp0"
set "VPY=%LOCALAPPDATA%\3DX Editor\venv\Scripts\python.exe"
if not exist "%VPY%" (
  echo Run Setup.bat first.
  pause
  exit /b 1
)
"%VPY%" server.py
pause
