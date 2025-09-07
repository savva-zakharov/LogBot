#!/bin/bash
set -e

# Ensure we are in the project directory where this script resides
cd "$(dirname "$0")"

echo "[update-bot] Fetching latest refs from remote..."
git fetch --all --prune

echo "[update-bot] Removing any local file changes..."
git reset --hard

echo "[update-bot] Pulling latest changes..."
git pull --ff-only

echo "[update-bot] Installing npm packages..."
npm install

echo "[update-bot] Done."
exit 0
