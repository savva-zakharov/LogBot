@echo off
setlocal enabledelayedexpansion

REM Runs the app in "server" mode (equivalent to --nowtscrape and --nowebserver)
REM Requires Node.js and npm. Uses nodemon via npx if available.

pushd "%~dp0"

IF EXIST package.json (
  echo Ensuring Node dependencies are up to date...
  call npm install
  call npm update
)

where npx >NUL 2>&1
if %ERRORLEVEL%==0 (
  npx nodemon index.js -- --server
) else (
  echo npx not found; starting without nodemon (auto-reload disabled).
  node index.js --server
)

popd
endlocal
