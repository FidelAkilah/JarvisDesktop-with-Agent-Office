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

/* ── crash-proof logging ──────────────────────────────────────────────
 * macOS fast-user-switching can close stdout/child pipes mid-write; a bare
 * console.log or stream.pipe then throws ERR_STREAM_WRITE_AFTER_END and an
 * uncaught exception kills the whole shell. An always-on assistant never
 * dies to a broken pipe. */
function safeAppend(file, text) {
  try {
    fs.appendFileSync(file, text);
  } catch {
    /* even the log file can fail — never throw from logging */
  }
}
const SHELL_LOG = path.join(os.tmpdir(), 'jarvis-shell.log');
function slog(...args) {
  const line = `${new Date().toISOString()} ${args.map(String).join(' ')}\n`;
  safeAppend(SHELL_LOG, line);
  try {
    process.stdout.write(line);
  } catch {
    /* stdout may be a closed pipe — file log above is the source of truth */
  }
}
process.on('uncaughtException', (err) => slog('[shell] uncaught:', err?.stack ?? err));
process.on('unhandledRejection', (err) => slog('[shell] unhandled rejection:', err));

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
  child.jarvisName = name;
  children.push(child);
  // no .pipe(): a closed destination mid-write must never throw
  const logFile = path.join(os.tmpdir(), `jarvis-${name}.log`);
  const forward = (chunk) => safeAppend(logFile, chunk.toString());
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});
  child.on('error', (err) => slog(`[shell] ${name} spawn error:`, err));
  child.on('exit', (code) => {
    children = children.filter((c) => c !== child);
    if (!quitting && !restarting) {
      slog(`[shell] ${name} exited (${code}) — respawning in 3s`);
      setTimeout(() => spawnOne(name), 3000);
    }
  });
}

function spawnOne(name) {
  if (quitting) return;
  if (children.some((c) => c.jarvisName === name)) return; // never double-spawn
  if (name === 'agent') {
    // Finder-launched apps get a bare PATH with no `node` — so don't need one:
    // Electron's own binary IS Node when ELECTRON_RUN_AS_NODE is set. Run the
    // tsx JS entry directly (its bin wrapper needs `env node`, which fails).
    const tsxCli = path.join(REPO_ROOT, 'services/agent/node_modules/tsx/dist/cli.mjs');
    wireChild(
      spawn(process.execPath, [tsxCli, 'src/index.ts'], {
        cwd: path.join(REPO_ROOT, 'services/agent'),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }),
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
    if (up) slog('[shell] agent service already running — reusing it');
    else spawnOne('agent');
    setTimeout(() => spawnOne('voice'), 1500);
  });

  // Watchdog: a reused (externally started) brain can die without us owning
  // it — e.g. a macOS user switch killing the dev process. Health-check every
  // 15 s and take over whenever the brain is missing.
  setInterval(() => {
    if (quitting || restarting) return;
    if (children.some((c) => c.jarvisName === 'agent')) return; // ours; exit-respawn covers it
    agentHealthy((up) => {
      if (!up && !quitting && !restarting && !children.some((c) => c.jarvisName === 'agent')) {
        slog('[shell] brain missing — spawning our own agent service');
        spawnOne('agent');
      }
    });
  }, 15_000);
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
    if (level >= 2) slog(`[renderer:${level}]`, message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    slog('[renderer] failed to load', code, desc, url);
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
