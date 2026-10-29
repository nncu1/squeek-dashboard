// HTTP server: JSON API over the indexer's in-memory view + static dashboard.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";
import { svgFromDataUri } from "./meta.mjs";

const PUBLIC = path.join(ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2" };
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
};
const int = (v, d, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

export function createServer({ cfg, indexer, meta, api }) {
  const routes = [
    ["GET", /^\/api\/summary$/, summary],
    ["GET", /^\/api\/nfts$/, nfts],
    ["GET", /^\/api\/nft\/(\d+)$/, nft],
    ["GET", /^\/api\/wallets$/, wallets],
    ["GET", /^\/api\/wallet\/(0x[0-9a-fA-F]{40})$/, wallet],
    ["GET", /^\/api\/wallet\/(0x[0-9a-fA-F]{40})\/earnings$/, earnings],
    ["GET", /^\/api\/merges$/, merges],
    ["GET", /^\/api\/vault$/, vault],
    ["GET", /^\/api\/activity$/, activity],
    ["GET", /^\/api\/meta\/(\d+)$/, metaRoute],
    ["GET", /^\/api\/image\/(\d+)$/, image],
    ["GET", /^\/api\/thumb\/(\d+)$/, thumb],
  ];

  function view() { return indexer.view; }
  // art and metadata only for tokens this chain has minted, so nobody can make the server fetch ids that don't exist
  const known = (id) => Number.isSafeInteger(id) && id > 0 && indexer.state.tokens[id] != null;
  const noImage = (res) => { res.writeHead(404, { "content-type": "text/plain" }); res.end("no image"); };

  // per-visitor token bucket: RATE_LIMIT requests per second, bursts up to 4x (a page of 40 cards + the next page)
  const buckets = new Map();
  setInterval(() => { const cut = Date.now() - 60_000; for (const [k, b] of buckets) if (b.at < cut) buckets.delete(k); }, 60_000).unref();
  function allowed(req) {
    if (!cfg.rateLimit) return true;
    const fwd = cfg.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    const ip = fwd || req.socket.remoteAddress || "?";
    const now = Date.now(), cap = cfg.rateLimit * 4;
    const b = buckets.get(ip) ?? { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 1000) * cfg.rateLimit);
    b.at = now;
    buckets.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  async function summary(req, res, q) {
    const s = indexer.state, v = view();
    const now = Math.floor(Date.now() / 1000);
    let m1 = 0, m24 = 0, mergesTotal = 0, mints = 0, deposits = 0, withdrawals = 0;
    const hours = 48;
    const buckets = Array.from({ length: hours }, (_, i) => ({ hour: (Math.floor(now / 3600) - (hours - 1 - i)) * 3600, merges: 0, mints: 0, deposits: 0 }));
    const first = buckets[0].hour;
    const KEY = { merge: "merges", mint: "mints", deposit: "deposits" };
    for (const e of s.events) {
      if (e.k === "mint") mints++;
      else if (e.k === "merge") mergesTotal++;
      else if (e.k === "deposit") deposits++;
      else if (e.k === "withdraw") withdrawals++;
      if (!KEY[e.k]) continue;
      const { ts } = indexer.timeOf(e.b);
      if (ts == null) continue;
      if (e.k === "merge") { if (now - ts <= 3600) m1++; if (now - ts <= 86400) m24++; }
      if (ts >= first) {
        const bk = buckets[Math.floor((ts - first) / 3600)];
        if (bk) bk[KEY[e.k]]++;
      }
    }
    const [status, stats, stream] = await Promise.all([
      api.get("/v1/status", 15_000),
      api.get("/v1/measurement/stats?range=7d", 300_000),
      api.get(`${cfg.mediaBase}/live/current.json`, 30_000),
    ]);
    const top = (arr, n) => arr.slice(0, n);
    json(res, 200, {
      sync: { ...indexer.status, indexedBlock: s.lastBlock, positionsBlock: s.positionsBlock, chainId: cfg.chainId },
      contracts: { core: cfg.core, mining: cfg.mining, nft: cfg.nft, token: cfg.token, vault: cfg.vault }, explorer: cfg.explorer,
      totals: v.totals, core: s.core, economy: s.economy, maxLevel: v.maxLevel, levelDist: v.levelDist, policy: v.policy,
      events: { mints, merges: mergesTotal, merges1h: m1, merges24h: m24, deposits, withdrawals },
      hourly: buckets,
      hamster: status?.measurement ? {
        freshness: status.measurement.freshness, coreStatus: status.measurement.coreStatus, rpmMilli: status.measurement.rpmMilli,
        speedMmPerSecond: status.measurement.speedMmPerSecond, distanceMm: status.measurement.distanceMm, observedAt: status.measurement.observedAt,
        cumulativeWorkUnits: status.measurement.cumulativeWorkUnits, queue: status.settlementQueue?.state ?? null,
      } : null,
      // not in the public docs: the website's own stream status file (state "idle" | "live" | …)
      stream: stream ? { state: stream.state, observedAt: stream.observedAt, errorCode: stream.errorCode, url: cfg.siteUrl } : null,
      records: stats?.records ? {
        lifetime: stats.lifetime, rounds: stats.rounds, summary: stats.activity?.summary ?? null,
        topSpeedMmPerSecond: stats.records.peakObservedSpeedMmPerSecond, mostWorkDay: stats.records.mostWorkUtcDay,
        mostWorkHalfHour: stats.records.mostWorkHalfHour, longestRunMinutes: stats.records.longestActiveWindowMinutes,
        longestDayStreak: stats.records.longestActiveDayStreak, maxDailyDistanceMm: stats.records.maximumDailyDistanceMm,
      } : null,
      topWallets: top([...v.wallets].sort((a, b) => b.stakedPower - a.stakedPower), 5),
    });
  }

  const SORTS = {
    id: (a, b) => a.id - b.id,
    level: (a, b) => a.level - b.level || a.power - b.power || b.id - a.id,
    power: (a, b) => a.power - b.power || a.level - b.level || b.id - a.id,
    newest: (a, b) => a.mintBlock - b.mintBlock || a.id - b.id,
  };
  function nfts(req, res, q) {
    let list = view().items;
    if (q.get("level")) { const lv = Number(q.get("level")); list = list.filter((i) => i.level === lv); }
    if (q.get("state")) { const st = q.get("state"); list = list.filter((i) => i.state === st); }
    if (q.get("custody") === "vault") list = list.filter((i) => i.vault);
    else if (q.get("custody") === "wallet") list = list.filter((i) => !i.vault);
    const owner = (q.get("owner") ?? "").toLowerCase();
    if (owner) list = list.filter((i) => i.owner?.startsWith(owner));
    const term = (q.get("q") ?? "").trim().toLowerCase().replace(/^#/, "");
    if (term) list = /^\d+$/.test(term) ? list.filter((i) => String(i.id).startsWith(term)) : list.filter((i) => i.owner?.includes(term));
    const sort = SORTS[q.get("sort")] ? q.get("sort") : "level";
    const dir = q.get("dir") === "asc" ? 1 : -1;
    const sorted = [...list].sort((a, b) => dir * SORTS[sort](a, b));
    const offset = int(q.get("offset"), 0, 0, 1e6), limit = int(q.get("limit"), 60, 1, 500);
    json(res, 200, { total: sorted.length, offset, items: sorted.slice(offset, offset + limit) });
  }

  // a merge burns its donor in the same tx; the merge row already says so, so the burn row is dropped
  const mergeTx = (evs) => new Set(evs.filter((e) => e.k === "merge").map((e) => e.tx));
  function historyOf(id, limit = 100) {
    const idx = view().tokenEvents.get(id) ?? [];
    const evs = idx.slice(-limit).reverse().map((i) => indexer.state.events[i]);
    const mt = mergeTx(evs);
    return evs.filter((e) => !(e.k === "burn" && mt.has(e.tx))).map((e) => indexer.describe(e));
  }

  async function nft(req, res, q, [, idStr]) {
    const id = Number(idStr);
    const s = indexer.state, v = view();
    const t = s.tokens[id];
    if (!t) return json(res, 404, { error: "unknown token" });
    const it = v.itemById.get(id);
    const w = t.o ? v.walletByAddr.get(t.o) : null;
    const cached = meta.mem.get(id) ?? null;
    json(res, 200, {
      id, burned: t.bb != null, burnBlock: t.bb, burnedBy: t.by, mint: { block: t.mb, ...indexer.timeOf(t.mb) },
      position: it ?? null, owner: t.o, ownerSummary: w ? { count: w.count, inVault: w.inVault, stakedPower: w.stakedPower, share: w.share, rank: w.rank, maxLevel: w.maxLevel } : null,
      meta: cached ? { name: cached.name, attributes: cached.attributes, source: cached.source } : null,
      history: historyOf(id), height: v.height, maxLevel: v.maxLevel,
      cooldownForLevel: v.policy.cooldown?.[(it?.level ?? 1) - 1] ?? null,
    });
  }

  const WSORTS = {
    power: (a, b) => a.stakedPower - b.stakedPower || a.power - b.power,
    total: (a, b) => a.power - b.power || a.count - b.count,
    count: (a, b) => a.count - b.count || a.power - b.power,
    vault: (a, b) => a.inVault - b.inVault || a.stakedPower - b.stakedPower,
    level: (a, b) => a.maxLevel - b.maxLevel || a.power - b.power,
    merges: (a, b) => a.merges - b.merges || a.power - b.power,
    pairs: (a, b) => a.mergeablePairs - b.mergeablePairs || a.power - b.power,
  };
  function wallets(req, res, q) {
    let list = view().wallets;
    const term = (q.get("q") ?? "").trim().toLowerCase();
    if (term) list = list.filter((w) => w.address?.includes(term));
    const sort = WSORTS[q.get("sort")] ? q.get("sort") : "power";
    const sorted = [...list].sort((a, b) => -WSORTS[sort](a, b));
    const offset = int(q.get("offset"), 0, 0, 1e6), limit = int(q.get("limit"), 50, 1, 500);
    json(res, 200, { total: sorted.length, offset, stakedPower: view().totals.stakedPower, items: sorted.slice(offset, offset + limit) });
  }

  function wallet(req, res, q, [, addrRaw]) {
    const addr = addrRaw.toLowerCase();
    const v = view();
    const w = v.walletByAddr.get(addr) ?? null;
    const items = v.items.filter((i) => i.owner === addr).sort((a, b) => b.level - a.level || Number(b.vault) - Number(a.vault) || a.id - b.id);
    const evs = [];
    const s = indexer.state;
    for (let i = s.events.length - 1; i >= 0 && evs.length < 100; i--) {
      const e = s.events[i];
      if (e.k === "burn") continue; // shown through its merge
      if (e.o === addr || e.to === addr || e.from === addr) evs.push(indexer.describe(e));
    }
    json(res, 200, { address: addr, summary: w, items, activity: evs, height: v.height });
  }

  // Rewards, staked SQK and the daily earnings history exist only in the API (it replays the reward schedule per account).
  async function earnings(req, res, q, [, addrRaw]) {
    const r = await api.get(`/v1/accounts/${addrRaw.toLowerCase()}?limit=1`, 60_000);
    if (!r || r.status !== "available") return json(res, 200, { status: "unavailable", reason: r?.reason ?? "api_unreachable" });
    const P = 10n ** 18n;
    const pw = (x) => (x == null ? null : Number(BigInt(x) / P));
    json(res, 200, {
      status: "available", safeThroughBlock: r.chain?.safeThroughBlock,
      nftPower: pw(r.power?.nftPower), sqkPower: pw(r.power?.sqkPower), pendingPower: Number(r.power?.pendingCount ?? 0),
      staked: r.stake?.principalBaseUnits ?? null, claimable: r.claim?.claimableBaseUnits ?? null,
      paid: r.lifetime?.paidBaseUnits ?? null, claimedToStake: r.lifetime?.claimedToStakeBaseUnits ?? null,
      days: r.earnings ?? [],
    });
  }

  function merges(req, res, q) {
    const s = indexer.state, v = view();
    const offset = int(q.get("offset"), 0, 0, 1e6), limit = int(q.get("limit"), 50, 1, 200);
    const out = [];
    let seen = 0;
    for (let i = s.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = s.events[i];
      if (e.k !== "merge") continue;
      if (seen++ < offset) continue;
      const now = e.s != null ? v.itemById.get(e.s) : null;
      out.push({ ...indexer.describe(e), survivorNow: now ? { level: now.level, owner: now.owner, state: now.state } : null });
    }
    const total = s.events.reduce((n, e) => n + (e.k === "merge" ? 1 : 0), 0);
    json(res, 200, { total, offset, items: out });
  }

  // Latest deposits into and withdrawals from the staking vault.
  function vault(req, res, q) {
    const s = indexer.state, v = view();
    const limit = int(q.get("limit"), 100, 1, 300);
    const out = [];
    for (let i = s.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = s.events[i];
      if (e.k !== "deposit" && e.k !== "withdraw") continue;
      const it = v.itemById.get(e.id);
      out.push({ ...indexer.describe(e), level: it?.level ?? null, power: it?.power ?? null });
    }
    json(res, 200, { inVault: v.totals.inVault, stakedPower: v.totals.stakedPower, ready: v.totals.ready, cooldown: v.totals.cooldown, items: out });
  }

  function activity(req, res, q) {
    const kinds = new Set((q.get("kinds") ?? "mint,merge,deposit,withdraw,transfer").split(","));
    const s = indexer.state;
    const limit = int(q.get("limit"), 50, 1, 200);
    const out = [];
    for (let i = s.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = s.events[i];
      if (kinds.has(e.k)) out.push(indexer.describe(e));
    }
    json(res, 200, { items: out });
  }

  async function metaRoute(req, res, q, [, idStr]) {
    if (!known(Number(idStr))) return json(res, 404, { error: "unknown token" });
    const m = await meta.get(Number(idStr));
    if (!m) return json(res, 404, { error: "metadata unavailable" });
    json(res, 200, { name: m.name, description: m.description, attributes: m.attributes, source: m.source });
  }

  async function image(req, res, q, [, idStr]) {
    if (!known(Number(idStr))) return noImage(res);
    const m = await meta.get(Number(idStr));
    const svg = m && svgFromDataUri(m.image);
    if (!svg) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("no image"); }
    // NFT art is untrusted: serve it so that, even opened directly, it cannot run scripts on this origin
    res.writeHead(200, {
      "content-type": "image/svg+xml",
      "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=604800, immutable",
    });
    res.end(svg);
  }

  // small PNG for the card grid; the art never changes for a token id, so the browser may keep it for a week
  async function thumb(req, res, q, [, idStr]) {
    const id = Number(idStr);
    if (!known(id)) return noImage(res);
    if (!meta.canThumb) { res.writeHead(302, { location: `/api/image/${id}` }); return res.end(); }
    const png = await meta.thumb(id);
    if (!png) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("no image"); }
    res.writeHead(200, { "content-type": "image/png", "x-content-type-options": "nosniff", "cache-control": "public, max-age=604800, immutable" });
    res.end(png);
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
      // liveness for Docker / uptime monitors: 200 once the index is built and the last sync worked
      if (url.pathname === "/healthz") {
        const st = indexer.status, ok = !!indexer.view && !st.error;
        return json(res, ok ? 200 : 503, { ok, phase: st.phase, lastBlock: indexer.state.lastBlock, error: st.error ?? null });
      }
      if (!allowed(req)) { res.writeHead(429, { "retry-after": "2", "content-type": "text/plain" }); return res.end("slow down"); }
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (m && (req.method === method || (req.method === "HEAD" && method === "GET"))) {
          if (!indexer.view) return json(res, 503, { error: "starting" });
          return await fn(req, res, url.searchParams, m);
        }
      }
      if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
      serveStatic(req, res, url.pathname);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
}

export { isAddr };
