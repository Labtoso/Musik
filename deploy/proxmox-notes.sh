#!/usr/bin/env bash
# Keeps the notes of Streyn containers on a Proxmox host up to date (Summary -> Notes).
# Installed by proxmox.sh as /usr/local/bin/streyn-proxmox-notes, run by a timer every 5 minutes.
#   streyn-proxmox-notes                 refresh every Streyn container whose server version changed
#   streyn-proxmox-notes <id> [install|update]   write the notes of one container now
set -uo pipefail
REPO="Labtoso/Musik"
STATE=/var/lib/streyn-notes
mkdir -p "$STATE"

inside() { pct exec "$1" -- bash -c "$2" 2>/dev/null; }

containers() {
  for id in $(pct list 2>/dev/null | awk 'NR>1 {print $1}'); do
    pct config "$id" 2>/dev/null | grep -Eq '^tags:.*\b(streyn|musik)\b' && echo "$id"
  done
}

version_of() { # id port
  inside "$1" "curl -fsS --max-time 5 http://127.0.0.1:$2/api/info" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

write_notes() { # id mode version port
  local id="$1" mode="$2" version="$3" port="$4" ip url remote music ts when
  ip="$(inside "$id" 'hostname -I' | awk '{print $1}')"
  url="http://${ip:-<container-ip>}:$port"
  remote="$(inside "$id" "awk -F= '/^REMOTE_URL=/{print \$2}' /etc/streyn.env /etc/musik.env" | head -n1)"
  music="$(inside "$id" "awk -F= '/^MUSIC_DIRS=/{print \$2}' /etc/streyn.env /etc/musik.env" | head -n1)"
  ts="$(inside "$id" 'command -v tailscale >/dev/null && tailscale ip -4 | head -n1')"
  when="$(date '+%Y-%m-%d %H:%M')"
  pct set "$id" --description "$(cat <<NOTES
<div align='center'><a href='https://musik.labtoso.de'><img src='https://musik.labtoso.de/icon.svg' width='72' alt='Streyn'/></a>

## Streyn server ${version:+v$version}

Your own music server for Android, Windows, Linux and the browser.
</div>

| | |
|---|---|
| **Version** | ${version:-unknown} |
| **Web app** | [$url]($url) |
| **Server address for the apps** | \`$url\` |
| **On the go (Tailscale)** | ${remote:-not set up} |
| **Tailscale IP** | ${ts:--} |
| **Music folder** | \`${music:-/srv/streyn}\` |
| **Last ${mode:-update}** | $when |

**Update:** in the app (Settings -> Updates), run the Proxmox script again on this node, or \`streyn-update\` inside the container. These notes follow the version by themselves.
**Logs:** \`pct exec $id -- journalctl -u streyn -f\`
**Settings:** \`pct exec $id -- nano /etc/streyn.env\`

[Download the apps](https://github.com/$REPO/releases/latest) · [Docs](https://musik.labtoso.de/docs.html) · [Website](https://musik.labtoso.de)
NOTES
)" >/dev/null 2>&1 && echo "$version" > "$STATE/$id.version"
}

refresh() { # id [mode] [force]
  local id="$1" mode="${2:-update}" force="${3:-}" port version
  [ "$(pct status "$id" 2>/dev/null | awk '{print $2}')" = running ] || return 0
  port="$(inside "$id" "awk -F= '/^PORT=/{print \$2}' /etc/streyn.env /etc/musik.env" | head -n1)"
  port="${port:-8484}"
  version="$(version_of "$id" "$port")"
  [ -n "$version" ] || [ -n "$force" ] || return 0
  if [ -z "$force" ] && [ "$(cat "$STATE/$id.version" 2>/dev/null)" = "$version" ]; then return 0; fi
  write_notes "$id" "$mode" "$version" "$port"
}

if [ $# -ge 1 ]; then
  refresh "$1" "${2:-update}" force
else
  for id in $(containers); do refresh "$id"; done
fi
exit 0
