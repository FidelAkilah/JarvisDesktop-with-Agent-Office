/** The vault memory index: local embeddings (MiniLM via transformers.js,
 * fully offline after first model download) over every markdown note in the
 * JARVIS vault folder. Re-indexes incrementally when notes change, so
 * anything written in Obsidian becomes recallable within seconds. */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, REPO_ROOT } from '../env.js';

const INDEX_PATH = path.join(REPO_ROOT, 'data', 'vault-index.json');
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const MAX_FILE_BYTES = 100_000;
const CHUNK_TARGET = 900; // chars

export interface VaultHit {
  file: string; // vault-relative, e.g. "Memory/fidel-preferences.md"
  heading: string;
  text: string;
  score: number;
}

interface Chunk {
  heading: string;
  text: string;
  vector: number[];
}

interface FileEntry {
  mtime: number;
  chunks: Chunk[];
}

/* ── embeddings ──────────────────────────────────────────────────────── */

let pipePromise: Promise<any> | null = null;

function embedder(): Promise<any> {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      (env as any).cacheDir = path.join(REPO_ROOT, 'data', 'models');
      return pipeline('feature-extraction', MODEL, { dtype: 'q8' } as any);
    })();
  }
  return pipePromise;
}

async function embed(text: string): Promise<number[]> {
  const pipe = await embedder();
  const out = await pipe(text.slice(0, 2000), { pooling: 'mean', normalize: true });
  return Array.from(out.data as Float32Array);
}

const dot = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/* ── chunking: split notes by headings, then into ~900-char pieces ───── */

function chunkNote(relFile: string, raw: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  const lines = raw.split('\n');
  let heading = path.basename(relFile, '.md');
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    buf = [];
    if (!body) return;
    for (let i = 0; i < body.length; i += CHUNK_TARGET) {
      out.push({ heading, text: body.slice(i, i + CHUNK_TARGET) });
    }
  };
  for (const line of lines) {
    const m = /^#{1,3}\s+(.+)/.exec(line);
    if (m) {
      flush();
      heading = m[1].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/* ── the index ───────────────────────────────────────────────────────── */

class VaultIndex {
  private files = new Map<string, FileEntry>();
  private ready = false;
  private reindexTimer: NodeJS.Timeout | null = null;

  async init(): Promise<void> {
    try {
      const saved = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      for (const [k, v] of Object.entries(saved)) this.files.set(k, v as FileEntry);
    } catch {
      /* first run — no saved index */
    }
    await this.reindex();
    this.ready = true;
    try {
      fs.watch(CONFIG.vaultPath, { recursive: true }, (_ev, name) => {
        if (name && !String(name).endsWith('.md')) return;
        if (this.reindexTimer) clearTimeout(this.reindexTimer);
        this.reindexTimer = setTimeout(() => void this.reindex(), 3000);
      });
    } catch (err) {
      console.log('[vault] watch unavailable:', err);
    }
    console.log(`[vault] memory index ready · ${this.files.size} notes`);
  }

  private listNotes(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) out.push(p);
      }
    };
    try {
      walk(CONFIG.vaultPath);
    } catch {
      /* vault missing — empty index */
    }
    return out;
  }

  private async reindex(): Promise<void> {
    const notes = this.listNotes();
    const seen = new Set<string>();
    let changed = 0;
    for (const abs of notes) {
      const rel = path.relative(CONFIG.vaultPath, abs);
      seen.add(rel);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      const existing = this.files.get(rel);
      if (existing && existing.mtime === stat.mtimeMs) continue;
      try {
        const raw = fs.readFileSync(abs, 'utf8');
        const chunks: Chunk[] = [];
        for (const c of chunkNote(rel, raw)) {
          const vector = await embed(`${rel} › ${c.heading}\n${c.text}`);
          chunks.push({ heading: c.heading, text: c.text, vector });
        }
        this.files.set(rel, { mtime: stat.mtimeMs, chunks });
        changed++;
      } catch (err) {
        console.log(`[vault] index failed for ${rel}:`, err);
      }
    }
    for (const key of [...this.files.keys()]) {
      if (!seen.has(key)) {
        this.files.delete(key);
        changed++;
      }
    }
    if (changed > 0) {
      try {
        fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
        fs.writeFileSync(INDEX_PATH, JSON.stringify(Object.fromEntries(this.files)));
      } catch {
        /* persistence is best-effort */
      }
      console.log(`[vault] indexed ${changed} changed note(s)`);
    }
  }

  /** cosine top-k over all chunks (vectors are normalized → dot product) */
  async search(query: string, k = 5, minScore = 0.3): Promise<VaultHit[]> {
    if (!this.ready) return [];
    let qv: number[];
    try {
      qv = await embed(query);
    } catch {
      return [];
    }
    const hits: VaultHit[] = [];
    for (const [file, entry] of this.files) {
      for (const c of entry.chunks) {
        const score = dot(qv, c.vector);
        if (score >= minScore) hits.push({ file, heading: c.heading, text: c.text, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}

let singleton: VaultIndex | null = null;

export function getVaultIndex(): VaultIndex {
  if (!singleton) singleton = new VaultIndex();
  return singleton;
}
