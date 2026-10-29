// Indexes Squeeks from chain: every log of the Squeek NFT (Transfer for mints, sends, vault deposits and merge
// burns; the collection's own merge record), then reads each live Squeek's level with Multicall3. Economy figures
// (power per level, cooldowns, totals) and the core block height come from the Squeekchain API, chain as fallback.
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, fallback, zeroAddress } from "viem";
import { sepolia } from "viem/chains";
import { coreAbi, nftAbi, NEXT_MERGE_GETTERS, IGNORED_TOPICS, TRANSFER_TOPIC, DEFAULT_POLICY } from "./abi.mjs";
import { log } from "./log.mjs";

const BLOCK_SECONDS = 12;
const STATE_VERSION = 2;
const POWER_UNIT = 10n ** 18n; // the API reports power scaled by 1e18

const lc = (a) => (a ? a.toLowerCase() : a);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "-");
const topicAddr = (t) => lc(`0x${t.slice(26)}`);

function freshState(cfg) {
  return {
    v: STATE_VERSION, chainId: cfg.chainId, nft: lc(cfg.nft), vault: lc(cfg.vault),
    lastBlock: Number(cfg.fromBlock) - 1,
    // id -> { o: holder (the depositor while it sits in the vault) | null, v: 1 in vault, mb: mint block,
    //         bb: burn block | null, by: last holder when burned, ml/nmh: level and next merge height from its last merge }
    tokens: {},
    events: [], // chronological
    times: {}, // block -> unix seconds
    levels: {}, nmh: {}, positionsBlock: 0, mergeGetter: null,
    core: null, economy: null, policy: null,
  };
}

/**
 * The collection's merge log is not published, so it is read by shape: the burned donor's id is one of its words,
 * the survivor's id sits next to it, then the level reached and the next merge height. An address word, if any,
 * is the account that merged. Returns null when the log doesn't look like that.
 */
export function decodeMerge(log, donor, isLive) {
  const words = [...log.topics.slice(1), ...(log.data.slice(2).match(/.{64}/g) ?? []).map((w) => `0x${w}`)].map((w) => BigInt(w));
  const d = BigInt(donor);
  const j = words.indexOf(d);
  if (j < 0) return null;
  const small = (w) => w != null && w > 0n && w < 1_000_000n;
  const addrWord = words.find((w) => w >= 2n ** 100n && w < 2n ** 160n);
  for (const k of [j - 1, j + 1]) {
    const sv = words[k];
    if (!small(sv) || sv === d || !isLive(Number(sv))) continue;
    const after = Math.max(j, k) + 1;
    const lv = words[after];
    const nmh = words[after + 1];
    return {
      s: Number(sv), d: Number(d),
      lv: lv != null && lv >= 2n && lv <= 64n ? Number(lv) : null,
      nmh: nmh != null && nmh < 2n ** 64n ? Number(nmh) : null,
      o: addrWord != null ? `0x${addrWord.toString(16).padStart(40, "0")}` : null,
    };
  }
  return null;
}

// The RPC's own words: viem's short message for code -32600 is generic ("JSON is not a valid request object"),
// the provider's explanation sits in details.
export function rpcReason(err) {
  for (let e = err; e; e = e.cause) {
    const d = typeof e.details === "string" ? e.details.trim() : "";
    if (d && !/^(JSON is not a valid request object|Internal error)\.?$/i.test(d)) return d;
  }
  return err?.shortMessage ?? err?.message ?? "";
}
// "up to a 10 block range", "block range is limited to 2000", "maximum block range: 500", "range limit of 1000 blocks"
export function statedRange(text) {
  const m = String(text).match(/(\d{1,6})\s*-?\s*block range|block range[^\d]{0,40}(\d{1,6})|range (?:limit|of)[^\d]{0,20}(\d{1,6})\s*blocks?/i);
  const n = m && Number(m[1] ?? m[2] ?? m[3]);
  return n > 0 ? BigInt(n) : null;
}

