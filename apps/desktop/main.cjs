/* JARVIS desktop shell: window + tray + global hotkeys + sidecar lifecycle.
 * The renderer (HUD) talks to the agent service directly over WebSocket;
 * this process only manages OS integration. */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  systemPreferences,
  nativeImage,
} = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEV = !!process.env.JARVIS_DEV;
const AGENT_PORT = 4777;

let win = null;
let tray = null;
let quitting = false;
const children = [];

// ── sidecars ─────────────────────────────────────────────────────────
function agentHealthy(cb) {
  http
    .get({ host: '127.0.0.1', port: AGENT_PORT, path: '/health', timeout: 1500 }, (res) =>
      cb(res.statusCode === 200),
    )
    .on('error', () => cb(false));
}

function wireChild(child, name) {
  children.push(child);
  const log = fs.createWriteStream(path.join(os.tmpdir(), `jarvis-${name}.log`), { flags: 'a' });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.on('exit', (code) => {
    if (!quitting) console.log(`[shell] ${name} exited (${code})`);
  });
}

function spawnSidecars() {
  agentHealthy((up) => {
    if (up) {
      console.log('[shell] agent service already running — reusing it');
    } else {
      const tsx = path.join(REPO_ROOT, 'services/agent/node_modules/.bin/tsx');
      const child = spawn(tsx, ['src/index.ts'], {
        cwd: path.join(REPO_ROOT, 'services/agent'),
        env: process.env,
      });
      wireChild(child, 'agent');
    }
    // Voice starts a beat later so the agent hub is accepting connections.
    setTimeout(() => {
      const uvHome = path.join(os.homedir(), '.local/bin/uv');
      const uv = fs.existsSync(uvHome) ? uvHome : 'uv';
      const child = spawn(uv, ['run', 'python', '-m', 'jarvis_voice'], {
        cwd: path.join(REPO_ROOT, 'services/voice'),
        env: process.env,
      });
      wireChild(child, 'voice');
    }, 1500);
  });
}

// ── window ───────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#030608',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  });

  // Surface renderer problems in the shell log — invaluable when the window
  // renders blank/unstyled.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[renderer:${level}]`, message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log('[renderer] failed to load', code, desc, url);
  });

  const distIndex = path.join(__dirname, 'dist', 'index.html');
  if (!DEV && fs.existsSync(distIndex)) {
    win.loadFile(distIndex);
  } else {
    win.loadURL('http://localhost:5173');
  }

  // Closing the window hides it — JARVIS stays alive in the tray.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function sendCmd(cmd) {
  win?.webContents.send('jarvis-cmd', cmd);
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else {
    win.show();
    win.focus();
  }
}

// ── app lifecycle ────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    await systemPreferences.askForMediaAccess('microphone');
  } catch {
    /* prompt declined — voice will simply hear nothing; HUD still works */
  }

  createWindow();
  spawnSidecars();

  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('◉');
  tray.setToolTip('JARVIS');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show HUD', click: () => { win?.show(); win?.focus(); } },
      { label: 'Push to talk', accelerator: 'Cmd+Shift+Space', click: () => sendCmd('ptt') },
      { label: 'Mute / unmute', accelerator: 'Cmd+Shift+M', click: () => sendCmd('toggle_mute') },
      { type: 'separator' },
      { label: 'Quit JARVIS', accelerator: 'Cmd+Q', click: () => app.quit() },
    ]),
  );

  globalShortcut.register('CommandOrControl+Shift+J', toggleWindow);
  globalShortcut.register('CommandOrControl+Shift+Space', () => sendCmd('ptt'));
  globalShortcut.register('CommandOrControl+Shift+M', () => sendCmd('toggle_mute'));
});

app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
});

app.on('window-all-closed', () => {
  /* stay alive in the tray — quit only via Cmd+Q or the tray menu */
});

app.on('activate', () => {
  win?.show();
});
