const { app, BrowserWindow, ipcMain, net, shell, nativeTheme, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const configFile = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
}

function normalize(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!u.port && u.protocol === 'http:' && !/\.[a-z]{2,}$/i.test(u.hostname)) u.port = '8484';
    return u.origin;
  } catch {
    return '';
  }
}

async function checkServer(origin) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await net.fetch(origin + '/api/info', { signal: ctrl.signal, cache: 'no-store' });
    const j = await r.json();
    return j && j.app === 'musik' ? 'ok' : 'notmusik';
  } catch {
    return 'offline';
  } finally {
    clearTimeout(timer);
  }
}

let win = null;

function showConnect(error = '') {
  const cfg = readConfig();
  win.loadFile(path.join(__dirname, 'connect.html'), { query: { server: cfg.server || '', error } });
}

async function openServer(origin) {
  const state = await checkServer(origin);
  if (state !== 'ok') return showConnect(state);
  win.loadURL(origin + '/');
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  const cfg = readConfig();
  const b = cfg.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1280,
    height: b.height || 820,
    x: b.x,
    y: b.y,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#111214',
    title: 'Musik',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => {
    if (cfg.maximized) win.maximize();
    win.show();
  });
  win.on('close', () => {
    const c = readConfig();
    c.maximized = win.isMaximized();
    if (!c.maximized) c.bounds = win.getBounds();
    writeConfig(c);
  });
  // Links to other sites open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const server = readConfig().server;
    if (url.startsWith('file:') || (server && url.startsWith(server))) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && !url.startsWith('file:')) showConnect('offline');
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F5') win.webContents.reload();
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  if (cfg.server) openServer(cfg.server);
  else showConnect();
}

ipcMain.handle('musik:connect', async (_e, input) => {
  const origin = normalize(input);
  if (!origin) return 'offline';
  const state = await checkServer(origin);
  if (state !== 'ok') return state;
  const c = readConfig();
  c.server = origin;
  writeConfig(c);
  win.loadURL(origin + '/');
  return 'ok';
});
ipcMain.handle('musik:change-server', () => {
  showConnect();
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
