@echo off
setlocal
title The Horny Builder - setup
cd /d "%~dp0"
set "DATA=%LOCALAPPDATA%\3DX Editor"
set "VPY=%DATA%\venv\Scripts\python.exe"

echo.
echo  The Horny Builder - one-time setup
echo  ----------------------------------
echo  1. Gets the helper's Python packages ready.
echo  2. Reads the 3DXChat models from YOUR game (they stay on this PC).
echo  3. Puts a "The Horny Builder" shortcut on your desktop.
echo.

rem --- Python 3.10 or newer -------------------------------------------------
set "PY="
py -3 --version >nul 2>nul && set "PY=py -3"
if not defined PY python --version >nul 2>nul && set "PY=python"
if not defined PY goto nopython
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" || goto nopython

rem --- the helper's own Python environment ------------------------------------
if not exist "%VPY%" (
  echo Making the helper's Python environment...
  %PY% -m venv "%DATA%\venv" || goto failed
)
echo Installing packages (first time takes a minute)...
"%VPY%" -m pip install --disable-pip-version-check -q -r requirements.txt || goto failed

rem --- the game's models --------------------------------------------------------
echo.
echo Reading the 3DXChat models from your game (about a minute)...
"%VPY%" extract_models.py %1 && goto shortcut
echo.
echo The 3DXChat game folder wasn't found.
set /p "GAME=Drag your 3DXChat folder into this window and press Enter: "
"%VPY%" extract_models.py %GAME% || goto failed

:shortcut
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\The Horny Builder.lnk'); $s.TargetPath = '%~dp0Start.bat'; $s.WorkingDirectory = '%~dp0'; $s.Save()"
echo.
echo  All set. Start "The Horny Builder" from your desktop.
echo  After a 3DXChat update, run Setup.bat again to refresh the models.
echo.
pause
exit /b 0

:nopython
echo.
echo  Python 3.10 or newer is needed and wasn't found.
echo  Get it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"),
echo  then run Setup.bat again.
echo.
pause
exit /b 1

:failed
echo.
echo  Setup stopped with an error (see above). Please report it on GitHub:
echo  https://github.com/ToxicLizard99/the-horny-builder/issues
echo.
pause
exit /b 1
