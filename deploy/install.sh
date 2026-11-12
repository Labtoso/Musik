#!/usr/bin/env bash
# Musik server installer for Debian/Ubuntu (also used inside the Proxmox container).
# Run again to update. Usage:
#   curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/install.sh | sudo bash
#   options: --music <dir>  --port <port>  --version <tag, e.g. v1.0.0>
#            --tailscale            also set up Tailscale so the apps work away from home
#            --no-tailscale         do not ask about Tailscale
#            --ts-authkey <key>     log in to Tailscale without opening a link (tskey-auth-...)
set -euo pipefail

REPO="Labtoso/Musik"
VERSION="latest"
APP_DIR="/opt/musik"
DATA_DIR="/var/lib/musik"
MUSIC_DIR="/srv/musik"
PORT="8484"
ENV_FILE="/etc/musik.env"
TAILSCALE=""
TS_AUTHKEY="${TS_AUTHKEY:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --music) MUSIC_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --branch) shift 2 ;;
    --update) shift ;;
    --tailscale) TAILSCALE=1; shift ;;
    --no-tailscale) TAILSCALE=0; shift ;;
    --ts-authkey) TAILSCALE=1; TS_AUTHKEY="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

cat <<'BANNER'
  __  __           _ _
 |  \/  |_   _ ___(_) | __
 | |\/| | | | / __| | |/ /
 | |  | | |_| \__ \ |   <
 |_|  |_|\__,_|___/_|_|\_\   server installer
BANNER

# ask once, unless a flag decided it or Tailscale is already set up
if [ -z "$TAILSCALE" ] && ! grep -q '^REMOTE_URL=' "$ENV_FILE" 2>/dev/null && [ -r /dev/tty ]; then
    echo
    echo "─────────────────────────────────────────────────────────────"
    echo " Use Musik away from home?"
    echo
    echo " 1) Without Tailscale: the apps work at home (same Wi-Fi)."
    echo " 2) With Tailscale:    the apps also work on mobile data and"
    echo "                       other Wi-Fi. Free, no port forwarding,"
    echo "                       nothing is opened to the internet."
    echo "                       You log in once with a Tailscale account"
    echo "                       and install the Tailscale app on your phone."
    echo "─────────────────────────────────────────────────────────────"
    read -rp "Choose 1 or 2 [1]: " a </dev/tty || a=""
    case "$a" in 2|[yYjJ]*) TAILSCALE=1 ;; *) TAILSCALE=0 ;; esac
  echo
fi

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)." >&2; exit 1; }
command -v apt-get >/dev/null || { echo "This installer needs Debian or Ubuntu." >&2; exit 1; }

step() { printf '\n==> %s\n' "$*"; }

step "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates >/dev/null

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/musik-server-linux-$ARCH"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/musik-server-linux-$ARCH"
fi

step "Downloading Musik server ($VERSION, $ARCH)"
mkdir -p "$APP_DIR"
curl -fL --progress-bar -o "$APP_DIR/musik-server.new" "$URL"
chmod +x "$APP_DIR/musik-server.new"
mv -f "$APP_DIR/musik-server.new" "$APP_DIR/musik-server"
curl -fsSL -o /usr/local/bin/musik-update "https://raw.githubusercontent.com/$REPO/main/deploy/install.sh"
chmod +x /usr/local/bin/musik-update

step "Setting up service"
id musik >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin musik
mkdir -p "$DATA_DIR" "$MUSIC_DIR"
chown -R musik:musik "$DATA_DIR"
# Only fix ownership of the music folder when it is empty (never touch a mounted collection).
if [ -z "$(ls -A "$MUSIC_DIR" 2>/dev/null)" ]; then chown musik:musik "$MUSIC_DIR" 2>/dev/null || true; fi

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
# Musik server settings. Restart after changes: systemctl restart musik
PORT=$PORT
DATA_DIR=$DATA_DIR
# Several folders: separate with :
MUSIC_DIRS=$MUSIC_DIR
# Rescan interval in minutes (0 = only on start and on demand)
SCAN_INTERVAL=30
SERVER_NAME=Musik
ENV
fi

cat > /etc/systemd/system/musik.service <<UNIT
[Unit]
Description=Musik server
After=network-online.target
Wants=network-online.target

[Service]
User=musik
Group=musik
Environment=MUSIK_ENV=$ENV_FILE
EnvironmentFile=$ENV_FILE
ExecStart=$APP_DIR/musik-server
WorkingDirectory=$DATA_DIR
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable musik >/dev/null 2>&1
systemctl restart musik

PORT_NOW="$(awk -F= '/^PORT=/{print $2}' "$ENV_FILE")"

# ---- Tailscale: reach the server from anywhere ----
setenv() { # key value
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}
REMOTE=""
if [ "$TAILSCALE" = "1" ]; then
  step "Setting up Tailscale"
  if [ ! -c /dev/net/tun ]; then
    echo "No /dev/net/tun here. In a Proxmox container run the Proxmox script with Tailscale, it adds the device." >&2
  else
    command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
    systemctl enable --now tailscaled >/dev/null 2>&1 || true
    if ! tailscale status >/dev/null 2>&1; then
      if [ -n "$TS_AUTHKEY" ]; then
        tailscale up --hostname=musik --authkey="$TS_AUTHKEY"
      else
        echo "Open the link below and log in to Tailscale (same account as on your phone):"
        tailscale up --hostname=musik
      fi
    fi
    # HTTPS name inside your tailnet (needs MagicDNS and HTTPS certificates, both on by default)
    if tailscale serve --bg --https=443 "http://127.0.0.1:${PORT_NOW:-8484}" >/dev/null 2>&1; then
      DNS="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -n1)"
      [ -n "$DNS" ] && REMOTE="https://$DNS"
    fi
    if [ -z "$REMOTE" ]; then
      TSIP="$(tailscale ip -4 2>/dev/null | head -n1)"
      [ -n "$TSIP" ] && REMOTE="http://$TSIP:${PORT_NOW:-8484}"
    fi
    if [ -n "$REMOTE" ]; then setenv REMOTE_URL "$REMOTE"; systemctl restart musik; fi
  fi
fi
REMOTE="$(awk -F= '/^REMOTE_URL=/{print $2}' "$ENV_FILE")"
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT_NOW:-8484}/api/info" >/dev/null 2>&1 && break
  sleep 1
done

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
if curl -fsS "http://127.0.0.1:${PORT_NOW:-8484}/api/info" >/dev/null 2>&1; then
  echo "Musik is running."
else
  echo "Musik did not answer yet. Check: journalctl -u musik -n 50"
fi
echo "  Open:          http://${IP:-<server-ip>}:${PORT_NOW:-8484}"
[ -n "$REMOTE" ] && echo "  On the go:     $REMOTE   (Tailscale on, the apps switch to it by themselves)"
echo "  Music folder:  $(awk -F= '/^MUSIC_DIRS=/{print $2}' "$ENV_FILE")"
echo "  Settings:      $ENV_FILE"
echo "  Update:        musik-update"
echo "  Logs:          journalctl -u musik -f"
