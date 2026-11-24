#!/usr/bin/env bash
# Streyn server installer for Debian/Ubuntu (also used inside the Proxmox container).
# Run again to update. Usage:
#   curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/install.sh | sudo bash
#   options: --music <dir>  --port <port>  --version <tag, e.g. v1.0.0>
#            --tailscale            also set up Tailscale so the apps work away from home
#            --no-tailscale         do not ask about Tailscale
#            --ts-authkey <key>     log in to Tailscale without opening a link (tskey-auth-...)
#            --public               shared playlist links work for anyone (Tailscale Funnel, needs --tailscale)
#            --no-public            shared links only work at home and in your tailnet
set -euo pipefail

REPO="Labtoso/Musik"
VERSION="latest"
APP_DIR="/opt/streyn"
DATA_DIR="/var/lib/streyn"
MUSIC_DIR="/srv/streyn"
PORT="8484"
ENV_FILE="/etc/streyn.env"
TAILSCALE=""
TS_AUTHKEY="${TS_AUTHKEY:-}"
PUBLIC="${PUBLIC:-}"

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
    --public) PUBLIC=1; shift ;;
    --no-public) PUBLIC=0; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

cat <<'BANNER'
  ____  _
 / ___|| |_ _ __ ___ _   _ _ __
 \___ \| __| '__/ _ \ | | | '_ \
  ___) | |_| | |  __/ |_| | | | |
 |____/ \__|_|  \___|\__, |_| |_|
                     |___/   server installer
BANNER

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
  URL="https://github.com/$REPO/releases/latest/download/streyn-server-linux-$ARCH"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/streyn-server-linux-$ARCH"
fi

# Download everything first, into a temporary folder: if that fails, the running server
# (and an older Musik installation) is left exactly as it is.
step "Downloading Streyn server ($VERSION, $ARCH)"
DL="$(mktemp -d)"
trap 'rm -rf -- "$DL"' EXIT
curl -fL --progress-bar -o "$DL/streyn-server" "$URL"
[ -s "$DL/streyn-server" ] || { echo "The download of the server is empty." >&2; exit 1; }
curl -fsSL -o "$DL/streyn-update" "https://raw.githubusercontent.com/$REPO/main/deploy/install.sh"
{ [ -s "$DL/streyn-update" ] && bash -n "$DL/streyn-update"; } || { echo "The downloaded update script is damaged." >&2; exit 1; }
chmod +x "$DL/streyn-server" "$DL/streyn-update"

PRE_VERSION=""
info_version() { # port -> version of the running server, empty if none answers
  command -v curl >/dev/null || return 0
  curl -fsS --max-time 3 "http://127.0.0.1:${1:-8484}/api/info" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'  || true
}

# Musik is now Streyn: an older installation moves to the new names once.
# Settings, accounts, playlists and the music folder stay as they are.
if [ ! -e /opt/streyn ] && { [ -d /opt/musik ] || [ -f /etc/musik.env ]; }; then
  echo
  echo "==> Moving the Musik installation to its new name Streyn"
  PRE_VERSION="$(info_version "$(awk -F= '/^PORT=/{print $2}' /etc/musik.env 2>/dev/null || true)")"
  systemctl stop musik >/dev/null 2>&1 || true
  systemctl disable musik >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/musik.service
  if [ -d /opt/musik ]; then
    mv /opt/musik /opt/streyn
    [ -f /opt/streyn/musik-server ] && mv -f /opt/streyn/musik-server /opt/streyn/streyn-server
  fi
  [ -d /var/lib/musik ] && [ ! -e /var/lib/streyn ] && mv /var/lib/musik /var/lib/streyn
  if [ -f /etc/musik.env ]; then
    mv /etc/musik.env /etc/streyn.env
    sed -i 's|^DATA_DIR=/var/lib/musik$|DATA_DIR=/var/lib/streyn|; s|^SERVER_NAME=Musik$|SERVER_NAME=Streyn|; s|^# Musik server settings.*|# Streyn server settings. Restart after changes: systemctl restart streyn|' /etc/streyn.env
  fi
  if id musik >/dev/null 2>&1 && ! id streyn >/dev/null 2>&1; then
    usermod -l streyn -d /var/lib/streyn musik >/dev/null 2>&1 || true
    groupmod -n streyn musik >/dev/null 2>&1 || true
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
fi

# a second, old service would hold the port and keep the old database open
if [ -f /etc/systemd/system/musik.service ] && { [ -e /opt/streyn ] || [ -f /etc/streyn.env ]; }; then
  systemctl stop musik >/dev/null 2>&1 || true
  systemctl disable musik >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/musik.service
fi

