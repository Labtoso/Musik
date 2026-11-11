#!/usr/bin/env bash
# Starts the Musik server from this folder (Linux/macOS). Needs Node.js 22.13 or newer.
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 22 is missing: https://nodejs.org" >&2; exit 1; }
[ -d node_modules ] || npm ci --omit=dev --no-audit --no-fund
[ -f .env ] || printf 'PORT=8484\nMUSIC_DIRS=%s\n' "$HOME/Music" > .env
exec node --disable-warning=ExperimentalWarning src/index.js
