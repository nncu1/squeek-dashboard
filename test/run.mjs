// End-to-end test: local Hardhat node + mocks with the real ABIs → indexer + server → API checks.
//   node test/run.mjs          run checks and exit
//   node test/run.mjs --keep   leave node + dashboard running (http://127.0.0.1:8790) for a look
import { spawn } from "node:child_process";
import fs from "node:fs";
import nodeHttp from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { createPublicClient, http } from "viem";
import { hardhat } from "viem/chains";
import { seed } from "./seed.mjs";
import { startMockApi } from "./mock-api.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RPC_PORT = 8551, WEB_PORT = 8790, API_PORT = 8552;
const RPC = `http://127.0.0.1:${RPC_PORT}`, WEB = `http://127.0.0.1:${WEB_PORT}`;
const keep = process.argv.includes("--keep");
const procs = [];
const cleanup = () => procs.forEach((p) => p.kill());
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(0));

const wait = async (fn, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 300));
  }
};
const get = async (p) => { const r = await fetch(WEB + p); return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text(), headers: r.headers }; };

for (const url of [RPC, WEB]) {
  if (await fetch(url, { method: "POST" }).then(() => true, () => false)) { console.error(`${url} is already in use, stop the old test first`); process.exit(1); }
}
const node = spawn(process.execPath, [path.join(ROOT, "node_modules/hardhat/internal/cli/cli.js"), "node", "--port", String(RPC_PORT)], { cwd: ROOT, stdio: "ignore" });
procs.push(node);
const pub = createPublicClient({ chain: hardhat, transport: http(RPC) });
await wait(() => pub.getBlockNumber().then(() => true));

console.log("seeding…");
const t0 = Date.now();
const d = await seed(RPC);
console.log(`seeded: ${d.minted} minted, ${d.live} live, ${d.inVault} in the vault (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const mock = await startMockApi(API_PORT);

// An RPC in front of the node that behaves like Alchemy's free plan: eth_getLogs over more than 10 blocks is refused
// with code -32600, which viem reports as "JSON is not a valid request object."
const LIMITED_PORT = 8553, LIMITED = `http://127.0.0.1:${LIMITED_PORT}`;
const limitedHits = { refused: 0 };
const limited = nodeHttp.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const reqs = JSON.parse(body), list = Array.isArray(reqs) ? reqs : [reqs];
  const tooWide = list.find((r) => r.method === "eth_getLogs" && BigInt(r.params[0].toBlock) - BigInt(r.params[0].fromBlock) + 1n > 10n);
  if (tooWide) {
    limitedHits.refused++;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: tooWide.id, error: { code: -32600, message: "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x1, 0xa]" } }));
  }
  const up = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
  res.writeHead(up.status, { "content-type": "application/json" });
  res.end(await up.text());
}).listen(LIMITED_PORT, "127.0.0.1");
process.on("exit", () => limited.close());
const dataDir = path.join(ROOT, "test/.data");
fs.rmSync(dataDir, { recursive: true, force: true });
const env = {
  ...process.env, RPC_URL: `http://127.0.0.1:9,${LIMITED}`, CHAIN_ID: "31337", CONFIRMATIONS: "0", INDEX_FROM_BLOCK: "0", LOG_CHUNK: "40",
  API_BASE: `http://127.0.0.1:${API_PORT}`, MEDIA_BASE: `http://127.0.0.1:${API_PORT}`, PORT: String(WEB_PORT), DATA_DIR: dataDir, POLL_SECONDS: "2", POSITIONS_SECONDS: "5",
  CORE_ADDRESS: d.core, NFT_ADDRESS: d.nft, VAULT_ADDRESS: d.vault, MULTICALL_ADDRESS: d.multicall, MULTICALL_BATCH: "60",
};
const dash = spawn(process.execPath, [path.join(ROOT, "index.mjs")], { cwd: ROOT, env, stdio: keep ? "inherit" : "pipe" });
procs.push(dash);
let out = "";
dash.stdout?.on("data", (b) => (out += b));
dash.stderr?.on("data", (b) => (out += b));

const sum = await wait(async () => { const r = await get("/api/summary"); return r.status === 200 && r.body.sync.phase === "live" && r.body.totals.holders > 0 && r.body; }).catch((e) => { console.log(out.slice(-3000)); throw e; });

