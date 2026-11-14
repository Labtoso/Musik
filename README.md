# Musik

Your own music app, written mostly in Rust: a server for Proxmox (or any Linux, Docker, Windows), an Android app, a desktop app for Windows and Linux, and a web app. A recommendation engine learns from what you play, skip and like.

**Download page:** https://musik.labtoso.de · **Docs:** https://musik.labtoso.de/docs/ · **Releases:** https://github.com/Labtoso/Musik/releases/latest

The full guide (install, apps, on the go, sharing, offline, themes, help) lives in the [docs](https://musik.labtoso.de/docs/), in English and German. This README is the short version.

## Install the server

**Proxmox** (node shell): creates a Debian container, installs everything and prints the address.

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/proxmox.sh)"
```

Run it again to update. Optional: `MUSIC_HOST_DIR=/mnt/pve/nas/music` mounts a host folder read-only into the container.

**Debian / Ubuntu:** `curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/install.sh | sudo bash`
(settings in `/etc/musik.env`, update with `musik-update`)

**ZimaOS / CasaOS:** `curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/zimaos.sh | bash` (shows up as an app on the dashboard, songs in `Media/Music`)

**Docker:** `docker compose up -d --build` (music in `./music`, data in `./data`)

**Windows:** download `musik-server-windows-x64.exe` from the release and start it. It uses your Music folder (or set `MUSIC_DIRS` in a `.env` next to the exe).

**On the go (Tailscale):** answer `y` when the Proxmox script asks, or add `--tailscale` to the Debian command. The apps then switch to the Tailscale address by themselves when you are away. Step by step guide (German): [docs/tailscale.md](docs/tailscale.md)

**Public links:** answer `y` to "Switch on public links?" (or `PUBLIC=1`) and shared playlists open for anyone at `musik.labtoso.de/s/#…`, through Tailscale Funnel. See [docs/tailscale.md](docs/tailscale.md#public).

**Other platforms, sharing, equalizer, lyrics:** the setup assistant asks where songs may come from. Spotify songs play in full: names and covers from Spotify, the sound from YouTube Music through your server. Import playlists by link or file, share by link, use the 10-band equalizer and synced lyrics. Guide (German): [docs/plattformen.md](docs/plattformen.md)

**Offline:** download playlists in the Android and desktop app, they play without the server.

Open `http://<server>:8484` and create the first account. It is the admin and can add more users.

## Apps

| App | File | Notes |
|---|---|---|
| Android | `Musik.apk` | Background playback, notification and lock screen controls |
| Windows | `Musik.exe` | Setup, media keys work |
| Linux | `Musik.AppImage` | Runs without install |

Each app asks for the server address once (for example `http://192.168.1.50:8484`).

## Recommendations

- **Mix for you:** scores every song from your artist, genre and album affinity, songs other users play together with yours, your favourites, plus a bonus for songs you have not heard. Songs played in the last hours move down, songs you keep skipping drop out.
- **Radio:** starts from one song and keeps playing similar songs (same artist, genre, era, songs heard together). It also continues the queue when it runs out.
- **Smart shuffle:** favourites come up earlier more often, and the same artist never plays twice in a row when it can be avoided.

Plays, skips (under 30 s or 25 %), full plays and likes are the signals, with a half-life of 30 days.

## Project layout

| Folder | Content |
|---|---|
| `server/` | Rust server (axum, SQLite): API, library scan, streaming, recommendations; the web app is built into the binary |
| `web/` | Web app (HTML/CSS/JS), used by the browser, the desktop app and the Android app |
| `desktop/` | Tauri app (Rust) for Windows and Linux |
| `android/` | Android app (Kotlin, Media3/ExoPlayer) |
| `deploy/` | Proxmox and Linux installers |
| `site/` | Download page (musik.labtoso.de) |

## Development

```bash
cd server && cargo run                      # http://localhost:8484
cd server && cargo test && cargo build && node --test tests/api.test.mjs
cd desktop && npm install && npx tauri dev
cd android && ./gradlew assembleDebug
```

Raising the number in `VERSION` and pushing to `main` builds the server binaries, the APK, the Windows setup and the AppImage and publishes them as release `v<VERSION>` (notes from `.github/releases/v<VERSION>.md`).

© LabtosoStudios
