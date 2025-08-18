@echo off
setlocal

REM Robust launcher that ensures cleanup via run-server.ps1
REM Explicitly call powershell.exe to avoid relying on .ps1 file associations
pushd "%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-server.ps1"
set "ERR=%ERRORLEVEL%"
popd

endlocal & exit /b %ERR%
