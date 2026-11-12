#!/usr/bin/env bash
# Creates (or updates) a Debian LXC container with the Musik server on a Proxmox VE host.
# Run in the Proxmox node shell:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/proxmox.sh)"
# Optional environment variables:
#   MUSIC_HOST_DIR=/mnt/pve/nas/music   host folder mounted read-only into the container as /srv/musik
#   CTID=120  CT_CORES=2  CT_RAM=512  CT_DISK=8  CT_BRIDGE=vmbr0  CT_STORAGE=local-lvm  BRANCH=main
#   TAILSCALE=1                         also set up Tailscale (apps work away from home); TAILSCALE=0 skips the question
#   TS_AUTHKEY=tskey-auth-...           log in to Tailscale without opening a link
set -euo pipefail

REPO="Labtoso/Musik"
BRANCH="${BRANCH:-main}"
RAW="https://raw.githubusercontent.com/$REPO/$BRANCH/deploy"
CORES="${CT_CORES:-2}"
RAM="${CT_RAM:-512}"
DISK="${CT_DISK:-8}"
BRIDGE="${CT_BRIDGE:-vmbr0}"

cat <<'BANNER'
  __  __           _ _
 |  \/  |_   _ ___(_) | __
 | |\/| | | | / __| | |/ /
 | |  | | |_| \__ \ |   <
 |_|  |_|\__,_|___/_|_|\_\   Proxmox installer
BANNER

command -v pct >/dev/null || { echo "Run this on a Proxmox VE host (pct not found)." >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Please run as root." >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

# ---- existing container? then update it ----
EXISTING=""
for id in $(pct list | awk 'NR>1 {print $1}'); do
  if pct config "$id" 2>/dev/null | grep -Eq '^tags:.*\bmusik\b'; then EXISTING="$id"; break; fi
done

ask_tailscale() {
  if [ -z "${TAILSCALE+x}" ] && [ -r /dev/tty ]; then
    echo
    echo "Optional: Tailscale lets the apps reach Musik away from home (free, no port forwarding)."
    read -rp "Set up Tailscale? [y/N] " a </dev/tty || a=""
    case "$a" in [yYjJ]*) TAILSCALE=1 ;; *) TAILSCALE=0 ;; esac
  fi
  TAILSCALE="${TAILSCALE:-0}"
}

# Tailscale in an unprivileged container needs the tun device
add_tun() {
  local id="$1" conf="/etc/pve/lxc/$1.conf"
  grep -q 'dev/net/tun' "$conf" && return 1
  printf 'lxc.cgroup2.devices.allow: c 10:200 rwm\nlxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file\n' >> "$conf"
  return 0
}

ts_args() {
  [ "$TAILSCALE" = "1" ] || return 0
  printf ' --tailscale'
  [ -n "${TS_AUTHKEY:-}" ] && printf ' --ts-authkey %q' "$TS_AUTHKEY"
  return 0
}

run_inside() {
  local id="$1"; shift
  pct exec "$id" -- bash -c "$*"
}

show_links() {
  local id="$1" ip port
  ip="$(pct exec "$id" -- hostname -I 2>/dev/null | awk '{print $1}')"
  port="$(pct exec "$id" -- awk -F= '/^PORT=/{print $2}' /etc/musik.env 2>/dev/null || echo 8484)"
  port="${port:-8484}"
  local url="http://${ip:-<container-ip>}:$port" remote
  remote="$(pct exec "$id" -- awk -F= '/^REMOTE_URL=/{print $2}' /etc/musik.env 2>/dev/null || true)"
  pct set "$id" --description "$(printf '# Musik\n\nWeb app: %s\n\nServer address for the apps: %s\n\nOn the go (Tailscale): %s\n\nApps: https://github.com/%s/releases/latest\n\nUpdate: run the Proxmox script again or `musik-update` in the container.\n' "$url" "$url" "${remote:-not set up}" "$REPO")" >/dev/null
  echo
  echo "Done. Container $id"
  echo "  Web app:              $url"
  echo "  Server address (app): $url"
  [ -n "$remote" ] && echo "  On the go:            $remote   (Tailscale, the apps switch by themselves)"
  echo "  Downloads (APK/EXE):  https://github.com/$REPO/releases/latest"
  echo "  Logs:                 pct exec $id -- journalctl -u musik -f"
  echo "  Settings:             pct exec $id -- nano /etc/musik.env"
}

if [ -n "$EXISTING" ]; then
  step "Updating Musik in container $EXISTING"
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
  run_inside "$EXISTING" "curl -fsSL $RAW/install.sh | bash -s -- --update$(ts_args)"
  show_links "$EXISTING"
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
  --hostname musik \
  --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "$RSTORE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp,ip6=auto" \
  --unprivileged 1 --features nesting=1 \
  --onboot 1 --tags musik \
  --ostype debian >/dev/null
if [ -n "$MUSIC_HOST_DIR" ]; then
  pct set "$CTID" -mp0 "$MUSIC_HOST_DIR,mp=/srv/musik/library,ro=1" >/dev/null
fi
[ "$TAILSCALE" = "1" ] && add_tun "$CTID" || true
pct start "$CTID"

step "Waiting for network"
for _ in $(seq 1 60); do
  if pct exec "$CTID" -- bash -c 'hostname -I | grep -q "[0-9]" && getent hosts github.com >/dev/null' 2>/dev/null; then break; fi
  sleep 2
done

step "Installing Musik inside the container"
run_inside "$CTID" "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null && curl -fsSL $RAW/install.sh | bash -s -- --music /srv/musik$(ts_args)"
show_links "$CTID"
