#!/usr/bin/env bash
# Creates (or updates) a Debian LXC container with the Streyn server on a Proxmox VE host.
# Run in the Proxmox node shell:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/proxmox.sh)"
# Optional environment variables:
#   MUSIC_HOST_DIR=/mnt/pve/nas/music   host folder mounted read-only into the container as /srv/streyn/library
#   CTID=120  CT_CORES=2  CT_RAM=2048  CT_SWAP=2048  CT_DISK=8  CT_BRIDGE=vmbr0  CT_STORAGE=local-lvm  BRANCH=main
#   TAILSCALE=1                         also set up Tailscale (apps work away from home); TAILSCALE=0 skips the question
#   TS_AUTHKEY=tskey-auth-...           log in to Tailscale without opening a link
#   PUBLIC=1 / PUBLIC=0                 shared playlist links for anyone (Tailscale Funnel) on or off
set -euo pipefail

REPO="Labtoso/Musik"
BRANCH="${BRANCH:-main}"
RAW="https://raw.githubusercontent.com/$REPO/$BRANCH/deploy"
CORES="${CT_CORES:-2}"
RAM="${CT_RAM:-2048}"
SWAP="${CT_SWAP:-2048}"
DISK="${CT_DISK:-8}"
BRIDGE="${CT_BRIDGE:-vmbr0}"

cat <<'BANNER'
  ____  _
 / ___|| |_ _ __ ___ _   _ _ __
 \___ \| __| '__/ _ \ | | | '_ \
  ___) | |_| | |  __/ |_| | | | |
 |____/ \__|_|  \___|\__, |_| |_|
                     |___/   Proxmox installer
BANNER

