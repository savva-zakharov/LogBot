#!/usr/bin/env bash
set -euo pipefail

# Runs the app in "client" mode:
# Equivalent to passing --nodiscordbot and --nowebscrape via index.js
# Requires Node.js and npm. Uses nodemon via npx (no global install required).

# Change to the directory of this script
cd "$(dirname "$0")"

# Ensure dependencies are up to date
if [ -f package.json ]; then
  echo "Ensuring Node dependencies are up to date..."
  npm install
  npm update || true
fi

# Prefer npx nodemon; if npx/nodemon unavailable, fall back to plain node
if command -v npx >/dev/null 2>&1; then
  exec npx nodemon index.js -- --client
else
  echo "npx not found; starting without nodemon (auto-reload disabled)." >&2
  exec node index.js --client
fi
