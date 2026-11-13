#!/usr/bin/env bash
# Musik on ZimaOS or CasaOS: installs the app into the dashboard. Run again to update.
#   curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/zimaos.sh | bash
#   options: --port <port>   --music <folder with your songs>
set -euo pipefail

PORT=8484
MUSIC=/DATA/Media/Music
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --music) MUSIC="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

DIR=/DATA/AppData/musik
FILE="$DIR/docker-compose.yml"
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"

echo "==> Musik for ZimaOS"
$SUDO mkdir -p "$DIR/data" "$MUSIC"
curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/zimaos.yml | $SUDO tee "$FILE" >/dev/null
[ "$PORT" = 8484 ] || $SUDO sed -i "s/published: \"8484\"/published: \"$PORT\"/; s/port_map: \"8484\"/port_map: \"$PORT\"/" "$FILE"
[ "$MUSIC" = /DATA/Media/Music ] || $SUDO sed -i "s#source: /DATA/Media/Music#source: $MUSIC#" "$FILE"

if command -v casaos-cli >/dev/null 2>&1; then
  if casaos-cli app-management list apps 2>/dev/null | grep -qw musik; then
    echo "==> Musik is already installed: restarting it, which fetches the newest version."
    casaos-cli app-management apply musik -f "$FILE" >/dev/null 2>&1 || true
    casaos-cli app-management restart musik
  else
    echo "==> Installing into the dashboard"
    casaos-cli app-management install -f "$FILE"
  fi
elif command -v docker >/dev/null 2>&1; then
  echo "==> No casaos-cli here, starting with Docker"
  $SUDO docker compose -f "$FILE" up -d --force-recreate
else
  echo "Neither casaos-cli nor docker was found. Is this ZimaOS or CasaOS?" >&2
  exit 1
fi

echo "==> Waiting for the server (the first start downloads it)"
for _ in $(seq 1 60); do
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1 && break
  sleep 2
done
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "    Musik:  http://${IP:-<address of this device>}:$PORT"
echo "    Songs:  $MUSIC"
echo "    Update: restart the app in the dashboard, or run this command again."