command -v pct >/dev/null || { echo "Run this on a Proxmox VE host (pct not found)." >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Please run as root." >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

# ---- existing container? then update it ----
EXISTING=""
for id in $(pct list | awk 'NR>1 {print $1}'); do
  if pct config "$id" 2>/dev/null | grep -Eq '^tags:(.*[;, ])? *(streyn|musik)([;, ]|$)'; then EXISTING="$id"; break; fi
done
# older containers without the tag: hostname musik or streyn with the server inside
if [ -z "$EXISTING" ]; then
  for id in $(pct list | awk 'NR>1 {print $1}'); do
    if pct config "$id" 2>/dev/null | grep -Eq '^hostname: (musik|streyn)$' && pct exec "$id" -- bash -c 'test -x /opt/musik/musik-server || test -x /opt/streyn/streyn-server' 2>/dev/null; then
      EXISTING="$id"; pct set "$id" --tags streyn >/dev/null 2>&1 || true; break
    fi
  done
fi
echo
if [ -n "$EXISTING" ]; then
  echo "==> Streyn container $EXISTING found: UPDATE. Settings, accounts, playlists and music are kept."
else
  echo "==> No Streyn container found: CLEAN INSTALL into a new container."
fi

ask_tailscale() {
  if [ -z "${TAILSCALE+x}" ] && [ -r /dev/tty ]; then
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
  fi
  TAILSCALE="${TAILSCALE:-0}"
}

# Tailscale in an unprivileged container needs the tun device
add_tun() { # returns 0 when a line was added (the container needs a restart), 1 when all was there
  local conf="/etc/pve/lxc/$1.conf" added=1
  if ! grep -Eq '^[[:space:]]*lxc\.cgroup2\.devices\.allow[[:space:]]*[:=][[:space:]]*c 10:200 rwm' "$conf"; then
    printf 'lxc.cgroup2.devices.allow: c 10:200 rwm\n' >> "$conf"; added=0
  fi
  if ! grep -Eq '^[[:space:]]*lxc\.mount\.entry[[:space:]]*[:=][[:space:]]*/dev/net/tun[[:space:]]+dev/net/tun' "$conf"; then
    printf 'lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file\n' >> "$conf"; added=0
  fi
  return "$added"
}

ts_args() {
  [ "$TAILSCALE" = "1" ] || { printf ' --no-tailscale'; return 0; }
  printf ' --tailscale'
  [ -n "${TS_AUTHKEY:-}" ] && printf ' --ts-authkey %q' "$TS_AUTHKEY"
  [ "${PUBLIC:-}" = "1" ] && printf ' --public'
  [ "${PUBLIC:-}" = "0" ] && printf ' --no-public'
  return 0
}

# the notes helper and its timer on this Proxmox host
install_notes() {
  if ! { curl -fsSL -o /usr/local/bin/streyn-proxmox-notes.new "$RAW/proxmox-notes.sh" \
    && bash -n /usr/local/bin/streyn-proxmox-notes.new \
    && chmod +x /usr/local/bin/streyn-proxmox-notes.new \
    && mv -f /usr/local/bin/streyn-proxmox-notes.new /usr/local/bin/streyn-proxmox-notes; }; then
    rm -f /usr/local/bin/streyn-proxmox-notes.new
    echo "Warning: could not download the notes helper (proxmox-notes.sh)." >&2
    [ -x /usr/local/bin/streyn-proxmox-notes ] || return 1
    echo "Warning: keeping the notes helper that is already installed." >&2
  fi
  cat > /etc/systemd/system/streyn-proxmox-notes.service <<'UNIT'
[Unit]
Description=Streyn: keep container notes up to date

[Service]
Type=oneshot
ExecStart=/usr/local/bin/streyn-proxmox-notes
UNIT
  cat > /etc/systemd/system/streyn-proxmox-notes.timer <<'UNIT'
[Unit]
Description=Streyn: refresh container notes every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now streyn-proxmox-notes.timer >/dev/null 2>&1 || true
}

run_inside() {
  local id="$1"; shift
  pct exec "$id" -- bash -c "$*"
}

# runs install.sh inside the container only after it was downloaded completely
install_cmd() { # arguments for install.sh
  printf 'f="$(mktemp)" && curl -fsSL -o "$f" %q && bash "$f" %s; rc=$?; rm -f "$f"; exit $rc' "$RAW/install.sh" "$*"
}

show_links() {
  local id="$1" mode="$2" ip port url remote version music when ts
  ip="$(pct exec "$id" -- hostname -I 2>/dev/null | awk '{print $1}' || true)"
  port="$(pct exec "$id" -- awk -F= '/^PORT=/{print $2}' /etc/streyn.env /etc/musik.env 2>/dev/null | head -n1 || true)"
  port="${port:-8484}"
  url="http://${ip:-<container-ip>}:$port"
  remote="$(pct exec "$id" -- awk -F= '/^REMOTE_URL=/{print $2}' /etc/streyn.env /etc/musik.env 2>/dev/null | head -n1 || true)"
  music="$(pct exec "$id" -- awk -F= '/^MUSIC_DIRS=/{print $2}' /etc/streyn.env /etc/musik.env 2>/dev/null | head -n1 || true)"
  version="$(pct exec "$id" -- bash -c "curl -fsS --max-time 5 http://127.0.0.1:$port/api/info" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
  ts="$(pct exec "$id" -- bash -c 'command -v tailscale >/dev/null && tailscale ip -4 2>/dev/null | head -n1' 2>/dev/null || true)"
  when="$(date '+%Y-%m-%d %H:%M')"
  # notes shown under the container's Summary in the Proxmox web UI; a timer keeps them in step
  # with the server version, also after updates from the app
  if install_notes; then
    /usr/local/bin/streyn-proxmox-notes "$id" "$mode" || echo "Warning: the container notes could not be written." >&2
  fi
  echo
  echo "────────────────────────────────────────────────────────────"
  if [ "$mode" = "update" ]; then echo " Streyn ${version:+$version }updated in container $id."; else echo " Streyn ${version:+$version }installed in new container $id."; fi
  echo "────────────────────────────────────────────────────────────"
  echo "  Web app:              $url"
  echo "  Server address (app): $url"
  [ -n "$remote" ] && echo "  On the go:            $remote   (Tailscale, the apps switch by themselves)"
  echo "  Downloads (APK/EXE):  https://github.com/$REPO/releases/latest"
  echo "  Logs:                 pct exec $id -- journalctl -u streyn -f"
  echo "  Settings:             pct exec $id -- nano /etc/streyn.env"
  echo "  The same overview is in Proxmox: container $id -> Summary -> Notes."
  echo "  It follows the server version by itself (also after updates in the app)."
}

if [ -n "$EXISTING" ]; then
  step "Updating Streyn in container $EXISTING"
  # more memory for older containers (they started with 512 MB); applies at once, cores stay as they are
  cur_ram="$(pct config "$EXISTING" | awk '/^memory:/{print $2}' || true)"; cur_swap="$(pct config "$EXISTING" | awk '/^swap:/{print $2}' || true)"
  [[ "$cur_ram" =~ ^[0-9]+$ ]] || cur_ram=512
  [[ "$cur_swap" =~ ^[0-9]+$ ]] || cur_swap=0
  if [[ "$RAM" =~ ^[0-9]+$ && "$SWAP" =~ ^[0-9]+$ ]] && { [ "$cur_ram" -lt "$RAM" ] || [ "$cur_swap" -lt "$SWAP" ]; }; then
    new_ram=$(( cur_ram > RAM ? cur_ram : RAM )); new_swap=$(( cur_swap > SWAP ? cur_swap : SWAP ))
    if pct set "$EXISTING" --memory "$new_ram" --swap "$new_swap"; then
      echo "  Memory: ${new_ram} MB RAM, ${new_swap} MB swap (was $cur_ram / $cur_swap)"
    else
      echo "Warning: could not change the memory of container $EXISTING, the update goes on." >&2
    fi
  fi
  [ "$(pct status "$EXISTING" | awk '{print $2}')" = "running" ] || pct start "$EXISTING"
  if ! pct exec "$EXISTING" -- test -f /usr/bin/tailscale 2>/dev/null; then
    ask_tailscale
    if [ "$TAILSCALE" = "1" ] && add_tun "$EXISTING"; then
      pct reboot "$EXISTING"
      for _ in $(seq 1 60); do pct exec "$EXISTING" -- bash -c 'getent hosts github.com >/dev/null' 2>/dev/null && break; sleep 2; done
    fi
  else
    TAILSCALE=1
  fi
  sleep 3
  run_inside "$EXISTING" "$(install_cmd "--update$(ts_args)")"
  show_links "$EXISTING" update
  exit 0
fi

# ---- new container ----
CTID="${CTID:-$(pvesh get /cluster/nextid)}"

step "Finding storage"
TSTORE="$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}')"
TSTORE="${TSTORE:-local}"
if [ -n "${CT_STORAGE:-}" ]; then
  RSTORE="$CT_STORAGE"
else
  RSTORE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}' | grep -E '^(local-lvm|local-zfs)$' | head -n1 || true)"
  [ -n "$RSTORE" ] || RSTORE="$(pvesm status -content rootdir | awk 'NR>1 && $3=="active" {print $1; exit}')"
