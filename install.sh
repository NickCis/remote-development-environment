#!/usr/bin/env bash
# Install remote-development-environment: npm install and optionally set up a systemd user service.
# Run from the project directory, or pass the project path as the first argument.
# Usage:
#   ./install.sh              # install in current directory
#   ./install.sh /path/to/app # install in given directory
#   ./install.sh --systemd   # install and set up systemd user service (uses current dir)
#   ./install.sh /path/to/app --systemd

set -e

INSTALL_DIR="${1:-.}"
if [[ "$INSTALL_DIR" == "--systemd" ]]; then
  INSTALL_DIR="."
  DO_SYSTEMD=1
else
  DO_SYSTEMD=0
  if [[ "$2" == "--systemd" ]]; then
    DO_SYSTEMD=1
  fi
fi

INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
CWD_PATH="${CWD:-$HOME}"
AUTH_FILE_PATH="${AUTH_FILE:-$HOME/.config/remote-development-environment-auth.json}"

echo "Installing in: $INSTALL_DIR"

# Node.js check
if ! command -v node &>/dev/null; then
  echo "Node.js is not installed or not in PATH." >&2
  echo "On Ubuntu, install with: sudo apt update && sudo apt install nodejs npm" >&2
  echo "Or use NodeSource / nvm for a recent LTS version." >&2
  exit 1
fi

cd "$INSTALL_DIR"
npm install

if [[ "$DO_SYSTEMD" -eq 1 ]]; then
  NODE_PATH="$(command -v node)"
  if [[ -z "$NODE_PATH" ]]; then
    echo "Could not find node in PATH for systemd service." >&2
    exit 1
  fi
  mkdir -p "$HOME/.config/systemd/user"
  SVC_FILE="$HOME/.config/systemd/user/remote-development-environment.service"
  echo "Service: cwd=$CWD_PATH, auth-file=$AUTH_FILE_PATH"
  sed -e "s|INSTALL_DIR|$INSTALL_DIR|g" -e "s|CWD_PATH|$CWD_PATH|g" -e "s|AUTH_FILE_PATH|$AUTH_FILE_PATH|g" -e "s|NODE_PATH|$NODE_PATH|g" \
    "$INSTALL_DIR/remote-development-environment.service" > "$SVC_FILE"
  echo "Installed user service: $SVC_FILE"
  systemctl --user daemon-reload
  echo ""
  echo "To enable and start the service (runs when you log in):"
  echo "  systemctl --user enable --now remote-development-environment"
  echo ""
  echo "To run the service without being logged in (linger):"
  echo "  loginctl enable-linger \$USER"
  echo "  systemctl --user enable --now remote-development-environment"
  echo ""
  echo "Useful commands:"
  echo "  systemctl --user status remote-development-environment"
  echo "  systemctl --user stop remote-development-environment"
  echo "  journalctl --user -u remote-development-environment -f"
fi

echo "Done."
