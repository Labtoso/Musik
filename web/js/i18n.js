const de = {
  appName: 'Musik',
  home: 'Start', search: 'Suche', library: 'Bibliothek', likes: 'Lieblingssongs', playlists: 'Playlists', queue: 'Warteschlange',
  tracks: 'Titel', albums: 'Alben', album: 'Album', artist: 'Künstler', playlist: 'Playlist', artists: 'Künstler', settings: 'Einstellungen',
  mixForYou: 'Mix für dich', recent: 'Zuletzt gehört', rediscover: 'Wiederentdecken', newAlbums: 'Neue Alben', yourArtists: 'Deine Künstler',
  playAll: 'Abspielen', shuffle: 'Zufällig', play: 'Abspielen', pause: 'Pause', next: 'Weiter', prev: 'Zurück',
  repeat: 'Wiederholen', volume: 'Lautstärke', like: 'Gefällt mir', unlike: 'Gefällt mir nicht mehr',
  playNext: 'Als Nächstes', addQueue: 'Zur Warteschlange', addPlaylist: 'Zu Playlist hinzufügen', startRadio: 'Radio starten',
  goArtist: 'Zum Künstler', goAlbum: 'Zum Album', removeQueue: 'Aus Warteschlange entfernen', removePlaylist: 'Aus Playlist entfernen',
  newPlaylist: 'Neue Playlist', playlistName: 'Name der Playlist', create: 'Erstellen', cancel: 'Abbrechen', save: 'Speichern', delete: 'Löschen',
  rename: 'Umbenennen', deletePlaylistQ: 'Playlist „{name}“ löschen?', deleteUserQ: 'Nutzer „{name}“ löschen?',
  searchPlaceholder: 'Titel, Künstler oder Album', noResults: 'Nichts gefunden.', empty: 'Hier ist noch nichts.',
  emptyLibrary: 'Noch keine Musik. Lade Songs hoch oder lege sie in den Musikordner des Servers.',
  unknownArtist: 'Unbekannter Künstler', unknownAlbum: 'Unbekanntes Album', nothingPlaying: 'Nichts läuft',
  upNext: 'Als Nächstes', nowPlaying: 'Läuft gerade', clearQueue: 'Leeren', songs: '{n} Songs', song: '1 Song',
  reason_artist: 'Weil du {artist} hörst', reason_genre: 'Passt zu deinem Geschmack', reason_album: 'Aus einem Album, das du magst',
  reason_collab: 'Wird oft zusammen gehört', reason_favorite: 'Einer deiner Favoriten', reason_new: 'Neu für dich', reason_similar: 'Klingt ähnlich',
  coldHint: 'Je mehr du hörst, überspringst und likest, desto besser passt dein Mix.',
  server: 'Server', serverAddress: 'Server-Adresse', connect: 'Verbinden', changeServer: 'Server wechseln',
  serverHelp: 'Die Adresse zeigt der Server beim Start an, z. B. http://192.168.1.50:8484',
  serverUnreachable: 'Server nicht erreichbar. Adresse prüfen.', notMusik: 'Unter dieser Adresse läuft kein Musik-Server.',
  login: 'Anmelden', logout: 'Abmelden', name: 'Name', password: 'Passwort', newPassword: 'Neues Passwort', oldPassword: 'Altes Passwort',
  changePassword: 'Passwort ändern', firstAccount: 'Erstes Konto anlegen', firstAccountHelp: 'Dieses Konto verwaltet den Server und kann weitere Nutzer anlegen.',
  wrong_login: 'Name oder Passwort falsch.', password_short: 'Passwort muss mindestens 4 Zeichen haben.', invalid_name: 'Name: 2–32 Zeichen, nur Buchstaben, Zahlen, Leerzeichen, _ . -',
  name_taken: 'Name ist schon vergeben.', error: 'Etwas ist schiefgelaufen.',
  language: 'Sprache', accent: 'Akzentfarbe', blue: 'Blau', green: 'Grün', purple: 'Lila',
  look: 'Aussehen', dynColor: 'Farben aus dem Cover übernehmen',
  playback: 'Wiedergabe', autoplay: 'Passende Songs weiterspielen, wenn die Warteschlange leer ist',
  account: 'Konto', admin: 'Admin', users: 'Nutzer', addUser: 'Nutzer anlegen', isAdmin: 'Admin-Rechte',
  scan: 'Bibliothek neu einlesen', scanning: 'Wird eingelesen … {n} Dateien', lastScan: 'Zuletzt eingelesen: {date}',
  upload: 'Musik hochladen', uploading: 'Lade hoch: {name}', uploaded: '{n} Dateien hochgeladen', uploadFailed: 'Fehler bei {name}',
  folders: 'Musikordner', stats: '{tracks} Titel · {artists} Künstler · {albums} Alben',
  apps: 'Apps', androidApp: 'Android-App (APK)', windowsApp: 'Windows-App', allDownloads: 'Alle Downloads',
  version: 'Version', added: 'Hinzugefügt', saved: 'Gespeichert', addedTo: 'Zu „{name}“ hinzugefügt', addedQueue: 'Zur Warteschlange hinzugefügt',
  playsNext: 'Läuft als Nächstes', radioStarted: 'Radio gestartet', history: 'Verlauf', showAll: 'Alle anzeigen', top: 'Beliebt bei dir'
};