# clean install or update?
OLD_PORT="$(awk -F= '/^PORT=/{print $2}' "$ENV_FILE" 2>/dev/null || true)"
# an existing installation keeps its music folder
if [ "$MUSIC_DIR" = /srv/streyn ] && [ -f "$ENV_FILE" ]; then
  m="$(awk -F= '/^MUSIC_DIRS=/{print $2}' "$ENV_FILE" | cut -d: -f1)"
  [ -n "$m" ] && MUSIC_DIR="$m"
fi
if [ -x "$APP_DIR/streyn-server" ] || [ -f "$ENV_FILE" ]; then
  MODE=update
  OLD_VERSION="${PRE_VERSION:-$(info_version "${OLD_PORT:-8484}")}"
  echo
  echo "==> Existing installation found${OLD_VERSION:+ (version $OLD_VERSION)}: UPDATE."
  echo "    Settings, accounts, playlists and your music stay as they are."
else
  MODE=fresh
  OLD_VERSION=""
  echo
  echo "==> No installation found: CLEAN INSTALL."
fi

# ---- keep the data safe ----
# The data folder named in the settings file is the one in use. If it holds no accounts but an
# older folder still has a database (for example left behind by the rename from Musik), that
# older database is taken over again instead of starting empty.
CUR_DATA="$(awk -F= '/^DATA_DIR=/{print $2}' "$ENV_FILE" 2>/dev/null | tail -n1 || true)"
CUR_DATA="${CUR_DATA:-$DATA_DIR}"
has_db() { [ -s "$1/streyn.db" ] || [ -s "$1/musik.db" ]; }
ORPHAN=""
for d in /var/lib/streyn /var/lib/musik /opt/streyn/data /opt/musik/data; do
  [ "$d" = "$CUR_DATA" ] && continue
  if has_db "$d"; then ORPHAN="$d"; break; fi
done
NEEDS_SETUP=0
if [ "$MODE" = update ] && [ -n "$ORPHAN" ]; then
  if ! has_db "$CUR_DATA"; then NEEDS_SETUP=1
  elif command -v curl >/dev/null && curl -fsS --max-time 3 "http://127.0.0.1:${OLD_PORT:-8484}/api/info" 2>/dev/null | grep -q '"setup":true'; then NEEDS_SETUP=1
  fi
fi

# ask once, unless a flag decided it or Tailscale is already set up
if [ -z "$TAILSCALE" ] && ! grep -q '^REMOTE_URL=' "$ENV_FILE" 2>/dev/null && [ -r /dev/tty ]; then
    echo
    echo "─────────────────────────────────────────────────────────────"
    echo " Use Streyn away from home?"
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

mkdir -p "$APP_DIR"
cp "$DL/streyn-server" "$APP_DIR/streyn-server.new"
chmod +x "$APP_DIR/streyn-server.new"

if [ "$MODE" = update ]; then
  # stop the server so the database is complete on disk, then keep a copy of it
  systemctl stop streyn >/dev/null 2>&1 || true
  if has_db "$CUR_DATA"; then
    step "Backing up your data"
    B="$CUR_DATA/backups/$(date +%Y-%m-%d_%H%M%S)${OLD_VERSION:+_v$OLD_VERSION}"
    mkdir -p "$B"
    for f in "$CUR_DATA"/streyn.db* "$CUR_DATA"/musik.db*; do [ -f "$f" ] && cp -p "$f" "$B/"; done
    echo "Saved to $B"
    # keep the last 5 backups
    find "$CUR_DATA/backups" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null | sort -z | head -z -n -5 | xargs -0 -r rm -rf --
  fi
  if [ "$NEEDS_SETUP" = 1 ]; then
    step "Taking your data back from $ORPHAN"
    if has_db "$CUR_DATA"; then
      E="$CUR_DATA/backups/empty-$(date +%Y-%m-%d_%H%M%S)"; mkdir -p "$E"
      mv -f "$CUR_DATA"/streyn.db* "$E/" 2>/dev/null || true
      mv -f "$CUR_DATA"/musik.db* "$E/" 2>/dev/null || true
    fi
    mkdir -p "$CUR_DATA"
    src=streyn; [ -s "$ORPHAN/streyn.db" ] || src=musik
    for ext in "" -wal -shm; do [ -f "$ORPHAN/$src.db$ext" ] && cp -p "$ORPHAN/$src.db$ext" "$CUR_DATA/streyn.db$ext"; done
    echo "Accounts, playlists and settings from $ORPHAN are back (the old folder stays as it is)."
  fi
fi
mv -f "$APP_DIR/streyn-server.new" "$APP_DIR/streyn-server"
# replaced by a rename, so a running streyn-update is not overwritten while bash reads it
cp "$DL/streyn-update" /usr/local/bin/streyn-update.new
chmod +x /usr/local/bin/streyn-update.new
mv -f /usr/local/bin/streyn-update.new /usr/local/bin/streyn-update
# the old command name keeps working
ln -sfn streyn-update /usr/local/bin/musik-update

