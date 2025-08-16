@echo off
setlocal enabledelayedexpansion

REM Runs the app in "client" mode (equivalent to --nodiscordbot and --nowebscrape)
REM Requires Node.js and npm. Uses nodemon via npx if available.

pushd "%~dp0"

IF EXIST package.json (
  echo Ensuring Node dependencies are up to date...
  call npm install
  call npm update
)

where npx >NUL 2>&1
if %ERRORLEVEL%==0 (
  npx nodemon index.js -- --client
) else (
  echo npx not found; starting without nodemon (auto-reload disabled)
  node index.js --client
)

popd
endlocal