const en = {
  appName: 'Musik',
  home: 'Home', search: 'Search', library: 'Library', likes: 'Liked songs', playlists: 'Playlists', queue: 'Queue',
  tracks: 'Songs', albums: 'Albums', album: 'Album', artist: 'Artist', playlist: 'Playlist', artists: 'Artists', settings: 'Settings',
  mixForYou: 'Your mix', recent: 'Recently played', rediscover: 'Rediscover', newAlbums: 'New albums', yourArtists: 'Your artists',
  playAll: 'Play', shuffle: 'Shuffle', play: 'Play', pause: 'Pause', next: 'Next', prev: 'Previous',
  repeat: 'Repeat', volume: 'Volume', like: 'Like', unlike: 'Remove like',
  playNext: 'Play next', addQueue: 'Add to queue', addPlaylist: 'Add to playlist', startRadio: 'Start radio',
  goArtist: 'Go to artist', goAlbum: 'Go to album', removeQueue: 'Remove from queue', removePlaylist: 'Remove from playlist',
  newPlaylist: 'New playlist', playlistName: 'Playlist name', create: 'Create', cancel: 'Cancel', save: 'Save', delete: 'Delete',
  rename: 'Rename', deletePlaylistQ: 'Delete playlist “{name}”?', deleteUserQ: 'Delete user “{name}”?',
  searchPlaceholder: 'Song, artist or album', noResults: 'Nothing found.', empty: 'Nothing here yet.',
  emptyLibrary: 'No music yet. Upload songs or put them into the server’s music folder.',
  unknownArtist: 'Unknown artist', unknownAlbum: 'Unknown album', nothingPlaying: 'Nothing playing',
  upNext: 'Up next', nowPlaying: 'Now playing', clearQueue: 'Clear', songs: '{n} songs', song: '1 song',
  reason_artist: 'Because you listen to {artist}', reason_genre: 'Fits your taste', reason_album: 'From an album you like',
  reason_collab: 'Often played together', reason_favorite: 'One of your favourites', reason_new: 'New to you', reason_similar: 'Sounds similar',
  coldHint: 'The more you play, skip and like, the better your mix gets.',
  server: 'Server', serverAddress: 'Server address', connect: 'Connect', changeServer: 'Change server',
  serverHelp: 'The server prints its address on start, e.g. http://192.168.1.50:8484',
  serverUnreachable: 'Server not reachable. Check the address.', notMusik: 'No Musik server at this address.',
  login: 'Sign in', logout: 'Sign out', name: 'Name', password: 'Password', newPassword: 'New password', oldPassword: 'Old password',
  changePassword: 'Change password', firstAccount: 'Create first account', firstAccountHelp: 'This account manages the server and can add more users.',
  wrong_login: 'Wrong name or password.', password_short: 'Password needs at least 4 characters.', invalid_name: 'Name: 2–32 characters, letters, digits, space, _ . -',
  name_taken: 'Name is already taken.', error: 'Something went wrong.',
  language: 'Language', accent: 'Accent colour', blue: 'Blue', green: 'Green', purple: 'Purple',
  look: 'Look', dynColor: 'Take colours from the cover',
  playback: 'Playback', autoplay: 'Keep playing similar songs when the queue ends',
  account: 'Account', admin: 'Admin', users: 'Users', addUser: 'Add user', isAdmin: 'Admin rights',
  scan: 'Rescan library', scanning: 'Scanning … {n} files', lastScan: 'Last scan: {date}',
  upload: 'Upload music', uploading: 'Uploading: {name}', uploaded: '{n} files uploaded', uploadFailed: 'Failed: {name}',
  folders: 'Music folders', stats: '{tracks} songs · {artists} artists · {albums} albums',
  apps: 'Apps', androidApp: 'Android app (APK)', windowsApp: 'Windows app', allDownloads: 'All downloads',
  version: 'Version', added: 'Added', saved: 'Saved', addedTo: 'Added to “{name}”', addedQueue: 'Added to queue',
  playsNext: 'Plays next', radioStarted: 'Radio started', history: 'History', showAll: 'Show all', top: 'Your top songs'
};

const dicts = { de, en };
let lang = 'de';

export function setLang(l) {
  lang = dicts[l] ? l : 'de';
  document.documentElement.lang = lang;
}
export function getLang() {
  return lang;
}
export function t(key, vars = {}) {
  let s = dicts[lang][key] ?? dicts.de[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}
