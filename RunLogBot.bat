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

REM Prefer nodemon for auto-restart if available
set "LOCAL_NODEMON=%~dp0node_modules\.bin\nodemon.cmd"
if exist "%LOCAL_NODEMON%" (
  echo [INFO] Starting War Thunder LogBot (nodemon - local)
  call "%LOCAL_NODEMON%" --watch index.js --watch src --watch settings.env --watch settings.json --watch restart.flag --ext js,json,env index.js
  goto end
)

where npx >NUL 2>&1
if %ERRORLEVEL% EQU 0 (
  echo [INFO] Starting War Thunder LogBot (npx nodemon)
  call npx nodemon --watch index.js --watch src --watch settings.env --watch settings.json --watch restart.flag --ext js,json,env index.js
  if %ERRORLEVEL% EQU 0 goto end
)



:end
popd >NUL 2>&1
endlocal
