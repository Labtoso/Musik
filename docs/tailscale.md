# Musik unterwegs hören (Tailscale)

Zuhause im WLAN finden die Apps deinen Server direkt. Damit das auch unterwegs klappt, verbindet Tailscale dein Handy und deinen Server über ein privates Netz. Es braucht keine Portfreigabe am Router, keine eigene Domain und kein Zertifikat. Für den privaten Gebrauch ist Tailscale kostenlos.

Sobald Tailscale läuft, merkt sich jede App die Adresse für unterwegs. Ist der Server zuhause nicht erreichbar, wechselt die App von selbst dorthin.

## 1. Tailscale-Konto anlegen

Melde dich auf [tailscale.com](https://login.tailscale.com/start) an, zum Beispiel mit Google, Microsoft oder GitHub. Benutze für alle Geräte dasselbe Konto.

## 2. Server einrichten

### Proxmox

Führe in der Shell des Proxmox-Knotens den Installer aus, so wie bei der Installation:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/proxmox.sh)"
```

Bei der Frage **„Set up Tailscale? [y/N]“** gibst du `y` ein. Das geht bei einer neuen Installation und auch bei einem schon laufenden Container.

1. Der Installer gibt dem Container Zugriff auf das Tunnel-Gerät, das Tailscale braucht, und startet ihn einmal neu.
2. Danach erscheint ein Link `https://login.tailscale.com/a/...`. Öffne ihn, melde dich an und bestätige das Gerät **musik**.
3. Am Ende steht die Adresse für unterwegs, zum Beispiel:

   ```
   On the go:  https://musik.tail1234.ts.net
   ```

Du findest sie auch in der Proxmox-Oberfläche in den Notizen des Containers.

Wenn du keinen Link öffnen willst, kannst du einen Auth-Key benutzen. Den legst du in der Tailscale-Verwaltung unter **Settings → Keys** an:

```bash
TAILSCALE=1 TS_AUTHKEY=tskey-auth-xxxxx bash -c "$(curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/proxmox.sh)"
```

### Debian oder Ubuntu (ohne Proxmox)

```bash
curl -fsSL https://raw.githubusercontent.com/Labtoso/Musik/main/deploy/install.sh | sudo bash -s -- --tailscale
```

### Docker oder Windows

Installiere Tailscale auf dem Rechner, auf dem der Server läuft, von [tailscale.com/download](https://tailscale.com/download). Trag dann die Adresse in die Einstellungen des Servers ein:

- **Docker:** in `docker-compose.yml` unter `environment`
- **Windows:** in die `.env` neben der exe

```
REMOTE_URL=http://100.x.y.z:8484
```

Die Adresse `100.x.y.z` zeigt dir die Tailscale-App auf diesem Rechner an. Starte danach den Server neu.

## 3. Handy und PC verbinden

1. Installiere die Tailscale-App:
   - Android: [Play Store](https://play.google.com/store/apps/details?id=com.tailscale.ipn)
   - Windows, Linux, macOS: [tailscale.com/download](https://tailscale.com/download)
2. Melde dich mit demselben Konto an und schalte Tailscale ein.
3. Öffne Musik einmal zuhause im WLAN. Dabei merkt sich die App die Adresse für unterwegs.

Das war's. Unterwegs probiert die App zuerst die Adresse zuhause und wechselt dann nach ein paar Sekunden auf Tailscale.

Beim ersten Wechsel musst du dich einmal neu anmelden, weil es für die App eine andere Adresse ist. Danach bleibst du angemeldet.

Du kannst die Tailscale-Adresse auch direkt als Server-Adresse in der App eintragen. Mit eingeschaltetem Tailscale klappt das zuhause und unterwegs.

In der App siehst du die Adresse unter **Einstellungen → Unterwegs**.

## Wenn es nicht klappt

| Problem | Lösung |
|---|---|
| Kein Link erscheint, Fehler `/dev/net/tun` | Führe den Proxmox-Installer noch mal aus und antworte mit `y`. Er ergänzt das Gerät und startet den Container neu. |
| Die Adresse beginnt mit `http://100.` statt `https://` | In der Tailscale-Verwaltung unter **DNS** sind MagicDNS oder HTTPS-Zertifikate aus. Das funktioniert trotzdem. Für den schöneren Namen schaltest du beides ein und führst den Installer noch mal aus. |
| Unterwegs kommt „Server nicht erreichbar“ | Prüfe, ob Tailscale auf dem Handy eingeschaltet ist (Schlüssel-Symbol in der Statusleiste) und ob du dasselbe Konto benutzt. |
| Akku-Sparmodus beendet Tailscale | Nimm Tailscale in den Android-Einstellungen von der Akku-Optimierung aus. |

Status im Container ansehen:

```bash
pct exec <ID> -- tailscale status
pct exec <ID> -- tailscale serve status
```