step "Setting up service"
id streyn >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin streyn
# the server may replace its own binary (update button in the apps)
chown -R streyn:streyn "$APP_DIR"
mkdir -p "$DATA_DIR" "$MUSIC_DIR"
chown -R streyn:streyn "$DATA_DIR"
if [ "$CUR_DATA" != "$DATA_DIR" ] && [ -d "$CUR_DATA" ]; then chown -R streyn:streyn "$CUR_DATA"; fi
# Only fix ownership of the music folder when it is empty (never touch a mounted collection).
if [ -z "$(ls -A "$MUSIC_DIR" 2>/dev/null)" ]; then chown streyn:streyn "$MUSIC_DIR" 2>/dev/null || true; fi

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
# Streyn server settings. Restart after changes: systemctl restart streyn
PORT=$PORT
DATA_DIR=$DATA_DIR
# Several folders: separate with :
MUSIC_DIRS=$MUSIC_DIR
# Rescan interval in minutes (0 = only on start and on demand)
SCAN_INTERVAL=30
SERVER_NAME=Streyn
ENV
fi

cat > /etc/systemd/system/streyn.service <<UNIT
[Unit]
Description=Streyn server
After=network-online.target
Wants=network-online.target

[Service]
User=streyn
Group=streyn
Environment=STREYN_ENV=$ENV_FILE
EnvironmentFile=$ENV_FILE
ExecStart=$APP_DIR/streyn-server
WorkingDirectory=$DATA_DIR
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable streyn >/dev/null 2>&1
systemctl restart streyn

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
        tailscale up --hostname=streyn --authkey="$TS_AUTHKEY"
      else
        echo; echo "┌─ Your turn ─────────────────────────────────────────────────"; echo "│ Open the link below and log in to Tailscale (same account as on your phone)."; echo "│ The installer continues by itself after the login."; echo "└─────────────────────────────────────────────────────────────"
        tailscale up --hostname=streyn
      fi
    fi
    # HTTPS name inside your tailnet. It needs HTTPS switched on in the Tailscale account; the script
    # checks that first and tells the person exactly what to click instead of waiting silently.
    https_on() { tailscale status --json 2>/dev/null | tr -d ' \n' | grep -q '"CertDomains":\["'; }
    todo() { # message lines...; returns 1 when the person types s (skip) or no keyboard is attached
      echo
      echo "┌─ Your turn ─────────────────────────────────────────────────"
      for l in "$@"; do echo "│ $l"; done
      echo "└─────────────────────────────────────────────────────────────"
      [ -r /dev/tty ] || { echo "(no keyboard attached, skipping)"; return 1; }
      local a=""
      read -rp "Press Enter when done, or type s to skip: " a </dev/tty || return 1
      case "$a" in [sS]*) return 1 ;; esac
      return 0
    }
    TRY=0
    while ! https_on && [ $TRY -lt 5 ]; do
      TRY=$((TRY + 1))
      todo "HTTPS is switched off in your Tailscale account." \
           "1) Open https://login.tailscale.com/admin/dns" \
           "2) Scroll down to 'HTTPS Certificates' and click 'Enable HTTPS'." \
           "Without it the apps still work on the go, just over the Tailscale IP." || break
      sleep 2
    done
    if https_on; then
      SERVE_LOG="$(mktemp)"
      for _ in 1 2 3; do
        # tailscale serve can wait silently for a confirmation, so it gets a time limit
        if timeout 30 tailscale serve --bg --https=443 "http://127.0.0.1:${PORT_NOW:-8484}" >"$SERVE_LOG" 2>&1; then
          DNS="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -n1)"
          [ -n "$DNS" ] && REMOTE="https://$DNS"
          break
        fi
        LINK="$(grep -o 'https://login.tailscale.com[^ ]*' "$SERVE_LOG" | head -n1 || true)"
        todo "Tailscale asks you to allow 'Serve' for this device once." \
             "Open ${LINK:-https://login.tailscale.com/admin/machines} and confirm it." || break
      done
      rm -f "$SERVE_LOG"

      # Public links: Tailscale Funnel opens one extra door (port 8443) to the internet. Behind it
      # the server only answers share pages and the accounts of invited people, never admin tools.
      if [ -z "$PUBLIC" ] && ! grep -q '^PUBLIC_URL=' "$ENV_FILE" 2>/dev/null && [ -r /dev/tty ]; then
        echo
        echo "─────────────────────────────────────────────────────────────"
        echo " Share playlists with anyone?"
        echo
        echo " With public links, a shared playlist opens for everyone at"
        echo " musik.labtoso.de, no Tailscale needed. Invited people can"
        echo " make an account and add songs. Your music library, settings"
        echo " and admin account stay reachable only at home."
        echo "─────────────────────────────────────────────────────────────"
        read -rp "Switch on public links? [y/N]: " a </dev/tty || a=""
        case "$a" in [yYjJ]*) PUBLIC=1 ;; *) PUBLIC=0 ;; esac
      fi
      if grep -q '^PUBLIC_URL=' "$ENV_FILE" 2>/dev/null && [ "$PUBLIC" != "0" ]; then PUBLIC=1; fi
      PUB_PORT="$(awk -F= '/^PUBLIC_PORT=/{print $2}' "$ENV_FILE")"; PUB_PORT="${PUB_PORT:-8485}"
      if [ "$PUBLIC" = "1" ]; then
        FUNNEL_LOG="$(mktemp)"
        for _ in 1 2 3; do
          if timeout 30 tailscale funnel --bg --https=8443 "http://127.0.0.1:$PUB_PORT" >"$FUNNEL_LOG" 2>&1; then
            DNS="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -n1)"
            [ -n "$DNS" ] && { setenv PUBLIC_URL "https://$DNS:8443"; echo "Public links: https://$DNS:8443"; }
            break
          fi
          LINK="$(grep -o 'https://login.tailscale.com[^ ]*' "$FUNNEL_LOG" | head -n1 || true)"
          todo "Tailscale asks you to allow 'Funnel' for this device once." \
               "Open ${LINK:-https://login.tailscale.com/admin/acls} and confirm it." || break
        done
        rm -f "$FUNNEL_LOG"
      elif [ "$PUBLIC" = "0" ] && grep -q '^PUBLIC_URL=' "$ENV_FILE" 2>/dev/null; then
        tailscale funnel --https=8443 off >/dev/null 2>&1 || true
        sed -i '/^PUBLIC_URL=/d' "$ENV_FILE"
      fi
    fi
    [ -n "$REMOTE" ] || echo "Using the Tailscale IP for now. Run streyn-update later to switch to https."
    if [ -z "$REMOTE" ]; then
      TSIP="$(tailscale ip -4 2>/dev/null | head -n1)"
      [ -n "$TSIP" ] && REMOTE="http://$TSIP:${PORT_NOW:-8484}"
    fi
    if [ -n "$REMOTE" ]; then setenv REMOTE_URL "$REMOTE"; systemctl restart streyn; fi
  fi
