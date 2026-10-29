// squeek-dash — Squeekchain explorer. Run: npm start  →  http://127.0.0.1:8787
import { config } from "./src/config.mjs";
import { Indexer } from "./src/indexer.mjs";
import { MetaStore, ApiCache } from "./src/meta.mjs";
import { createServer } from "./src/server.mjs";
import { log } from "./src/log.mjs";

log.title("SQUEEK-DASH · squeekchain explorer");
config.rpcUrls.forEach((u, i) => log.info(i ? `rpc fallback ${i}` : "rpc", u.replace(/\/[^/]{20,}$/, "/…")));
log.info("chain id", String(config.chainId));
log.info("squeek nft", config.nft);
log.info("staking vault", config.vault);
log.info("api", config.apiBase);

const api = new ApiCache(config);
const indexer = new Indexer(config, api);
const id = await indexer.client.getChainId().catch((e) => { log.err("rpc unreachable", e.shortMessage ?? e.message); process.exit(1); });
if (id !== config.chainId) { log.err("wrong chain", `RPC is ${id}, expected ${config.chainId}`); process.exit(1); }

const meta = new MetaStore(config, indexer.client);
const server = createServer({ cfg: config, indexer, meta, api });
server.listen(config.port, config.host, () => log.ok("dashboard", `http://${config.host}:${config.port}`));

indexer.start();

// Warm the image cache in the background once the index is live: highest levels first, the grid's default order.
// The first full pass takes ~20 minutes for ~8,000 Squeeks (it yields to anyone browsing), then it's all served from disk.
if (config.warmImages) {
  const order = () => [...(indexer.view?.items ?? [])].sort((a, b) => b.level - a.level || b.power - a.power || a.id - b.id).map((x) => x.id);
  const tick = async () => {
    if (indexer.view?.items?.length) {
      const before = Date.now();
      await meta.warm(order);
      if (meta.warmTotal) log.ok("images cached", `${meta.warmTotal} new in ${Math.round((Date.now() - before) / 1000)}s`), (meta.warmTotal = 0);
    }
    setTimeout(tick, 60_000);
  };
  setTimeout(tick, 5_000);
}
if (!meta.canThumb) log.warn("thumbnails off", "@resvg/resvg-js not installed, the grid shows full SVGs");

const shutdown = () => { indexer.stop(); server.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