export class Indexer {
  constructor(cfg, api = null) {
    this.cfg = cfg;
    this.api = api; // ApiCache for the Squeekchain API (economy, core); optional
    const chain = { ...sepolia, id: cfg.chainId, contracts: { ...sepolia.contracts, multicall3: { address: cfg.multicall } } };
    // With several RPCs: no per-endpoint retries (a dead one would cost seconds on every call); the fallback
    // retries across endpoints and re-ranks them by latency and success every 30 s, so a healthy one leads.
    const many = cfg.rpcUrls.length > 1;
    const transports = cfg.rpcUrls.map((u) => http(u, { timeout: 45_000, retryCount: many ? 0 : 3, retryDelay: 800 }));
    this.client = createPublicClient({
      chain,
      transport: many ? fallback(transports, { rank: { interval: 30_000, sampleCount: 5 }, retryCount: 2, retryDelay: 500 }) : transports[0],
    });
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    this.file = path.join(cfg.dataDir, "state.json");
    this.state = this.#load();
    this.status = { phase: "starting", error: null, head: 0, lastLogsAt: 0, lastPositionsAt: 0, backfill: null };
    this.anchor = null; // { b, ts } latest known block for time estimates
    this.view = null; // derived, rebuilt after every change
    this.chunk = cfg.logChunk;
    this.#rebuild();
  }