fi
# --no-public also takes effect when Tailscale itself was not touched in this run
if [ "$PUBLIC" = "0" ] && grep -q '^PUBLIC_URL=' "$ENV_FILE" 2>/dev/null; then
  step "Switching off public links"
  if command -v tailscale >/dev/null; then tailscale funnel --https=8443 off >/dev/null 2>&1 || true; fi
  if command -v tailscale >/dev/null && tailscale funnel status 2>/dev/null | grep -q ':8443'; then
    echo "Tailscale Funnel could not be switched off, public links stay on. Try: tailscale funnel --https=8443 off" >&2
  else
    sed -i '/^PUBLIC_URL=/d' "$ENV_FILE"
    systemctl restart streyn
  fi
fi
REMOTE="$(awk -F= '/^REMOTE_URL=/{print $2}' "$ENV_FILE")"
# 22/23: each check has a time limit, and an installation that never answers ends with an error
READY=0
for _ in $(seq 1 30); do
  if curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:${PORT_NOW:-8484}/api/info" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
NEW_VERSION="$(info_version "${PORT_NOW:-8484}")"
if [ "$READY" = 1 ]; then
  if [ "$MODE" = "update" ]; then
    if [ -n "$OLD_VERSION" ] && [ -n "$NEW_VERSION" ] && [ "$OLD_VERSION" != "$NEW_VERSION" ]; then echo "Streyn updated: $OLD_VERSION -> $NEW_VERSION. It is running."
    else echo "Streyn ${NEW_VERSION:+$NEW_VERSION }is up to date and running."; fi
  else
    echo "Streyn ${NEW_VERSION:+$NEW_VERSION }is installed and running."
  fi
else
  echo "Streyn did not answer. Check: journalctl -u streyn -n 50" >&2
  systemctl --no-pager status streyn 2>&1 | tail -n 15 >&2 || true
fi
echo "  Open:          http://${IP:-<server-ip>}:${PORT_NOW:-8484}"
[ -n "$REMOTE" ] && echo "  On the go:     $REMOTE   (Tailscale on, the apps switch to it by themselves)"
PUB="$(awk -F= '/^PUBLIC_URL=/{print $2}' "$ENV_FILE")"
[ -n "$PUB" ] && echo "  Public links:  $PUB   (shared playlists open for anyone at musik.labtoso.de)"
echo "  Music folder:  $(awk -F= '/^MUSIC_DIRS=/{print $2}' "$ENV_FILE")"
echo "  Settings:      $ENV_FILE"
echo "  Update:        streyn-update"
echo "  Logs:          journalctl -u streyn -f"
[ "$READY" = 1 ] || exit 1
