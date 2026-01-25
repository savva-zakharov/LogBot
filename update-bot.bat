@echo off
setlocal ENABLEDELAYEDEXPANSION

REM Ensure we are in the project directory where this script resides
cd /d "%~dp0"

echo [update-bot] Fetching latest refs from remote...
git fetch --all --prune
if errorlevel 1 (
  echo [update-bot] git fetch failed. Check your network or git remotes.
  goto :end
)

echo [update-bot] Switching to main branch...
git checkout main
if errorlevel 1 (
  echo [update-bot] git checkout main failed.
  goto :end
)

echo [update-bot] Resetting to match origin/main...
git reset --hard origin/main
if errorlevel 1 (
  echo [update-bot] git reset failed.
  goto :end
)

echo [update-bot] Installing npm packages...
call npm install
if errorlevel 1 (
  echo [update-bot] npm install encountered errors.
  goto :end
)



:end
echo [update-bot] Done.
endlocal
exit /b 0