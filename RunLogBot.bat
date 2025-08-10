@echo off
setlocal ENABLEEXTENSIONS

REM Change to the directory of this script
pushd "%~dp0" >NUL 2>&1

REM Check Node.js presence
where node >NUL 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Please install Node.js from https://nodejs.org/ and try again.
  goto end
)

REM Install dependencies if node_modules is missing
if not exist "node_modules" (
  echo [INFO] Installing dependencies ^(this may take a while on first run^)
  if exist "package-lock.json" (
    call npm ci
  ) else (
    call npm install
  )
  if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install failed.
    goto end
  )
)

REM Start the app via npm start; if it fails, fallback to node index.js
echo [INFO] Starting War Thunder LogBot (npm start)
call npm start
if %ERRORLEVEL% NEQ 0 (
  echo [WARN] npm start failed, falling back to node index.js
  node index.js
)

:end
popd >NUL 2>&1
endlocal
