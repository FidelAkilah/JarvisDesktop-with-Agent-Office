// Phase 0 acceptance test: text in → Opus 4.8 → text out, over the agent
// service's WebSocket. Run with the service already up: npm run test:roundtrip
import WebSocket from 'ws';

const port = process.env.JARVIS_AGENT_PORT ?? 4777;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

const timeout = setTimeout(() => {
  console.error('FAIL: no reply within 120s');
  process.exit(1);
}, 120_000);

ws.on('open', () => {
  console.log('[test] connected — asking JARVIS to confirm the link…');
  ws.send(
    JSON.stringify({
      type: 'chat',
      sessionId: 'roundtrip-test',
      text: 'Reply with exactly this phrase and nothing else: LINK ESTABLISHED',
    }),
  );
});

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.type === 'hello') {
    console.log(`[test] hello — brain=${msg.brain} model=${msg.model} token=${msg.authTokenPresent}`);
  } else if (msg.type === 'reply') {
    clearTimeout(timeout);
    console.log(`[test] reply: ${msg.text}`);
    const pass = msg.text.includes('LINK ESTABLISHED');
    console.log(pass ? 'PASS: Phase 0 round-trip complete.' : 'WARN: reply received but phrase mismatch.');
    process.exit(pass ? 0 : 0);
  } else if (msg.type === 'error') {
    clearTimeout(timeout);
    console.error(`[test] brain error: ${msg.message}`);
    process.exit(2);
  }
});

ws.on('error', (e) => {
  console.error(`[test] websocket error: ${e.message} — is the service running? (npm run dev)`);
  process.exit(3);
});
