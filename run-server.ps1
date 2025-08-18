# Runs the app in "server" mode with robust cleanup of child processes
# Ensures the nodemon/node process tree is terminated if the window is closed.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Always operate from the script directory
try { Set-Location -Path $PSScriptRoot } catch {}

# Optional: ensure Node is present
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js is required but not found on PATH." -ForegroundColor Red
  exit 1
}

# Pick npx nodemon if available; otherwise fallback to plain node
$npx = Get-Command npx -ErrorAction SilentlyContinue

$processToRun = $null
$arguments = @()
if ($npx) {
  $processToRun = $npx.Source
  $arguments = @('nodemon','index.js','--','--server')
  Write-Host "Starting with nodemon via npx..." -ForegroundColor Cyan
} else {
  $processToRun = $node.Source
  $arguments = @('index.js','--server')
  Write-Host "npx not found; starting without nodemon (auto-reload disabled)" -ForegroundColor Yellow
}

# Start the process and ensure we kill the entire tree on script exit
$p = $null
try {
  $p = Start-Process -FilePath $processToRun -ArgumentList $arguments -PassThru -WindowStyle Normal
  Write-Host ("Started process PID={0}: {1} {2}" -f $p.Id, $processToRun, ($arguments -join ' ')) -ForegroundColor Green
  # Wait until it ends normally
  $p.WaitForExit()
}
finally {
  try {
    if ($p -and -not $p.HasExited) {
      Write-Host ("Stopping process tree for PID={0}..." -f $p.Id) -ForegroundColor Yellow
      # Kill entire tree (/T) and force (/F) to ensure no orphan remains
      Start-Process -FilePath "taskkill" -ArgumentList @('/PID', "$($p.Id)", '/T', '/F') -NoNewWindow -Wait | Out-Null
    }
  } catch {}
}
