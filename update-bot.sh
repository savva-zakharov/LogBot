#!/bin/bash
set -e

# Ensure we are in the project directory where this script resides
cd "$(dirname "$0")"

echo "[update-bot] Fetching latest refs from remote..."
git fetch --all --prune

echo "[update-bot] Switching to main branch..."
git checkout main

echo "[update-bot] Resetting to match origin/main..."
git reset --hard origin/main

echo "[update-bot] Installing npm packages..."
npm install

echo "[update-bot] Done."
exit 0