  #load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (s.v === STATE_VERSION && s.chainId === this.cfg.chainId && s.nft === lc(this.cfg.nft) && s.vault === lc(this.cfg.vault)) {
        log.info("state loaded", `block ${s.lastBlock}, ${Object.keys(s.tokens).length} tokens`);
        return s;
      }
      log.warn("state file", "different deployment, indexing the new collection from the start");
    } catch {}
    return freshState(this.cfg);
  }

  #save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  // ------------------------------------------------------------------ logs
  async syncLogs() {
    const s = this.state;
    const head = await this.client.getBlockNumber();
    this.status.head = Number(head);
    const safe = head - this.cfg.confirmations;
    let from = BigInt(s.lastBlock + 1);
    if (from > safe) return 0;
    const total = Number(safe - from + 1n);
    let applied = 0;
    const started = from;
    while (from <= safe) {
      const to = from + this.chunk - 1n < safe ? from + this.chunk - 1n : safe;
      let logs;
      try {
        // every log of the collection: Transfers plus its merge record, whose layout is read by shape
        logs = await this.client.getLogs({ address: this.cfg.nft, fromBlock: from, toBlock: to });
      } catch (err) {
        // RPCs cap eth_getLogs differently (Alchemy's free plan: 10 blocks). Use the cap the error states when it
        // states one, otherwise halve, down to a single block; remember it so the range never grows past it again.
        const why = rpcReason(err);
        const stated = statedRange(why);
        const next = stated && stated < this.chunk ? stated : this.chunk / 2n;
        if (next >= 1n && this.chunk > 1n) {
          this.chunk = next;
          // a limit the RPC names is fixed; a guessed one (timeout, "too many results") is relaxed again later
          this.chunkCap = { blocks: next, firm: !!stated, ok: 0 };
          log.warn("getLogs range too large", `retry with ${this.chunk} blocks${why ? ` (${why.slice(0, 70)})` : ""}`);
          continue;
        }
        err.shortMessage = why || err.shortMessage;
        throw err;
      }
      logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
      applied += this.#applyLogs(logs);
      s.lastBlock = Number(to);
      from = to + 1n;
      const cap = this.chunkCap;
      if (cap && !cap.firm && ++cap.ok >= 50) { cap.blocks *= 2n; cap.ok = 0; if (cap.blocks >= this.cfg.logChunk) this.chunkCap = null; }
      const max = this.chunkCap && this.chunkCap.blocks < this.cfg.logChunk ? this.chunkCap.blocks : this.cfg.logChunk;
      if (this.chunk < max) this.chunk = this.chunk * 2n > max ? max : this.chunk * 2n;
      if (total > 5000) {
        const done = Number(to - started + 1n);
        const pct = Math.min(100, Math.round((done / total) * 100));
        // small RPC ranges mean many tiny steps: report each new percent, save at most every 5 seconds
        if (pct !== this.status.backfill) log.info(`backfill ${s.lastBlock}`, `${pct}% · ${Object.keys(s.tokens).length} tokens`);
        this.status.backfill = pct;
        if (Date.now() - (this.lastSave ?? 0) > 5000) { this.#save(); this.lastSave = Date.now(); }
      }
    }
    this.status.backfill = null;
    this.status.lastLogsAt = Date.now();
    if (applied) this.#save();
    return applied;
  }

  // Logs arrive in chain order; a transaction's burn and the collection's merge record are matched within it.
  #applyLogs(logs) {
    let applied = 0;
    for (let i = 0; i < logs.length;) {
      const tx = logs[i].transactionHash;
      const group = [];
      while (i < logs.length && logs[i].transactionHash === tx) group.push(logs[i++]);
      const burns = [], other = [];
      for (const l of group) {
        const t0 = l.topics[0];
        if (t0 === TRANSFER_TOPIC && l.topics.length === 4) { const b = this.#transfer(l); if (b) burns.push(b); applied++; }
        else if (t0 && !IGNORED_TOPICS.has(t0)) other.push(l);
      }
      for (const b of burns) applied += this.#merge(b, other);
    }
    return applied;
  }

  #transfer(l) {
    const s = this.state;
    const base = { b: Number(l.blockNumber), tx: l.transactionHash, li: l.logIndex };
    const id = Number(BigInt(l.topics[3]));
    const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]);
    const vault = s.vault;
    if (from === zeroAddress) {
      s.tokens[id] = { o: to === vault ? null : to, v: to === vault ? 1 : 0, mb: base.b, bb: null, by: null };
      s.events.push({ k: "mint", ...base, id, to });
      return null;
    }
    const t = s.tokens[id] ?? (s.tokens[id] = { o: null, v: 0, mb: 0, bb: null, by: null });
    if (to === zeroAddress) {
      // a merge burns its donor; from the vault when the donor was staked, so the holder is the depositor
      const holder = from === vault ? t.o : from;
      t.o = null; t.v = 0; t.bb = base.b; t.by = holder;
      s.events.push({ k: "burn", ...base, id, from: holder });
      return { id, holder, base };
    }
    if (to === vault) { t.o = from; t.v = 1; s.events.push({ k: "deposit", ...base, id, o: from }); return null; }
    if (from === vault) {
      const was = t.o;
      t.o = to; t.v = 0;
      s.events.push({ k: "withdraw", ...base, id, o: to, from: was && was !== to ? was : undefined });
      return null;
    }
    t.o = to; t.v = 0;
    s.events.push({ k: "transfer", ...base, id, from, to });
    return null;
  }

  #merge(burn, candidates) {
    const s = this.state;
    const live = (id) => s.tokens[id] != null && s.tokens[id].bb == null;
    let m = null;
    for (const l of candidates) { m = decodeMerge(l, burn.id, live); if (m) break; }
    const sv = m ? s.tokens[m.s] : null;
    if (sv) {
      if (m.lv != null) sv.ml = m.lv;
      if (m.nmh != null) sv.nmh = m.nmh;
    }
    s.events.push({ k: "merge", ...burn.base, s: m?.s ?? null, d: burn.id, lv: m?.lv ?? null, nmh: m?.nmh ?? null, o: lc(m?.o) ?? burn.holder ?? (m ? sv?.o : null) ?? null });
    return 1;
  }

  // ------------------------------------------------------------- positions
  // Levels (and, when the collection exposes it, each Squeek's next merge height) for every live Squeek.
  async refreshPositions() {
    const s = this.state;
    const blockNumber = BigInt(s.lastBlock);
    const ids = Object.keys(s.tokens).map(Number).filter((id) => s.tokens[id].bb == null).sort((a, b) => a - b);
    await this.#refreshEconomy(blockNumber);
    if (s.mergeGetter === null && ids.length) s.mergeGetter = await this.#probeMergeGetter(ids, blockNumber);
    const getter = s.mergeGetter ? NEXT_MERGE_GETTERS.find((g) => g.name === s.mergeGetter) : null;
    const levels = {}, nmh = {};
    let failed = 0;
    const per = getter ? 2 : 1;
    const B = Math.max(1, Math.floor(this.cfg.multicallBatch / per));
    const batches = [];
    for (let i = 0; i < ids.length; i += B) batches.push(ids.slice(i, i + B));
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const contracts = batch.flatMap((id) => [
          { address: this.cfg.nft, abi: nftAbi, functionName: "level", args: [BigInt(id)] },
          ...(getter ? [{ address: this.cfg.nft, abi: [getter], functionName: getter.name, args: [BigInt(id)] }] : []),
        ]);
        const res = await this.client.multicall({ contracts, allowFailure: true, blockNumber, batchSize: 0 });
        batch.forEach((id, i) => {
          const lv = res[i * per], nm = getter ? res[i * per + 1] : null;
          if (lv.status === "success") levels[id] = Number(lv.result); else failed++;
          if (nm?.status === "success") nmh[id] = Number(nm.result);
        });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    s.levels = levels;
    s.nmh = nmh;
    s.positionsBlock = s.lastBlock;
    this.#save();
    this.status.lastPositionsAt = Date.now();
    return { count: ids.length, failed };
  }

  async #probeMergeGetter(ids, blockNumber) {
    const sample = ids.slice(0, 3).map(BigInt);
    for (const g of NEXT_MERGE_GETTERS) {
      try {
        const res = await this.client.multicall({ contracts: sample.map((id) => ({ address: this.cfg.nft, abi: [g], functionName: g.name, args: [id] })), allowFailure: true, blockNumber, batchSize: 0 });
        if (res.every((r) => r.status === "success")) { log.info("merge cooldowns", `read with ${g.name}() on the collection`); return g.name; }
      } catch {}
    }
    log.info("merge cooldowns", "taken from the merge logs");
    return false;
  }

  // Core height, power per level, cooldowns and supply figures: the API first, chain (core only) as fallback.
  async #refreshEconomy(blockNumber) {
    const s = this.state;
    const [eco, core] = this.api ? await Promise.all([this.api.get("/v1/economy/state", 60_000), this.api.get("/v1/core", 30_000)]) : [null, null];
    if (eco?.status === "available" && eco.nft) {
      const n = eco.nft;
      s.policy = {
        maxLevel: Number(n.maximumLevel ?? DEFAULT_POLICY.maxLevel),
        basePower: (n.basePower ?? DEFAULT_POLICY.basePower).map(Number),
        cooldown: (n.cooldownBlocks ?? DEFAULT_POLICY.cooldown).map(Number),
      };
      s.economy = {
        issued: Number(n.issued ?? 0), burned: Number(n.burned ?? 0), live: Number(n.live ?? 0),
        round: Number(eco.lifecycle?.currentRound ?? 0), stage: eco.lifecycle?.stage ?? null, paused: !!eco.lifecycle?.paused,
        totalNftPower: eco.mining?.totalNftPower ? Number(BigInt(eco.mining.totalNftPower) / POWER_UNIT) : null,
        totalSqkPower: eco.mining?.totalSqkPower ? Number(BigInt(eco.mining.totalSqkPower) / POWER_UNIT) : null,
        staked: eco.staking?.totalStakedBaseUnits ?? null,
        supply: eco.supply ? { cap: eco.supply.capBaseUnits, live: eco.supply.liveSupplyBaseUnits, minted: eco.supply.totalMintedBaseUnits, paid: eco.supply.paidBaseUnits } : null,
        processedThroughRound: Number(eco.mining?.processedThroughRound ?? 0),
      };
    }
    if (core?.core) {
      const c = core.core;
      s.core = {
        settledThroughRound: Number(c.settledThroughRound), cumulativeWork: Number(c.cumulativeWork), blockHeight: Number(c.blockHeight),
        blockProgress: Number(c.blockProgress), workPerThousandBlocks: Number(c.workPerThousandBlocks), paused: !!c.paused,
      };
      return;
    }
    try {
      const c = await this.client.readContract({ address: this.cfg.core, abi: coreAbi, functionName: "state", blockNumber });
      s.core = {
        settledThroughRound: Number(c.settledThroughRound), cumulativeWork: Number(c.cumulativeWork), blockHeight: Number(c.blockHeight),
        blockProgress: Number(c.blockProgress), workPerThousandBlocks: Number(c.workPerThousandBlocks), paused: c.paused,
      };
    } catch (err) {
      if (!s.core) log.warn("core state", (err.shortMessage ?? err.message).slice(0, 80));
    }
  }

  // ----------------------------------------------------------------- times
  async fillTimes(max = 120) {
    const s = this.state;
    const head = await this.client.getBlock({ blockNumber: BigInt(s.lastBlock) });
    this.anchor = { b: Number(head.number), ts: Number(head.timestamp) };
    s.times[this.anchor.b] = this.anchor.ts;
    const need = [];
    const seen = new Set();
    for (let i = s.events.length - 1; i >= 0 && need.length < max; i--) {
      const b = s.events[i].b;
      if (s.times[b] === undefined && !seen.has(b)) { seen.add(b); need.push(b); }
    }
    let next = 0;
    const worker = async () => {
      while (next < need.length) {
        const b = need[next++];
        try { s.times[b] = Number((await this.client.getBlock({ blockNumber: BigInt(b) })).timestamp); } catch {}
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return need.length;
  }

  /** Unix seconds for a block; exact when fetched, otherwise estimated from the nearest anchor (≈12 s/block). */
  timeOf(b) {
    const t = this.state.times[b];
    if (t !== undefined) return { ts: t, exact: true };
    if (!this.anchor) return { ts: null, exact: false };
    return { ts: this.anchor.ts - (this.anchor.b - b) * BLOCK_SECONDS, exact: false };
  }

  // ------------------------------------------------------------------ loop
  async start() {
    const loop = async () => {
      try {
        this.status.phase = this.status.lastPositionsAt ? "live" : "syncing";
        const applied = await this.syncLogs();
        const stale = Date.now() - this.status.lastPositionsAt > this.cfg.positionsSeconds * 1000;
        if (applied || stale) {
          const r = await this.refreshPositions();
          this.#rebuild();
          log.ok("levels snapshot", `${r.count} live${r.failed ? `, ${r.failed} failed` : ""} @ ${this.state.positionsBlock}`);
        }
        const filled = await this.fillTimes();
        if (applied || filled) this.#save();
        this.#rebuild();
        if (applied) log.info("new events", `+${applied} · block ${this.state.lastBlock}`);
        this.status.phase = "live";
        this.status.error = null;
      } catch (err) {
        this.status.error = err.shortMessage ?? err.message;
        log.err("sync failed", this.status.error.slice(0, 80));
      }
      this.timer = setTimeout(loop, this.cfg.pollSeconds * 1000);
    };
    await loop();
  }
  stop() { clearTimeout(this.timer); }

  // --------------------------------------------------------------- derived
  #rebuild() {
    const s = this.state;
    const height = s.core?.blockHeight ?? 0;
    const pol = s.policy ?? DEFAULT_POLICY;
    const maxLevel = pol.maxLevel;
    const powerOf = (lv) => pol.basePower[lv - 1] ?? 0;
    const walletMerges = new Map(), tokenEvents = new Map();
    const pushTok = (id, i) => { if (id == null) return; let a = tokenEvents.get(id); if (!a) tokenEvents.set(id, (a = [])); a.push(i); };
    s.events.forEach((e, i) => {
      if (e.k === "merge") { if (e.o) walletMerges.set(e.o, (walletMerges.get(e.o) ?? 0) + 1); pushTok(e.s, i); pushTok(e.d, i); }
      else pushTok(e.id, i);
    });

    const items = [];
    const wallets = new Map();
    const levelDist = new Map();
    let totalPower = 0, stakedPower = 0, inVault = 0, burned = 0, ready = 0, cooldown = 0;
    for (const [idStr, t] of Object.entries(s.tokens)) {
      const id = Number(idStr);
      if (t.bb != null) { burned++; continue; }
      const lv = s.levels[id] ?? t.ml ?? 1;
      const power = powerOf(lv);
      // next merge height: the collection's view if it has one, else the last merge log when it reached this level;
      // a Squeek still at L1 has never merged and level 1 has no cooldown
      const nmh = s.nmh[id] ?? (t.ml === lv && t.nmh != null ? t.nmh : lv === 1 ? 0 : null);
      let st = "unknown";
      if (lv >= maxLevel) st = "max";
      else if (nmh != null) st = nmh > height ? "cooldown" : "ready";
      if (st === "ready") ready++; else if (st === "cooldown") cooldown++;
      const vault = t.v === 1;
      const item = {
        id, owner: t.o, vault, level: lv, power, earning: vault ? power : 0, state: st,
        nextMergeHeight: nmh, blocksUntilMerge: nmh != null ? Math.max(0, nmh - height) : null, mintBlock: t.mb,
      };
      items.push(item);
      totalPower += power;
      if (vault) { stakedPower += power; inVault++; }
      const d = levelDist.get(lv) ?? { level: lv, count: 0, power: 0, staked: 0 };
      d.count++; d.power += power; if (vault) d.staked++;
      levelDist.set(lv, d);
      let w = wallets.get(t.o);
      if (!w) {
        w = { address: t.o, count: 0, inVault: 0, power: 0, stakedPower: 0, maxLevel: 0, levels: {}, ready: {}, merges: walletMerges.get(t.o) ?? 0 };
        wallets.set(t.o, w);
      }
      w.count++; w.power += power;
      if (vault) { w.inVault++; w.stakedPower += power; }
      if (lv > w.maxLevel) w.maxLevel = lv;
      w.levels[lv] = (w.levels[lv] ?? 0) + 1;
      if (st === "ready") w.ready[lv] = (w.ready[lv] ?? 0) + 1;
    }
    const stakedTotal = stakedPower || 1;
    const walletList = [...wallets.values()].map((w) => {
      let pairs = 0;
      for (const [lv, n] of Object.entries(w.ready)) if (Number(lv) < maxLevel) pairs += Math.floor(n / 2);
      return { ...w, mergeablePairs: pairs, share: w.stakedPower / stakedTotal };
    });
    const byPower = [...items].sort((a, b) => b.power - a.power || b.level - a.level || a.id - b.id);
    byPower.forEach((it, i) => (it.powerRank = i + 1));
    const walletByPower = [...walletList].sort((a, b) => b.stakedPower - a.stakedPower || b.power - a.power || b.count - a.count);
    walletByPower.forEach((w, i) => (w.rank = i + 1));

    this.view = {
      items, itemById: new Map(items.map((it) => [it.id, it])), wallets: walletList,
      walletByAddr: new Map(walletList.map((w) => [w.address, w])), tokenEvents,
      levelDist: [...levelDist.values()].sort((a, b) => a.level - b.level),
      totals: { live: items.length, burned, minted: Object.keys(s.tokens).length, holders: walletList.length, power: totalPower, stakedPower, inVault, ready, cooldown },
      maxLevel, height, policy: pol,
    };
  }

  describe(e) {
    const t = this.timeOf(e.b);
    return { ...e, ts: t.ts, tsExact: t.exact };
  }
}

export { short };
