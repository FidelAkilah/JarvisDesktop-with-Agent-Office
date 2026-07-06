/* JARVIS desktop shell: window + tray + global hotkeys + sidecar lifecycle +
 * settings. The renderer (HUD) talks to the agent service over WebSocket;
 * this process owns OS integration and the .env-backed settings. */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  systemPreferences,
  nativeImage,
} = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

/* When packaged, Resources/app/home.json (baked by scripts/package-app.sh)
 * points at the repo, where the sidecars and .env live. In dev, the repo is
 * two directories up. */
function resolveRepoRoot() {
  try {
    const baked = JSON.parse(fs.readFileSync(path.join(__dirname, 'home.json'), 'utf8'));
    if (baked.repoRoot && fs.existsSync(baked.repoRoot)) return baked.repoRoot;
  } catch {
    /* dev mode */
  }
  return path.resolve(__dirname, '..', '..');
}
const REPO_ROOT = resolveRepoRoot();
const ENV_PATH = path.join(REPO_ROOT, '.env');
const DEV = !!process.env.JARVIS_DEV;
const AGENT_PORT = 4777;

const SETTING_KEYS = ['JARVIS_MODEL', 'JARVIS_WHISPER_MODEL', 'JARVIS_TTS_VOICE', 'JARVIS_WAKE_THRESHOLD'];

let win = null;
let tray = null;
let quitting = false;
let children = [];

// Only one JARVIS. A second launch focuses the existing window instead of
// spawning a second app (and a second microphone).
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  win?.show();
  win?.focus();
});

/* ── sidecars ─────────────────────────────────────────────────────────── */

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
    children = children.filter((c) => c !== child);
    if (!quitting && !restarting) {
      console.log(`[shell] ${name} exited (${code}) — respawning in 3s`);
      setTimeout(() => spawnOne(name), 3000);
    }
  });
}

function spawnOne(name) {
  if (quitting) return;
  if (name === 'agent') {
    const tsx = path.join(REPO_ROOT, 'services/agent/node_modules/.bin/tsx');
    wireChild(
      spawn(tsx, ['src/index.ts'], { cwd: path.join(REPO_ROOT, 'services/agent'), env: process.env }),
      'agent',
    );
  } else if (name === 'voice') {
    const uvHome = path.join(os.homedir(), '.local/bin/uv');
    const uv = fs.existsSync(uvHome) ? uvHome : 'uv';
    wireChild(
      spawn(uv, ['run', 'python', '-m', 'jarvis_voice'], {
        cwd: path.join(REPO_ROOT, 'services/voice'),
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      }),
      'voice',
    );
  }
}

function spawnSidecars() {
  agentHealthy((up) => {
    if (up) console.log('[shell] agent service already running — reusing it');
    else spawnOne('agent');
    setTimeout(() => spawnOne('voice'), 1500);
  });
}

let restarting = false;
async function restartSidecars() {
  restarting = true;
  for (const c of children.splice(0)) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
  restarting = false;
  spawnOne('agent');
  setTimeout(() => spawnOne('voice'), 2500);
}

/* ── settings (.env-backed) ──────────────────────────────────────────── */

function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* missing .env */
  }
  return out;
}

function writeEnvValues(values) {
  let text = '';
  try {
    text = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    /* create fresh */
  }
  for (const [key, val] of Object.entries(values)) {
    if (!SETTING_KEYS.includes(key)) continue;
    const line = `${key}=${val}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : text + `\n${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, text);
}

ipcMain.handle('jarvis-get-settings', () => {
  const env = readEnv();
  return {
    values: Object.fromEntries(SETTING_KEYS.map((k) => [k, env[k] ?? ''])),
    packaged: app.isPackaged,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    micStatus: systemPreferences.getMediaAccessStatus('microphone'),
  };
});

ipcMain.handle('jarvis-apply-settings', async (_e, payload) => {
  try {
    writeEnvValues(payload.values ?? {});
    if (app.isPackaged && typeof payload.openAtLogin === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: payload.openAtLogin });
    }
    await restartSidecars();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* ── window ───────────────────────────────────────────────────────────── */

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

/* ── app lifecycle ────────────────────────────────────────────────────── */

app.whenReady().then(async () => {
  try {
    await systemPreferences.askForMediaAccess('microphone');
  } catch {
    /* declined — HUD settings shows the status */
  }

  if (!app.isPackaged) {
    // dev runs get the reactor icon in the dock too
    try {
      app.dock?.setIcon(path.join(__dirname, 'build', 'icon.png'));
    } catch {
      /* icon not generated yet */
    }
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
