import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { CONFIG, REPO_ROOT } from './env.js';
import { createBrain } from './brain/index.js';
import type { JarvisEvent, NewEvent } from './events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = path.join(REPO_ROOT, 'data');

export function startServer(): http.Server {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const eventLog = fs.createWriteStream(path.join(DATA_DIR, 'events.jsonl'), {
    flags: 'a',
  });

  const brain = createBrain();
  const sockets = new Set<WebSocket>();
  let nextEventId = 1;

  const emit = (partial: NewEvent): JarvisEvent => {
    const event: JarvisEvent = {
      id: nextEventId++,
      ts: new Date().toISOString(),
      ...partial,
    };
    eventLog.write(JSON.stringify(event) + '\n');
    const payload = JSON.stringify({ type: 'event', event });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
    return event;
  };

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          brain: brain.name,
          model: CONFIG.model,
          authTokenPresent: CONFIG.hasOauthToken,
        }),
      );
      return;
    }
    // Phase 0 stub UI — a single static page. Replaced by the Electron-hosted
    // HUD in Phase 2.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.send(
      JSON.stringify({
        type: 'hello',
        brain: brain.name,
        model: CONFIG.model,
        authTokenPresent: CONFIG.hasOauthToken,
      }),
    );
    ws.on('close', () => sockets.delete(ws));

    const broadcast = (payload: string) => {
      for (const client of sockets) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    };

    ws.on('message', async (raw) => {
      let msg: {
        type?: string;
        text?: string;
        sessionId?: string;
        channel?: 'text' | 'voice';
        state?: string;
        message?: string;
        cmd?: string;
        level?: number;
      };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      // Voice sidecar reports its state (armed/listening/speaking…) — becomes
      // a first-class event so the HUD can render the mic state live.
      if (msg.type === 'voice_state' && typeof msg.state === 'string') {
        emit({
          source: 'voice',
          agentId: 'voice',
          state: msg.state as JarvisEvent['state'],
          message: typeof msg.message === 'string' ? msg.message : undefined,
        });
        return;
      }

      // High-frequency / transient traffic: mic levels (~12/s) and in-progress
      // transcripts. Relayed to every client but deliberately NOT written to
      // the event log.
      if (msg.type === 'voice_level' || msg.type === 'voice_partial') {
        broadcast(JSON.stringify(msg));
        return;
      }

      // UI → voice sidecar commands (push-to-talk, mute). Relayed to all
      // clients; the voice service acts on them and answers with voice_state.
      if (msg.type === 'voice_cmd' && typeof msg.cmd === 'string') {
        emit({ source: 'ui', message: `voice command: ${msg.cmd}` });
        broadcast(JSON.stringify({ type: 'voice_cmd', cmd: msg.cmd }));
        return;
      }

      if (msg.type !== 'chat' || typeof msg.text !== 'string') return;
      const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : 'default';

      emit({ source: 'ui', message: msg.text, data: { sessionId } });
      emit({ source: 'orchestrator', agentId: 'jarvis', state: 'thinking' });

      try {
        const channel = msg.channel === 'voice' ? 'voice' : 'text';
        const reply = await brain.chat({
          sessionId,
          text: msg.text,
          channel,
          // Deltas go to every client so the HUD streams replies live even for
          // turns initiated by the voice sidecar.
          onEvent: emit,
          onPartialText: (t) =>
            broadcast(JSON.stringify({ type: 'assistant_delta', sessionId, text: t })),
        });
        emit({
          source: 'orchestrator',
          agentId: 'jarvis',
          state: 'talking',
          message: reply.slice(0, 200),
        });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reply', sessionId, text: reply }));
        }
        // Full turn for every client's transcript (HUD shows voice turns too).
        broadcast(
          JSON.stringify({ type: 'chat_turn', sessionId, channel, text: msg.text, reply }),
        );
        emit({ source: 'orchestrator', agentId: 'jarvis', state: 'idle' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ source: 'orchestrator', agentId: 'jarvis', state: 'error', message });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', sessionId, message }));
        }
      }
    });
  });

  server.listen(CONFIG.port, '127.0.0.1', () => {
    console.log(
      `[jarvis-agentd] http://127.0.0.1:${CONFIG.port} · brain=${brain.name} · ` +
        `model=${CONFIG.model} · token=${CONFIG.hasOauthToken ? 'present' : 'MISSING (run: claude setup-token)'}`,
    );
    // Pre-spawn the voice session so the first spoken question pays no boot cost.
    (brain as { warm?: (id: string) => void }).warm?.('voice');
  });

  return server;
}
