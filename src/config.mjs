// Configuration: .env (optional) + environment, with the published Sepolia deployment as defaults.
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

// tiny .env loader (no dependency, works on every Node >= 20)
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);

export const config = {
  // comma-separated: tried in order, the next one takes over when one fails
  rpcUrls: env("RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com,https://11155111.rpc.thirdweb.com").split(",").map((s) => s.trim()).filter(Boolean),
  // the Squeekchain API for this deployment (metadata, economy, accounts, wheel status)
  apiBase: env("API_BASE", "https://green-dispenser-04.squeekchain.com"),
  mediaBase: env("MEDIA_BASE", "https://media.squeekchain.com"),
  siteUrl: env("SITE_URL", "https://sepolia.squeekchain.com"),
  port: Number(env("PORT", 8787)),
  host: env("HOST", "127.0.0.1"),
  chainId: Number(env("CHAIN_ID", 11155111)),
  confirmations: BigInt(env("CONFIRMATIONS", 12)),
  logChunk: BigInt(env("LOG_CHUNK", 10000)),
  pollSeconds: Number(env("POLL_SECONDS", 30)),
  positionsSeconds: Number(env("POSITIONS_SECONDS", 120)),
  multicallBatch: Number(env("MULTICALL_BATCH", 250)),
  warmImages: env("WARM_IMAGES", "1") !== "0",
  // public hosting: requests per second each visitor may make (burst of 4x), 0 turns the limit off
  rateLimit: Number(env("RATE_LIMIT", 30)),
  // 1 when a reverse proxy (Caddy, nginx, Cloudflare) sits in front: the visitor's address is read from X-Forwarded-For
  trustProxy: env("TRUST_PROXY", "0") === "1",
  dataDir: path.resolve(ROOT, env("DATA_DIR", "data")),
  // Squeekchain deployment of 24 Oct 2026 (release squeeks-sepolia-dispenser-20261024-06)
  fromBlock: BigInt(env("INDEX_FROM_BLOCK", 11985210)),
  core: env("CORE_ADDRESS", "0x2aec8094ed6840eff95d284c55cd2585c4de6814"),
  mining: env("MINING_ADDRESS", "0xac45fe7e42b8a0a44c02f9c8a507e137322cff7a"),
  token: env("SQK_ADDRESS", "0x1c0df748aa3814a13fb1294c7f1088ecc7b9973a"),
  nft: env("NFT_ADDRESS", "0x05142852d9eaf3e66a7a74419e363bd3539467b0"),
  vault: env("VAULT_ADDRESS", "0x90112ed64e1a92aaf107736ace9584b8745020eb"),
  launch: env("LAUNCH_ADDRESS", "0xc79b54028017b9774255bfebac321567d593246e"),
  multicall: env("MULTICALL_ADDRESS", "0xcA11bde05977b3631167028862bE2a173976CA11"),
  explorer: env("EXPLORER", "https://sepolia.etherscan.io"),
};
