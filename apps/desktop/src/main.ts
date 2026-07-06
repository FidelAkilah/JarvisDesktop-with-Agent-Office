/** HUD logic — a pure function of the agent-service event stream. */

import { Reactor, type CoreState } from './reactor';
import { Office } from './office/office';

declare global {
  interface Window {
    jarvis?: { onCommand: (cb: (cmd: string) => void) => void };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const reactor = new Reactor($('reactor') as unknown as HTMLCanvasElement);
const stateLabel = $('stateLabel');
const stateSub = $('stateSub');
const linkDot = $('linkDot');
const hdrText = $('hdrText');
const rosterEl = $('roster');
const transcriptEl = $('transcript');
const eventsEl = $('events');
const muteBtn = $('muteBtn');
const pttBtn = $('pttBtn');

const WS_URL = 'ws://127.0.0.1:4777/ws';
const SESSION = 'voice'; // shared with the voice loop → one continuous conversation

// ── state ─────────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let linkUp = false;
let model = '';
let voiceState: 'none' | 'armed' | 'listening' | 'talking' | 'muted' | 'off' = 'none';
let brainBusy = false;
let muted = false;
let lastSub = '';

interface AgentInfo { state: string; msg: string; ts: number; }
const agents = new Map<string, AgentInfo>();
agents.set('jarvis', { state: 'idle', msg: 'orchestrator', ts: 0 });

const totals = { tokens: 0, turns: 0, cost: 0, lastLatency: 0 };

// per-agent event history (feeds the click-to-inspect dossier)
const agentHistory = new Map<string, Record<string, any>[]>();
let selectedAgent: string | null = null;

/* ── pixel office ─────────────────────────────────────────────────────── */
const office = new Office((agentId) => {
  selectedAgent = agentId;
  renderDetail();
  $('agentDetail').hidden = false;
});

function renderDetail(): void {
  if (!selectedAgent) return;
  const info = agents.get(selectedAgent);
  const rows = (agentHistory.get(selectedAgent) ?? [])
    .slice(-12)
    .reverse()
    .map((e) => {
      const time = new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false });
      const body =
        [e.state, e.activity, e.tool && `${e.tool}${e.target ? ' → ' + e.target : ''}`, e.message]
          .filter(Boolean)
          .join(' · ');
      return `<div class="row"><span class="t">${time}</span><span class="b">${escapeHtml(body)}</span></div>`;
    })
    .join('');
  $('agentDetail').innerHTML =
    `<div class="d-head"><span class="d-name">${escapeHtml(selectedAgent)}</span>` +
    `<button class="d-close" id="dClose">✕</button></div>` +
    `<div class="d-state">status: <span class="st-${info?.state ?? ''}">${info?.state ?? '—'}</span>` +
    `${info?.msg ? ' · ' + escapeHtml(info.msg) : ''}</div>` +
    `<div class="d-log">${rows || '<div class="row"><span class="b">no activity yet</span></div>'}</div>`;
  document.getElementById('dClose')?.addEventListener('click', () => {
    selectedAgent = null;
    $('agentDetail').hidden = true;
  });
}

/* ── view toggle (CORE ⟷ OFFICE) ─────────────────────────────────────── */
async function setView(view: 'core' | 'office'): Promise<void> {
  document.body.classList.toggle('view-office', view === 'office');
  document.querySelectorAll('.vbtn').forEach((b) =>
    b.classList.toggle('active', (b as HTMLElement).dataset.view === view),
  );
  localStorage.setItem('jarvis-view', view);
  if (view === 'office') await office.mount($('officeMount'));
}
document.querySelectorAll('.vbtn').forEach((b) =>
  b.addEventListener('click', () => setView((b as HTMLElement).dataset.view as 'core' | 'office')),
);
if (localStorage.getItem('jarvis-view') === 'office') void setView('office');

// ── core state resolution (precedence encodes what matters most) ─────
function computeState(): { s: CoreState; sub: string } {
  if (!linkUp) return { s: 'offline', sub: 'agent service unreachable — is it running?' };
  if (voiceState === 'muted' || muted) return { s: 'muted', sub: 'microphone muted · ⌘⇧M to unmute' };
  if (voiceState === 'listening') return { s: 'listening', sub: lastSub || 'listening…' };
  if (voiceState === 'talking') return { s: 'speaking', sub: lastSub };
  if (brainBusy) return { s: 'thinking', sub: lastSub };
  if (voiceState === 'armed') return { s: 'armed', sub: 'say "Hey Jarvis" · ⌘⇧Space to talk' };
  return { s: 'standby', sub: 'link active · voice service not detected' };
}