fi
echo "Templates: $TSTORE   Disk: $RSTORE"

step "Getting Debian 12 template"
pveam update >/dev/null || true
TEMPLATE="$(pveam available --section system | awk '{print $2}' | grep -E '^debian-12-standard_.*_amd64\.tar\.(zst|gz|xz)$' | sort -V | tail -n1)"
[ -n "$TEMPLATE" ] || { echo "No Debian 12 template found." >&2; exit 1; }
if ! pveam list "$TSTORE" | grep -q "$TEMPLATE"; then pveam download "$TSTORE" "$TEMPLATE"; fi

if [ -z "${MUSIC_HOST_DIR+x}" ] && [ -r /dev/tty ]; then
  echo
  echo "Optional: a folder on this Proxmox host with your music (e.g. /mnt/pve/nas/music)."
  read -rp "Host music folder (empty = none, upload in the app): " MUSIC_HOST_DIR </dev/tty || MUSIC_HOST_DIR=""
fi
MUSIC_HOST_DIR="${MUSIC_HOST_DIR:-}"
ask_tailscale
if [ -n "$MUSIC_HOST_DIR" ] && [ ! -d "$MUSIC_HOST_DIR" ]; then
  echo "Folder $MUSIC_HOST_DIR does not exist." >&2; exit 1
fi

step "Creating container $CTID"
pct create "$CTID" "$TSTORE:vztmpl/$TEMPLATE" \
  --hostname streyn \
  --cores "$CORES" --memory "$RAM" --swap "$SWAP" \
  --rootfs "$RSTORE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp,ip6=auto" \
  --unprivileged 1 --features nesting=1 \
  --onboot 1 --tags streyn \
  --ostype debian >/dev/null
if [ -n "$MUSIC_HOST_DIR" ]; then
  pct set "$CTID" -mp0 "$MUSIC_HOST_DIR,mp=/srv/streyn/library,ro=1" >/dev/null
fi
[ "$TAILSCALE" = "1" ] && add_tun "$CTID" || true
pct start "$CTID"

step "Waiting for network"
for _ in $(seq 1 60); do
  if pct exec "$CTID" -- bash -c 'hostname -I | grep -q "[0-9]" && getent hosts github.com >/dev/null' 2>/dev/null; then break; fi
  sleep 2
done

step "Installing Streyn inside the container"
run_inside "$CTID" "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null && { $(install_cmd "--music /srv/streyn$(ts_args)"); }"
show_links "$CTID" install
