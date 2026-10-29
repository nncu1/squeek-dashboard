# Squeek Dashboard

A live explorer for [Squeekchain](https://sepolia.squeekchain.com), the blockchain mined by a real hamster on a wheel.

**Live:** https://squeek-dashboard.fun

Squeek Dashboard shows every Squeek NFT, who holds it, its level and power, and when it can merge again. It also tracks merges and vault deposits as they happen, ranks wallets by staked power, and lists the apps being built on Squeekchain.

## Features

| Tab | What it shows |
|---|---|
| **Overview** | Squeek block height, Squeektoshi's wheel status and 7-day records, merges per hour (48 h), live Squeeks, holders, staked NFT power, SQK in circulation (staked vs. in wallets) and the level ladder |
| **Squeeks** | Every live Squeek with its art, level, power, merge cooldown and custody (vault or wallet). Filter by ID or owner, level, merge state and custody, and sort by level, power, ID or mint order |
| **Leaderboards** | Wallets ranked by staked power, total power, Squeeks held, Squeeks in the vault, highest level, merges done and pairs ready to merge |
| **Merges** | Live feed of merges (which Squeek absorbed which, and the level reached) next to a feed of vault deposits and withdrawals |
| **Wallet** | Any address: its Squeeks, staked power and rank, mergeable pairs, SQK rewards (claimable, staked, SQK power, daily earnings for 7 days) and full activity |
| **Ecosystem** | A directory of projects built on Squeekchain, in grid or table view, with search and category filters |

Clicking a Squeek opens a detail panel with its art, traits, holder, level, power rank, next merge height and full history (mint, transfers, vault moves, merges), each linked to its transaction.

Every view refreshes in place every 20 seconds: the page, scroll position and loaded images stay put. Links are shareable (`#nft/123`, `#wallet/0x…`, `#ecosystem`), keys `1`–`6` switch tabs and `Esc` closes the detail panel.

## How it uses Squeekchain

Squeekchain keeps its chain state in contracts on Ethereum (Sepolia testnet). The hamster's wheel work is counted by a sensor, signed, settled into Squeek blocks every ten-minute round, and each block issues SQK to staked Squeeks by power. The dashboard reads that state directly:

| Data | Source |
|---|---|
| Mints, transfers, vault deposits and withdrawals, merge burns | `Transfer` logs of the Squeek collection. A transfer into the staking vault is a deposit and the depositor stays the holder |
| Merges (account, survivor, donor, level reached, next merge height) | The collection's merge log, emitted in the same transaction as the donor's burn |
| Level of every live Squeek | `level(tokenId)` on the collection, batched through Multicall3 at one block |
| Power per level, cooldowns, total NFT power, SQK supply and stake | Squeekchain API `/v1/economy/state` |
| Squeek block height and difficulty | Squeekchain API `/v1/core`, with `SqueekCore.state()` on chain as fallback |
| Wheel status and records | Squeekchain API `/v1/status` and `/v1/measurement/stats` |
| A wallet's SQK rewards | Squeekchain API `/v1/accounts/{address}` |
| Squeek art and traits | Squeekchain API `/v1/squeeks/{id}`, with on-chain `tokenURI` as fallback |

A Squeek is **ready to merge** when it is below the maximum level and its next merge height is at or below the current Squeek block height. Only Squeeks in the staking vault count toward staked power.

Contracts indexed by default (Sepolia, deployment of 24 Oct 2026):

| Contract | Address |
|---|---|
| Squeek collection ("Squeek - Sealed") | `0x05142852d9eaF3E66a7a74419e363Bd3539467B0` |
| Staking vault | `0x90112ED64E1A92aaf107736ACE9584b8745020eb` |
| SqueekCore | `0x2aec8094ed6840eff95d284c55cd2585c4de6814` |
| SQK token | `0x1c0df748aa3814a13fb1294c7f1088ecc7b9973a` |

## Running it

Requires Node.js 20.6 or later.

```bash
npm install --omit=dev
npm start
```

Then open http://127.0.0.1:8787.

On first start the server reads the collection's full history from its deployment block, then reads the level of every Squeek. With a good RPC this takes a few minutes, and the top bar shows progress. After that it checks for new blocks every 30 seconds and re-reads levels at least every 2 minutes. The index is saved in `data/state.json`, so a restart resumes where it stopped. If the configured contracts change, the old index is discarded and rebuilt automatically.

Squeek art is a 1568 × 1568 SVG made of thousands of dots, which is slow to draw 40 at a time. The server renders each one once to a 288 px PNG (`@resvg/resvg-js`) for the card grids and keeps it in `data/thumb/`. Only the detail panel shows the original SVG. Once indexing is done, every Squeek's art is pre-rendered in the background, highest levels first.

## Configuration

Every setting has a default. To change one, create a `.env` file in the project folder or set an environment variable.

| Variable | Default | Purpose |
|---|---|---|
| `RPC_URL` | public Sepolia RPCs | Comma-separated RPC endpoints. All are used: the fastest healthy one leads and the others take over when it fails. A free Alchemy or Infura key placed first gives the most reliable sync |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Web server address. Use `HOST=0.0.0.0` to serve other machines |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy or tunnel (Caddy, nginx, Cloudflare) so rate limiting sees the real visitor address |
| `RATE_LIMIT` | `30` | Requests per second per visitor (bursts of 4×), `0` turns it off |
| `POLL_SECONDS` / `POSITIONS_SECONDS` | `30` / `120` | How often to check for new blocks and to re-read levels |
| `LOG_CHUNK` | `10000` | Largest `eth_getLogs` block range. The indexer also lowers it on its own when an RPC refuses a range |
| `WARM_IMAGES` | `1` | `0` turns off background pre-rendering of Squeek art |
| `API_BASE` | Squeekchain API for this deployment | Squeekchain API base URL |
| `NFT_ADDRESS`, `VAULT_ADDRESS`, `CORE_ADDRESS`, `SQK_ADDRESS`, `INDEX_FROM_BLOCK` | current deployment | Override only if Squeekchain redeploys |

## Adding an ecosystem project

Projects on the Ecosystem tab come from `public/ecosystem.json`, so no code change is needed. Add an entry with a `name`, `category`, `description` and optional `website`, `x` and `logo`. Logos go in `public/eco/` (a square PNG, 128 px is enough).

## Tests

```bash
npm install
npm test
```

The test suite starts a local Hardhat node with mock contracts that match the real interfaces, plus a mock Squeekchain API. It plays out a launch (claims, vault deposits, merge ladders up to level 6 both in wallets and inside the vault, transfers and withdrawals), runs the real server against it and checks 25 things. These include totals matching chain, every merge decoded, levels and cooldown states, staked power counting only vault Squeeks, filtering and sorting, the `tokenURI` fallback, SVG sandboxing, RPC fallback, the Alchemy 10-block `eth_getLogs` limit and resuming from saved state.

`node test/run.mjs --keep` leaves the simulated chain and dashboard running at http://127.0.0.1:8790 for a visual check.

## Security

- The dashboard only reads public testnet data. It holds no wallets and no private keys, and RPC keys in `.env` stay on the server.
- NFT art is untrusted input. It is only displayed through `<img>` and served with a `sandbox` Content-Security-Policy, never inlined into the page.
- Art and metadata are served only for token IDs that have been minted, so the server cannot be made to fetch arbitrary IDs.
- Each visitor is rate limited. Keep port 8787 closed to the internet and put a reverse proxy or tunnel in front of it.

## Notes

This runs against the Squeekchain Sepolia testnet: SQK and Squeeks have no monetary value, and contracts may be upgraded or redeployed.