function render(): void {
  const { s, sub } = computeState();
  reactor.state = s;
  office.setCoreMood(s === 'thinking' ? 'thinking' : s === 'muted' ? 'muted' : 'normal');
  stateLabel.textContent = s.toUpperCase();
  stateLabel.className =
    s === 'thinking' ? 'gold' : s === 'muted' ? 'red' : s === 'offline' || s === 'standby' ? 'dim' : '';
  stateSub.textContent = sub;
  linkDot.className = linkUp ? 'dot on' : 'dot';
  hdrText.textContent = linkUp ? `ONLINE · ${model || '…'}` : 'LINK DOWN — retrying';
  muteBtn.classList.toggle('active', muted);
  muteBtn.textContent = muted ? 'UNMUTE' : 'MUTE';
  renderRoster();
}

function renderRoster(): void {
  rosterEl.innerHTML = '';
  for (const [id, a] of agents) {
    const busy = ['thinking', 'working', 'talking', 'listening'].includes(a.state);
    const chip = document.createElement('div');
    chip.className = 'agent-chip' + (busy ? ' busy' : '');
    chip.innerHTML =
      `<span class="a-dot ${a.state}"></span>` +
      `<span class="a-name">${id}</span><span class="a-state">${a.state}</span>` +
      (a.msg ? `<span class="a-msg">${escapeHtml(a.msg)}</span>` : '');
    rosterEl.appendChild(chip);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ── transcript ────────────────────────────────────────────────────────
let pendingUser: HTMLElement | null = null;
let pendingJarvis: HTMLElement | null = null;

function bubble(cls: string, who: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.innerHTML = `<span class="who">${who}</span>`;
  el.appendChild(document.createTextNode(text));
  transcriptEl.appendChild(el);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return el;
}

function setBubbleText(el: HTMLElement, text: string): void {
  el.childNodes[1]!.textContent = text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function finalizeTurn(userText: string, reply: string): void {
  if (pendingUser) {
    setBubbleText(pendingUser, userText);
    pendingUser.classList.remove('pending');
  } else {
    bubble('user', 'you', userText);
  }
  pendingUser = null;
  if (pendingJarvis) {
    setBubbleText(pendingJarvis, reply);
    pendingJarvis.classList.remove('pending');
  } else {
    bubble('jarvis', 'jarvis', reply);
  }
  pendingJarvis = null;
}

// ── event feed ────────────────────────────────────────────────────────
function addEventRow(ev: Record<string, any>): void {
  const row = document.createElement('div');
  row.className = 'ev';
  const time = new Date(ev.ts).toLocaleTimeString('en-GB', { hour12: false });
  const who = ev.agentId && ev.agentId !== ev.source ? `${ev.agentId}` : '';
  const bits: string[] = [];
  if (ev.state) bits.push(`<span class="st ${ev.state}">${ev.state}</span>`);
  if (ev.activity) bits.push(`<span class="st">${ev.activity}</span>`);
  if (ev.tool) bits.push(`${ev.tool}${ev.target ? ` → ${escapeHtml(ev.target)}` : ''}`);
  if (ev.message) bits.push(escapeHtml(String(ev.message)));
  row.innerHTML =
    `<span class="t">${time}</span>` +
    `<span class="src ${ev.source}">${who || ev.source}</span>` +
    `<span class="body">${bits.join(' · ') || '—'}</span>`;
  eventsEl.appendChild(row);
  while (eventsEl.children.length > 150) eventsEl.firstChild!.remove();
  eventsEl.scrollTop = eventsEl.scrollHeight;
}

// ── event-stream interpretation ───────────────────────────────────────
function handleEvent(ev: Record<string, any>): void {
  addEventRow(ev);

  if (ev.agentId) {
    agents.set(ev.agentId, {
      state: ev.state ?? agents.get(ev.agentId)?.state ?? 'idle',
      msg: ev.message ?? '',
      ts: Date.now(),
    });
    const hist = agentHistory.get(ev.agentId) ?? [];
    hist.push(ev);
    if (hist.length > 30) hist.shift();
    agentHistory.set(ev.agentId, hist);
    office.handleEvent(ev as any);
    if (selectedAgent === ev.agentId) renderDetail();
  }

  if (ev.source === 'voice') {
    if (typeof ev.state === 'string') office.setVoiceState(ev.state);
    if (ev.state === 'idle') voiceState = ev.message === 'off' ? 'off' : 'armed';
    else if (ev.state === 'listening') { voiceState = 'listening'; lastSub = ''; }
    else if (ev.state === 'talking') voiceState = 'talking';
    else if (ev.state === 'waiting') voiceState = 'muted';
    else if (ev.state === 'thinking') {
      voiceState = 'armed';
      lastSub = ev.message ?? '';
      // final voice transcript — surface it as the pending user bubble
      if (ev.message) {
        if (!pendingUser) pendingUser = bubble('user pending', 'you', ev.message);
        else setBubbleText(pendingUser, ev.message);
      }
    }
    muted = voiceState === 'muted';
  }

  if (ev.source === 'orchestrator' && ev.agentId === 'jarvis') {
    if (ev.state === 'thinking') brainBusy = true;
    if (ev.state === 'idle' || ev.state === 'error' || ev.state === 'done') brainBusy = false;
    if (ev.state === 'error' && ev.message) bubble('jarvis errormsg', 'error', ev.message);
    if (ev.state === 'done' && ev.data) {
      totals.turns += 1;
      totals.tokens += ev.data.usage?.output_tokens ?? 0;
      totals.cost += ev.data.costUsd ?? 0;
      totals.lastLatency = (ev.data.durationMs ?? 0) / 1000;
      $('gTurns').textContent = String(totals.turns);
      $('gTokens').textContent = totals.tokens.toLocaleString();
      $('gCost').textContent = `$${totals.cost.toFixed(3)}`;
      $('gLatency').textContent = `${totals.lastLatency.toFixed(1)}s`;
      $('gLatencyBar').style.width = `${Math.min(totals.lastLatency / 10, 1) * 100}%`;
    }
  }

  render();
}

// ── websocket ─────────────────────────────────────────────────────────
function send(obj: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect(): void {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { linkUp = true; render(); };
  ws.onclose = () => {
    linkUp = false;
    voiceState = 'none';
    render();
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'hello':
        model = String(msg.model ?? '').replace('claude-', '').replace(/-/g, ' ').toUpperCase();
        render();
        break;
      case 'event':
        handleEvent(msg.event);
        break;
      case 'voice_level':
        reactor.pushLevel(Number(msg.level) || 0);
        break;
      case 'voice_partial':
        lastSub = msg.text;
        if (!pendingUser) pendingUser = bubble('user pending', 'you', msg.text);
        else setBubbleText(pendingUser, msg.text);
        render();
        break;
      case 'assistant_delta':
        if (msg.sessionId !== SESSION) break;
        if (!pendingJarvis) pendingJarvis = bubble('jarvis pending', 'jarvis', '');
        pendingJarvis.childNodes[1]!.textContent += msg.text;
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
        break;
      case 'chat_turn':
        if (msg.sessionId !== SESSION) break;
        finalizeTurn(msg.text, msg.reply);
        break;
    }
  };
}
connect();

// ── controls ──────────────────────────────────────────────────────────
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chatInput') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  pendingUser = bubble('user pending', 'you', text);
  send({ type: 'chat', sessionId: SESSION, channel: 'text', text });
  input.value = '';
});

muteBtn.addEventListener('click', () => send({ type: 'voice_cmd', cmd: 'toggle_mute' }));
pttBtn.addEventListener('click', () => send({ type: 'voice_cmd', cmd: 'ptt' }));

// Global hotkeys arrive from the Electron main process
window.jarvis?.onCommand((cmd) => {
  if (cmd === 'ptt' || cmd === 'toggle_mute') send({ type: 'voice_cmd', cmd });
});

// Debug hooks: inject a synthetic event exactly as if it came off the wire,
// or open an agent dossier (used by offline tests; local display only).
(window as any).__jarvisTestEvent = (ev: Record<string, any>) =>
  handleEvent({ id: 0, ts: new Date().toISOString(), ...ev });
(window as any).__jarvisOpenDetail = (agentId: string) => {
  selectedAgent = agentId;
  renderDetail();
  $('agentDetail').hidden = false;
};
(window as any).__jarvisOffice = office;

render();
