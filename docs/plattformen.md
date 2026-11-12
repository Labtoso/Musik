# Plattformen, Import, Teilen, Equalizer, Songtexte

## Plattformen wählen
Beim ersten Start fragt die App, woher Songs kommen dürfen. Ändern geht jederzeit unter **Einstellungen → Quellen**.

| Quelle | Import | Abspielen |
|---|---|---|
| Lokal | – | immer, hat Vorrang |
| YouTube | Playlist-Link (ohne Schlüssel), mit API-Schlüssel genauer | offizieller YouTube-Player (kleines Fenster, im Vollbild über dem Cover) |
| YouTube Music | Playlist-Link | über den YouTube-Player |
| Spotify | eigene Playlists, Lieblingssongs, Alben | Web Playback SDK (Premium) oder Spotify Connect auf einem anderen Gerät |
| SoundCloud | Playlist- oder Track-Link | offizielles SoundCloud-Widget |
| Deezer | Playlist- oder Album-Link | lokal, wenn der Song bei dir liegt |
| Datei | CSV (z. B. Exportify), M3U, TXT | lokal, wenn der Song bei dir liegt |

Jeder importierte Song wird mit deiner Bibliothek abgeglichen (Titel, Künstler, Länge). Treffer spielen lokal, der Rest über die Plattform, wenn sie eingeschaltet ist. Ausgeschaltete Plattformen werden grau angezeigt und übersprungen.

## Spotify einrichten
1. Auf https://developer.spotify.com/dashboard eine App anlegen, **Web API** und **Web Playback SDK** anhaken.
2. Als Redirect URI die Adresse eintragen, die die App unter **Quellen → Spotify** anzeigt. Spotify verlangt `https`, nimm also die Tailscale-Adresse (siehe [tailscale.md](tailscale.md)).
3. Die Client-ID in der App einfügen und **Mit Spotify verbinden** drücken. Alternativ einen Token einfügen.

Seit Februar 2026 gilt für neue Spotify-Apps: Der App-Besitzer braucht Premium, höchstens 5 Nutzer, und Playlist-Inhalte gibt es nur für eigene oder gemeinsame Playlists. Fremde Playlists also vorher in die eigene Bibliothek kopieren oder per Exportify als CSV importieren.

## YouTube-Schlüssel (optional)
Ohne Schlüssel liest die App Playlists über den eingebetteten Player. Mit Schlüssel (Google Cloud, YouTube Data API v3) gibt es genauere Titel und die Suche nach YouTube-Songs.

## Teilen
Bei Songs, Alben und Playlists auf **Teilen** tippen. Der Link `/s/<code>` öffnet eine Seite, auf der jeder reinhören kann, auch ohne Konto. Wer im selben Browser angemeldet ist, speichert die Playlist mit **In meiner Bibliothek speichern**. Damit Freunde den Link unterwegs öffnen können, muss der Server für sie erreichbar sein (z. B. Tailscale Funnel oder eigene Domain).

## Equalizer
**Einstellungen → Equalizer**: 10 Bänder von 31 Hz bis 16 kHz, Vorverstärkung und Presets. Im Browser und am PC über WebAudio, auf Android über den System-Equalizer. Songs von YouTube, SoundCloud und Spotify lassen sich nicht verändern.

## Songtexte
Knopf **Songtext** im Player. Zuerst wird der Text aus der Datei gelesen, sonst von LRCLIB geholt (kostenlos, ohne Schlüssel). Synchrone Texte laufen mit und lassen sich antippen, um an die Stelle zu springen.
