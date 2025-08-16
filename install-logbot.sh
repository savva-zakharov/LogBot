#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/savva-zakharov/LogBot"
CLONE_DIR="${1:-$HOME/LogBot}"

need_cmd() { command -v "$1" >/dev/null 2>&1; }

detect_pkg_manager() {
  if need_cmd apt-get; then echo "apt"; return
  elif need_cmd dnf; then echo "dnf"; return
  elif need_cmd yum; then echo "yum"; return
  elif need_cmd zypper; then echo "zypper"; return
  elif need_cmd pacman; then echo "pacman"; return
  elif need_cmd apk; then echo "apk"; return
  else echo "unknown"; return
  fi
}

install_requirements() {
  local pm="$1"
  echo "Using package manager: $pm"
  case "$pm" in
    apt)
      sudo apt-get update -y
      sudo apt-get install -y ca-certificates curl gnupg git
      # Install Node.js 20.x via NodeSource for current LTS
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
      ;;
    dnf)
      sudo dnf -y install git curl
      # Prefer distro module for Node.js 20 if available
      if dnf module list nodejs -y >/dev/null 2>&1; then
        sudo dnf module enable nodejs:20 -y || true
        sudo dnf install -y nodejs
      else
        # Fallback to NodeSource
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo dnf install -y nodejs
      fi
      ;;
    yum)
      sudo yum -y install git curl
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
      sudo yum install -y nodejs
      ;;
    zypper)
      sudo zypper refresh
      sudo zypper install -y git curl
      # Package names vary; try nodejs20 then fallback to nodejs + npm
      if sudo zypper install -y nodejs20 npm20; then :; else
        sudo zypper install -y nodejs npm
      fi
      ;;
    pacman)
      sudo pacman -Sy --noconfirm git nodejs npm
      ;;
    apk)
      sudo apk add --no-cache git nodejs npm
      ;;
    *)
      echo "Unsupported/unknown package manager. Please install git and Node.js 20+ manually, then re-run."
      exit 1
      ;;
  esac
}

clone_or_update_repo() {
  local dir="$1"
  if [ -d "$dir/.git" ]; then
    echo "Repository exists at $dir; updating..."
    git -C "$dir" fetch --all --prune
    git -C "$dir" reset --hard origin/main || git -C "$dir" reset --hard origin/master || true
  else
    echo "Cloning repository into $dir..."
    mkdir -p "$(dirname "$dir")"
    git clone "$REPO_URL" "$dir"
  fi
}

install_node_deps() {
  local dir="$1"
  cd "$dir"
  echo "Installing Node dependencies..."
  # Prefer clean install if package-lock.json exists
  if [ -f package-lock.json ]; then
    npm install
  else
    npm install
  fi
  echo "Running npm update (as requested)..."
  npm update
}

main() {
  local pm
  pm="$(detect_pkg_manager)"
  install_requirements "$pm"
  clone_or_update_repo "$CLONE_DIR"
  install_node_deps "$CLONE_DIR"

  echo
  echo "✅ LogBot installed/updated in: $CLONE_DIR"
  echo "Next steps:"
  echo "  - Configure your settings in settings.json or use your existing workflow."
  echo "  - To start the bot, from the repo directory run: node index.js"
  echo
}

main "$@"