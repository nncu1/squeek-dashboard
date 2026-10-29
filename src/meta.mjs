// Squeek metadata + image, from the public API (server-side, no CORS issue) with an on-chain tokenURI fallback.
// Rendering is deterministic, so every result is cached on disk forever (delete data/meta to refresh).
import fs from "node:fs";
import path from "node:path";
import { nftAbi } from "./abi.mjs";

// SVG -> PNG for the card grid. The art is a 1568 px canvas of thousands of dots; 40 of those per page is what
// makes a browser stutter, so the grid gets small PNGs and only the detail panel shows the SVG.
// Optional: without the native module the grid falls back to the SVG.
let renderAsync = null;
try { ({ renderAsync } = await import("@resvg/resvg-js")); } catch {}
export const THUMB_PX = 288; // 2x the card art size, sharp on high-DPI screens

export class MetaStore {
  constructor(cfg, client) {
    this.cfg = cfg;
    this.client = client;
    // one folder per collection, so art cached for an earlier deployment is never shown for this one's ids
    const coll = String(cfg.nft).toLowerCase().slice(0, 10);
    this.dir = path.join(cfg.dataDir, "meta", coll);
    fs.mkdirSync(this.dir, { recursive: true });
    this.mem = new Map();
    this.inflight = new Map();
    this.misses = new Map(); // id -> retry-after ms
    this.hi = []; // someone is looking at it: newest first, so the page on screen wins over pages already left
    this.lo = []; // background warm-up
    this.active = 0;
    this.lastStart = 0;
    this.thumbDir = path.join(cfg.dataDir, "thumb", coll);
    fs.mkdirSync(this.thumbDir, { recursive: true });
    this.thumbInflight = new Map();
    this.canThumb = !!renderAsync;
    this.warmed = 0;
  }