// ---------------------------------------------------------------- checks
const checks = [];
const check = async (name, fn) => { try { await fn(); checks.push(["✔", name]); } catch (e) { checks.push(["✖", `${name}: ${e.message}`]); } };

const BASE = [1000, 2200, 4840, 10648, 23426, 51536, 113380, 249436, 548759, 1207269];
const lc = (a) => a.toLowerCase();
const allItems = (await get("/api/nfts?limit=500&sort=id&dir=asc")).body;

await check("totals match chain", () => {
  assert.equal(sum.totals.minted, d.minted);
  assert.equal(sum.totals.live, d.live);
  assert.equal(sum.totals.burned, d.minted - d.live);
  assert.equal(sum.events.merges, d.minted - d.live);
  assert.equal(sum.totals.holders, 19);
  assert.equal(sum.totals.inVault, d.inVault);
});
await check("levels read from the collection match the merges played", () => {
  assert.equal(allItems.total, d.live);
  for (const it of allItems.items) assert.equal(it.level, d.level.get(it.id), `#${it.id}`);
  assert.ok(sum.levelDist.some((l) => l.level >= 5), "ladder reached level 5+");
  assert.equal(sum.levelDist.reduce((n, l) => n + l.count, 0), d.live);
});
await check("power: base power per level, staked power only from the vault", () => {
  let staked = 0, total = 0;
  for (const it of allItems.items) {
    assert.equal(it.power, BASE[it.level - 1]);
    total += it.power; if (it.vault) staked += it.power;
  }
  assert.equal(sum.totals.power, total);
  assert.equal(sum.totals.stakedPower, staked);
  assert.ok(staked > 0 && staked < total);
});
await check("every merge decoded from the collection's log (Approval on burn ignored)", async () => {
  const m = (await get("/api/merges?limit=200")).body;
  assert.equal(m.total, d.minted - d.live);
  for (const e of m.items) {
    assert.ok(e.s != null && e.s !== e.d, `merge of #${e.d} has a survivor`);
    assert.ok(e.lv >= 2 && e.nmh >= 4000, `level ${e.lv}, next merge ${e.nmh}`);
    assert.ok(e.o && e.o.startsWith("0x"), "merging account");
  }
  // merges done inside the vault are credited to the depositor
  assert.ok(m.items.some((e) => e.o === lc(d.accounts[1])));
});
await check("merge state from next merge height: L1-L3 ready, L4+ in cooldown", () => {
  for (const it of allItems.items) {
    const want = it.level <= 3 ? "ready" : "cooldown";
    assert.equal(it.state, want, `#${it.id} L${it.level}`);
  }
  assert.equal(sum.core.blockHeight, 14000, "core height read from chain when the API has no /v1/core");
});
await check("NFT list: filter, sort, paging, custody", async () => {
  const lv = (await get("/api/nfts?level=2&limit=500")).body;
  assert.ok(lv.items.length > 0 && lv.items.every((x) => x.level === 2));
  const top = (await get("/api/nfts?sort=level&limit=3")).body.items;
  assert.ok(top[0].level >= top[1].level && top[1].level >= top[2].level);
  const v = (await get("/api/nfts?custody=vault&limit=500")).body;
  assert.equal(v.total, d.inVault);
  assert.ok(v.items.every((x) => x.vault && x.earning === x.power));
  const w = (await get("/api/nfts?custody=wallet&limit=500")).body;
  assert.equal(w.total + v.total, d.live);
  const own = (await get(`/api/nfts?owner=${lc(d.accounts[18])}&limit=500`)).body;
  assert.ok(own.items.length >= 4 && own.items.every((x) => x.owner === lc(d.accounts[18])));
});
await check("NFT detail: depositor as holder, history with deposit and merge", async () => {
  const staked = allItems.items.find((x) => x.vault && x.level >= 3);
  const det = (await get(`/api/nft/${staked.id}`)).body;
  assert.equal(det.owner, lc(d.accounts[1]));
  assert.ok(det.history.some((h) => h.k === "merge") && det.history.some((h) => h.k === "deposit") && det.history.some((h) => h.k === "mint"));
  const donor = (await get(`/api/nft/${(await get("/api/merges?limit=1")).body.items[0].d}`)).body;
  assert.equal(donor.burned, true);
  const moved = (await get(`/api/nfts?owner=${lc(d.accounts[18])}&sort=id&dir=asc&limit=500`)).body.items.find((x) => x.id < 400);
  assert.ok((await get(`/api/nft/${moved.id}`)).body.history.some((e) => e.k === "transfer"), "transfer recorded");
});
await check("wallet leaderboard by staked power is sorted and shares sum to 1", async () => {
  const w = (await get("/api/wallets?limit=500")).body;
  assert.equal(w.total, 19);
  assert.ok(w.items.every((x, i, a) => i === 0 || a[i - 1].stakedPower >= x.stakedPower));
  assert.equal(w.items[0].address, lc(d.accounts[1]));
  const share = w.items.reduce((n, x) => n + x.share, 0);
  assert.ok(Math.abs(share - 1) < 1e-9, `shares ${share}`);
  const byVault = (await get("/api/wallets?sort=vault&limit=3")).body.items;
  assert.ok(byVault[0].inVault >= byVault[1].inVault);
});
await check("wallet page: items, deposits, merges, withdrawals", async () => {
  const a = lc(d.accounts[3]);
  const w = (await get(`/api/wallet/${a}`)).body;
  assert.ok(w.items.length > 0 && w.items.every((x) => x.owner === a));
  assert.ok(w.activity.some((e) => e.k === "deposit") && w.activity.some((e) => e.k === "merge"));
  assert.ok(w.items.some((x) => x.vault) && w.items.some((x) => !x.vault), "both custody kinds");
  const w7 = (await get(`/api/wallet/${lc(d.accounts[7])}`)).body;
  assert.equal(w7.activity.filter((e) => e.k === "withdraw").length, 3);
  assert.equal(w7.summary.inVault, 7);
});
await check("vault feed", async () => {
  const v = (await get("/api/vault?limit=300")).body;
  assert.equal(v.inVault, d.inVault);
  assert.ok(v.items.some((e) => e.k === "withdraw") && v.items.some((e) => e.k === "deposit"));
});
await check("merge log decoder handles other layouts", async () => {
  const { decodeMerge } = await import("../src/indexer.mjs");
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const acct = "0x" + "ab".repeat(20);
  const live = (id) => id === 281;
  // account indexed, everything else in data: survivor, donor, level, next merge height
  const l1 = { topics: ["0x" + "11".repeat(32), "0x" + "0".repeat(24) + acct.slice(2)], data: "0x" + w(281) + w(298) + w(2) + w(4752) };
  assert.deepEqual(decodeMerge(l1, 298, live), { s: 281, d: 298, lv: 2, nmh: 4752, o: acct });
  // donor first, survivor second
  const l2 = { topics: ["0x" + "22".repeat(32)], data: "0x" + w(298) + w(281) + w(3) + w(9000) };
  assert.deepEqual(decodeMerge(l2, 298, live), { s: 281, d: 298, lv: 3, nmh: 9000, o: null });
  // a log without the donor is not the merge record
  assert.equal(decodeMerge({ topics: ["0x" + "33".repeat(32)], data: "0x" + w(281) }, 298, live), null);
});
await check("first RPC dead, indexer fell back to the second", () => assert.match(out, /rpc fallback 1/));
await check("RPC with a 10-block getLogs limit: sync steps down to it and completes", () => {
  assert.ok(limitedHits.refused > 0, "the limit was hit");
  assert.match(out, /retry with 10 blocks/);
  assert.doesNotMatch(out, /sync failed/);
});
await check("Alchemy's real reason is read from the error, and its range limit used", async () => {
  const { rpcReason, statedRange } = await import("../src/indexer.mjs");
  const { RpcRequestError, InvalidRequestRpcError } = await import("viem");
  const msg = "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0xb6200c, 0xb62015]";
  const err = new InvalidRequestRpcError(new RpcRequestError({ body: {}, error: { code: -32600, message: msg }, url: "https://eth-sepolia.g.alchemy.com/v2/x" }));
  assert.equal(err.shortMessage, "JSON is not a valid request object.");
  assert.equal(rpcReason(err), msg);
  assert.equal(statedRange(rpcReason(err)), 10n);
  assert.equal(statedRange("query returned more than 10000 results"), null);
});
await check("stream status, hamster, records and economy from the API", async () => {
  const s2 = (await get("/api/summary")).body;
  assert.equal(s2.stream.state, "idle");
  assert.equal(s2.hamster.coreStatus, "ACTIVE");
  assert.equal(s2.records.topSpeedMmPerSecond.value, "1526");
  assert.equal(s2.economy.issued, 9999);
  assert.equal(s2.economy.totalNftPower, 4705600);
  assert.equal(s2.policy.basePower[1], 2200);
});
await check("ETag revalidation returns 304 instead of a body", async () => {
  await new Promise((r) => setTimeout(r, 16_000)); // let the 15 s status cache expire
  await get("/api/summary");
  assert.ok(mock.hits.status304 >= 1, `304s: ${mock.hits.status304} of ${mock.hits.status}`);
});
await check("wallet rewards proxied from the API", async () => {
  const e = (await get(`/api/wallet/${lc(d.accounts[1])}/earnings`)).body;
  assert.equal(e.status, "available");
  assert.equal(e.days.length, 7);
  assert.equal(e.nftPower, 48400);
  assert.equal(e.claimable, String(12n * 10n ** 18n));
});
await check("metadata + image via on-chain tokenURI fallback", async () => {
  const m = await get("/api/meta/1");
  assert.equal(m.status, 200);
  assert.equal(m.body.source, "chain");
  assert.equal(m.body.name, "Squeek #1");
  const img = await get("/api/image/1");
  assert.equal(img.headers.get("content-type"), "image/svg+xml");
  assert.match(img.headers.get("content-security-policy"), /sandbox/);
  assert.match(img.body, /<svg/);
  assert.ok(fs.existsSync(path.join(dataDir, "meta", lc(d.nft).slice(0, 10), "1.json")), "cached to disk, per collection");
});
await check("grid thumbnail is a cached PNG", async () => {
  const r = await fetch(`${WEB}/api/thumb/1`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.match(r.headers.get("cache-control"), /immutable/);
  const b = Buffer.from(await r.arrayBuffer());
  assert.equal(b.subarray(1, 4).toString(), "PNG");
  assert.equal(b.readUInt32BE(16), 288, "288 px wide");
  assert.ok(fs.existsSync(path.join(dataDir, "thumb", lc(d.nft).slice(0, 10), "1.png")), "cached to disk, per collection");
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 40 }, (_, i) => fetch(`${WEB}/api/thumb/${1 + i * 2}`).then((x) => x.arrayBuffer())));
  console.log(`  40 thumbnails in ${Date.now() - t0} ms`);
});
await check("burned token has no image", async () => {
  const donor = (await get("/api/merges?limit=1")).body.items[0].d;
  assert.equal((await get(`/api/image/${donor}`)).status, 404);
  assert.equal((await get(`/api/thumb/${donor}`)).status, 404);
});
await check("unknown routes 404, traversal blocked", async () => {
  assert.equal((await get("/api/nope")).status, 404);
  assert.equal((await get("/../package.json")).status, 404);
});
await check("dashboard page and ecosystem list served", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.match(String(r.body), /<html/i);
  const e = await get("/ecosystem.json");
  assert.match(e.headers.get("content-type"), /json/);
  assert.ok(e.body.projects.length >= 3);
  for (const p of e.body.projects) if (p.logo) assert.equal((await fetch(`${WEB}/${p.logo}`)).status, 200, p.logo);
});
await check("health check and unknown token ids", async () => {
  const h = await get("/healthz");
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.phase, "live");
  assert.equal((await get("/api/thumb/999999")).status, 404, "never-minted id");
  assert.equal((await get("/api/meta/0")).status, 404);
});
await check("rate limit answers 429 to a flood", async () => {
  const codes = await Promise.all(Array.from({ length: 200 }, () => fetch(`${WEB}/api/vault?limit=1`).then((r) => r.status)));
  assert.ok(codes.includes(429), "some requests limited");
  assert.ok(codes.includes(200), "the first burst still served");
  assert.equal((await get("/healthz")).status, 200, "health check is never limited");
});
await check("restart resumes from saved state", async () => {
  const s = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
  assert.ok(s.lastBlock > 0 && Object.keys(s.tokens).length === d.minted);
});

for (const [mark, name] of checks) console.log(`${mark} ${name}`);
const failed = checks.filter(([m]) => m === "✖").length;
if (failed) { console.log(out.slice(-3000)); }
console.log(failed ? `\n${failed} check(s) failed` : `\n✔ all ${checks.length} checks passed`);
if (keep) { console.log(`\ndashboard: ${WEB} (Ctrl+C to stop)`); await new Promise(() => {}); }
process.exit(failed ? 1 : 0);