  async get(id, priority = "hi") {
    if (this.mem.has(id)) return this.mem.get(id);
    const file = path.join(this.dir, `${id}.json`);
    if (fs.existsSync(file)) {
      const m = JSON.parse(fs.readFileSync(file, "utf8"));
      this.#remember(id, m);
      return m;
    }
    if ((this.misses.get(id) ?? 0) > Date.now()) return null;
    if (this.inflight.has(id)) return this.inflight.get(id);
    const p = this.#schedule(() => this.#fetch(id), priority).then((m) => {
      this.inflight.delete(id);
      if (m) {
        this.#remember(id, m);
        fs.writeFileSync(file, JSON.stringify(m));
      } else this.misses.set(id, Date.now() + 5 * 60e3);
      return m;
    });
    this.inflight.set(id, p);
    return p;
  }

  // keep the 800 most recently used in memory; everything stays on disk
  #remember(id, m) {
    this.mem.delete(id);
    this.mem.set(id, m);
    if (this.mem.size > 800) this.mem.delete(this.mem.keys().next().value);
  }

  // at most 6 in flight and ~12 starts per second (API limit for metadata is 20/s per IP);
  // background work only runs when nothing is waiting for the screen, and never more than 2 at a time
  #schedule(fn, priority) {
    return new Promise((resolve) => {
      (priority === "lo" ? this.lo : this.hi).push({ fn, resolve });
      this.#pump();
    });
  }
  #pump() {
    if (this.timer) return;
    for (;;) {
      const useHi = this.hi.length > 0;
      if (!useHi && !(this.lo.length && this.active < 2)) return;
      if (this.active >= 6) return;
      const wait = this.lastStart + 85 - Date.now();
      if (wait > 0) { this.timer = setTimeout(() => { this.timer = null; this.#pump(); }, wait); return; }
      const { fn, resolve } = useHi ? this.hi.pop() : this.lo.shift();
      this.active++;
      this.lastStart = Date.now();
      fn().catch(() => null).then((r) => { this.active--; resolve(r); this.#pump(); });
    }
  }

  /** PNG thumbnail bytes, rendered once and kept on disk. null if the token has no art (burned) or no renderer. */
  async thumb(id, priority = "hi") {
    if (!renderAsync) return null;
    const file = path.join(this.thumbDir, `${id}.png`);
    try { return await fs.promises.readFile(file); } catch {}
    if (this.thumbInflight.has(id)) return this.thumbInflight.get(id);
    const p = (async () => {
      const m = await this.get(id, priority);
      const svg = m && svgFromDataUri(m.image);
      if (!svg) return null;
      try {
        const out = await renderAsync(svg, { fitTo: { mode: "width", value: THUMB_PX }, font: { loadSystemFonts: false } });
        const png = out.asPng();
        await fs.promises.writeFile(`${file}.tmp`, png);
        await fs.promises.rename(`${file}.tmp`, file);
        return png;
      } catch { return null; }
    })().finally(() => this.thumbInflight.delete(id));
    this.thumbInflight.set(id, p);
    return p;
  }

  /** Fetch metadata and render thumbnails for every live Squeek in the background, in the order ids() gives. */
  async warm(ids) {
    if (this.warming) return;
    this.warming = true;
    try {
      const todo = ids().filter((id) => !fs.existsSync(path.join(renderAsync ? this.thumbDir : this.dir, `${id}.${renderAsync ? "png" : "json"}`)));
      for (let i = 0; i < todo.length; i += 2) {
        await Promise.all(todo.slice(i, i + 2).map((id) => (renderAsync ? this.thumb(id, "lo") : this.get(id, "lo"))));
        this.warmed = i + 2;
        this.warmTotal = todo.length;
      }
    } finally { this.warming = false; }
  }

  async #fetch(id) {
    try {
      // /v1/squeeks/:id carries the metadata (art inline) next to custody and level
      const res = await fetch(`${this.cfg.apiBase}/v1/squeeks/${id}`, {
        headers: { accept: "application/json", "user-agent": "squeek-dash/0.3" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const j = await res.json();
        const m = j.metadata ?? j;
        if (j.status === "available" && (m.status ?? "available") === "available" && m.imageDataUri) {
          return {
            name: m.name, description: m.description, image: m.imageDataUri, source: "api",
            attributes: (m.attributes ?? []).map((a) => ({ trait: a.traitType ?? a.trait_type, value: a.value })),
          };
        }
      }
    } catch {}
    // fallback: render on chain through SqueekNFT.tokenURI
    try {
      const uri = await this.client.readContract({ address: this.cfg.nft, abi: nftAbi, functionName: "tokenURI", args: [BigInt(id)] });
      const prefix = "data:application/json;base64,";
      const body = uri.slice(uri.indexOf(",") + 1);
      const json = JSON.parse(uri.startsWith(prefix) ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body));
      return {
        name: json.name, description: json.description, image: json.image, source: "chain",
        attributes: (json.attributes ?? []).map((a) => ({ trait: a.trait_type ?? a.traitType, value: a.value })),
      };
    } catch {
      return null;
    }
  }
}

/** data:image/svg+xml;base64,… (or utf8) -> Buffer, only for SVG. */
export function svgFromDataUri(uri) {
  if (typeof uri !== "string") return null;
  const m = uri.match(/^data:image\/svg\+xml(;base64)?,(.*)$/s);
  if (!m) return null;
  return m[1] ? Buffer.from(m[2], "base64") : Buffer.from(decodeURIComponent(m[2]), "utf8");
}

/**
 * Short-lived cache in front of the public API and the stream status file. Sends the last ETag back as
 * If-None-Match (status, stats and settlements support it), so an unchanged answer costs a 304, no body.
 * Concurrent callers share one request; a failed request keeps serving the last good answer.
 */
export class ApiCache {
  constructor(cfg, maxEntries = 500) { this.cfg = cfg; this.cache = new Map(); this.inflight = new Map(); this.max = maxEntries; }
  async get(pathOrUrl, ttlMs) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.cfg.apiBase}${pathOrUrl}`;
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data;
    if (this.inflight.has(url)) return this.inflight.get(url);
    const p = (async () => {
      try {
        const headers = { accept: "application/json", "user-agent": "squeek-dash/0.2" };
        if (hit?.etag) headers["if-none-match"] = hit.etag;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
        if (res.status === 304 && hit) { hit.at = Date.now(); return hit.data; }
        const data = res.ok ? await res.json() : null;
        if (data) {
          this.cache.delete(url);
          this.cache.set(url, { at: Date.now(), data, etag: res.headers.get("etag") });
          if (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value);
        }
        return data ?? hit?.data ?? null;
      } catch {
        return hit?.data ?? null;
      } finally {
        this.inflight.delete(url);
      }
    })();
    this.inflight.set(url, p);
    return p;
  }
}
