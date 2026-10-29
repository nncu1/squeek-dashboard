// squeek-dash front end. No framework, no build step. All data comes from this server's /api.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "-");
const trim0 = (s) => s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
const compact = (n) => (n >= 1e6 ? `${trim0((n / 1e6).toFixed(n >= 1e7 ? 1 : 2))}M` : n >= 1e4 ? `${trim0((n / 1e3).toFixed(n >= 1e5 ? 0 : 1))}k` : fmt(n));
function sqk(base, digits = 1) {
  if (base == null) return "-";
  const b = BigInt(base);
  const v = Number(b / 10n ** 14n) / 1e4;
  return v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : digits });
}
function ago(ts, exact = true) {
  if (!ts) return "-";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  const t = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  return `${exact ? "" : "~"}${t} ago`;
}
const clock = (ts) => new Date(ts * 1000).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const walletLink = (a) => (a ? `<a href="#wallet/${esc(a)}" title="${esc(a)}">${esc(short(a))}</a>` : `<span class="muted">burned</span>`);
const nftLink = (id) => `<a href="#nft/${id}">#${id}</a>`;
const lvClass = (lv, max) => (lv >= Math.max(5, max - 2) ? "lvl lv-hi" : "lvl");

class Starting extends Error {}
async function api(path) {
  const r = await fetch(path);
  if (r.status === 503) throw new Starting("starting");
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

let S = null; // latest summary
const STATE_LABEL = { ready: "ready", cooldown: "cooldown", max: "max level", unknown: "cooldown unknown" };
function stateText(it) {
  if (!it) return "";
  if (it.state === "cooldown") return `cooldown ${fmt(it.blocksUntilMerge)}b`;
  return STATE_LABEL[it.state] ?? it.state;
}

// ------------------------------------------------------------ tooltip
const tip = $("#tooltip");
function showTip(html, ev) {
  tip.innerHTML = html;
  tip.style.display = "block";
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY - h - 10;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
  if (y < 8) y = ev.clientY + 16;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => (tip.style.display = "none");
// a Squeek whose art can't be loaded keeps the dot-grid placeholder behind it
document.addEventListener("error", (e) => { if (e.target instanceof HTMLImageElement) e.target.remove(); }, true);

// ------------------------------------------------------------ dot-matrix numerals (a nod to the DotGrid renderer)
const GLYPH = {
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"], 1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"], 3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], 5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"], 7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"], 9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ",": ["00", "00", "00", "00", "00", "01", "10"],
};
function matrix(text) {
  const cell = 11, r = 3.9;
  let x = 0;
  const dots = [];
  for (const ch of text) {
    const g = GLYPH[ch];
    if (!g) continue;
    g.forEach((row, ry) => [...row].forEach((bit, rx) => dots.push(`<circle cx="${(x + rx) * cell + cell / 2}" cy="${ry * cell + cell / 2}" r="${r}" class="${bit === "1" ? "on" : "off"}"/>`)));
    x += g[0].length + 1;
  }
  return `<svg viewBox="0 0 ${Math.max(1, x - 1) * cell} ${7 * cell}" aria-hidden="true">${dots.join("")}</svg>`;
}

// ------------------------------------------------------------ dot-leader rows, 52 columns (fewer when the screen is narrow)
let charW = 0;
function colsFor(el, want = 52) {
  if (!charW) {
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(20);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    el.appendChild(probe);
    charW = probe.getBoundingClientRect().width / 20 || 8.4;
    probe.remove();
  }
  const fit = Math.floor((el.parentElement?.clientWidth ?? 600) / charW) - 1;
  return Math.max(30, Math.min(want, fit));
}
function leaders(rows, width = 52) {
  return rows.map(([label, value]) => {
    const v = String(value);
    const n = Math.max(2, width - label.length - v.length - 2);
    return `<span class="l">${esc(label)}</span> <span class="d">${".".repeat(n)}</span> <span class="v">${esc(v)}</span>`;
  }).join("\n");
}
function leadersHtml(rows, width = 52) {
  // like leaders(), but value may carry trusted markup (links); visible length computed from text
  return rows.map(([label, value, html]) => {
    const n = Math.max(2, width - label.length - String(value).length - 2);
    return `<span class="l">${esc(label)}</span> <span class="d">${".".repeat(n)}</span> ${html ?? esc(value)}`;
  }).join("\n");
}

// ------------------------------------------------------------ charts
// round an axis maximum up to 1, 2, 2.5 or 5 times a power of ten
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
function hourlyChart(fig, hourly, H = 190) {
  const W = Math.max(300, Math.round(fig.querySelector(".plot").clientWidth || 600)), left = 34, bottom = 22, topPad = 8;
  const every = W < 480 ? 12 : 6;
  const max = niceMax(Math.max(...hourly.map((h) => h.merges)));
  const slot = (W - left - 4) / hourly.length, bw = Math.min(24, slot - 2);
  const y = (v) => topPad + (H - bottom - topPad) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const grid = ticks.map((t) => `<line class="grid" x1="${left}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${left - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join("");
  let peak = 0;
  hourly.forEach((h, i) => { if (h.merges > hourly[peak].merges) peak = i; });
  const bars = hourly.map((h, i) => {
    const x = left + 2 + i * slot + (slot - bw) / 2, top = y(h.merges), base = y(0), hgt = base - top;
    const path = hgt > 0 ? (hgt > 4 ? `M${x} ${base}v${-(hgt - 3)}a3 3 0 0 1 3 -3h${bw - 6}a3 3 0 0 1 3 3v${hgt - 3}z` : `M${x} ${base}v${-hgt}h${bw}v${hgt}z`) : "";
    const label = i % every === 0 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${new Date(h.hour * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</text>` : "";
    const peakLabel = i === peak && h.merges ? `<text class="val" x="${x + bw / 2}" y="${top - 5}" text-anchor="middle">${fmt(h.merges)}</text>` : "";
    return `<g data-i="${i}"><rect class="hit" x="${left + 2 + i * slot}" y="0" width="${slot}" height="${H - bottom}"/>${path ? `<path class="bar-a" d="${path}"/>` : ""}${label}${peakLabel}</g>`;
  }).join("");
  const plot = fig.querySelector(".plot");
  plot.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Merges per hour over the last 48 hours">${grid}${bars}</svg>`;
  plot.querySelectorAll("g[data-i]").forEach((g) => {
    const h = hourly[Number(g.dataset.i)];
    g.addEventListener("mousemove", (ev) => showTip(`${clock(h.hour)}<br>${fmt(h.merges)} merges<br>${fmt(h.deposits)} vault deposits, ${fmt(h.mints)} mints`, ev));
    g.addEventListener("mouseleave", hideTip);
  });
  fig._table = `<table><thead><tr><th>Hour starting</th><th class="r">Merges</th><th class="r">Vault deposits</th><th class="r">Mints</th></tr></thead><tbody>${[...hourly].reverse().map((h) => `<tr><td>${clock(h.hour)}</td><td class="r">${fmt(h.merges)}</td><td class="r">${fmt(h.deposits)}</td><td class="r">${fmt(h.mints)}</td></tr>`).join("")}</tbody></table>`;
}
document.querySelectorAll("figcaption button[data-table]").forEach((b) => b.addEventListener("click", () => {
  const fig = document.getElementById(b.dataset.table);
  fig.classList.toggle("as-table");
  const on = fig.classList.contains("as-table");
  b.textContent = on ? "show chart" : "show table";
  if (on) fig.querySelector(".plot").innerHTML = fig._table ?? "";
  else renderOverview();
}));

// ------------------------------------------------------------ summary + overview
function renderSync() {
  const el = $("#syncline");
  if (!S) return;
  const s = S.sync;
  if (s.error) el.innerHTML = `<span class="dot warn"></span>sync error: ${esc(s.error.slice(0, 90))}`;
  else if (s.backfill != null) el.innerHTML = `<span class="dot"></span>indexing chain history <b>${s.backfill}%</b>`;
  else el.innerHTML = `<span class="dot live"></span>indexed to block <b>${fmt(s.indexedBlock)}</b>, levels at <b>${fmt(s.positionsBlock)}</b>, head ${fmt(s.head)}`;
}

function renderOverview() {
  if (!S) return;
  const c = S.core ?? {};
  $("#height").innerHTML = matrix(fmt(c.blockHeight ?? 0));
  $("#height").setAttribute("aria-label", `Squeek block height ${fmt(c.blockHeight)}`);
  const progress = c.blockProgress != null ? ` ${Math.floor(c.blockProgress / 1e7)}% into the next one.` : "";
  $("#height-cap").textContent = `Squeek blocks mined by Squeektoshi.${progress}`;

  const h = S.hamster;
  const wheel = $("#wheel");
  wheel.classList.toggle("spin", h?.coreStatus === "ACTIVE" && h?.freshness === "online");
  let line = "Wheel status unavailable from the public API.";
  if (h) {
    const km = (h.distanceMm / 1e6).toFixed(2);
    if (h.freshness !== "online") line = "No wheel reading in the last 2 minutes.";
    else if (h.coreStatus === "ACTIVE") line = `Squeektoshi is running at ${(h.speedMmPerSecond * 0.0036).toFixed(1)} km/h. ${km} km since 12:00 UTC.`;
    else if (h.coreStatus === "COUNTER_FAULT") line = "The wheel counter reports a fault, so counting has stopped.";
    else line = `Squeektoshi is resting. ${km} km since 12:00 UTC.`;
  }
  $("#hamster-line").textContent = line;
  const st = S.stream;
  $("#stream-line").innerHTML = !st ? "" : st.state === "live"
    ? `Livestream is on: <a href="${esc(st.url)}" target="_blank" rel="noopener">watch on squeekchain.com</a>`
    : `Livestream ${esc(st.state)}${st.errorCode ? ` (${esc(st.errorCode)})` : ""}.`;
  const R = S.records;
  const recs = !R ? null : [
    ["distance, all time", `${(Number(R.lifetime?.observedDistanceMm ?? 0) / 1e6).toFixed(1)} km`],
    ["top speed", R.topSpeedMmPerSecond?.value ? `${(Number(R.topSpeedMmPerSecond.value) * 0.0036).toFixed(1)} km/h` : "-"],
    ["longest run", R.longestRunMinutes?.value ? `${fmt(R.longestRunMinutes.value)} min` : "-"],
    ["5 km+ days in a row", R.longestDayStreak?.value ? fmt(R.longestDayStreak.value) : "-"],
    ["best day", R.mostWorkDay?.value ? `${fmt(R.mostWorkDay.value)} passes` : "-"],
    ["best half hour", R.mostWorkHalfHour?.value ? `${fmt(R.mostWorkHalfHour.value)} passes` : "-"],
    ["rounds with running", R.rounds ? pct(R.rounds.activeRateBps / 10000) : "-"],
    ["typical round", R.rounds ? `${fmt(R.rounds.medianActiveWork)} passes` : "-"],
  ];
  $("#records").innerHTML = recs ? recs.map(([l, v]) => `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd></div>`).join("")
    : `<div class="wide"><dt>records</dt><dd class="dim">Unavailable from the public API right now.</dd></div>`;

  renderReadout();
  renderLevels();
  renderCharts();
  fitOverview();
}
const sqkNum = (base) => (base == null ? 0 : Number(BigInt(base) / 10n ** 14n) / 1e4);
// Four headline figures, the SQK split, then the slower-moving details as dot leaders.
function renderReadout() {
  const t = S.totals, c = S.core ?? {}, e = S.economy ?? {};
  const top = S.topWallets?.[0];
  const figs = [
    ["live Squeeks", fmt(t.live), `${fmt(t.burned)} burned in merges`],
    ["wallets holding", fmt(t.holders), top?.stakedPower ? `top wallet ${pct(top.share)}` : ""],
    ["staked NFT power", compact(t.stakedPower), `${fmt(t.inVault)} in the vault`],
    ["merges, 24 hours", fmt(S.events.merges24h), `${fmt(S.events.merges1h)} last hour`],
  ];
  $("#figures").innerHTML = figs.map(([l, v, sub]) => `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd>${sub ? `<dd class="sub">${esc(sub)}</dd>` : ""}</div>`).join("");

  const sup = e.supply;
  if (!sup) { $("#supply").innerHTML = `<p class="dim">SQK supply comes from the Squeekchain API, which isn't reachable right now.</p>`; }
  else {
    const live = sqkNum(sup.live), staked = Math.min(live, sqkNum(e.staked)), free = Math.max(0, live - staked);
    const whole = Math.max(staked + free, 1e-9), cap = sqkNum(sup.cap) || 2_100_000_000, capShare = live / cap;
    $("#supply").innerHTML = `
    <div class="supply-top"><span><b>${esc(sqk(sup.live, 0))}</b> SQK in circulation</span><span class="dim">${capShare < 0.001 ? "under 0.1%" : pct(capShare, 1)} of the ${cap >= 1e9 ? `${trim0((cap / 1e9).toFixed(1))}B` : esc(compact(cap))} cap</span></div>
    <div class="split" role="img" aria-label="${esc(`${sqk(e.staked, 0)} SQK staked, ${fmt(Math.round(free))} SQK in wallets`)}">
      <span class="seg-a" style="flex-grow:${staked / whole}"></span><span class="seg-b" style="flex-grow:${free / whole}"></span>
    </div>
    <div class="split-key"><span><i class="k-a"></i>staked in the vault <b>${esc(sqk(e.staked, 0))}</b></span><span><i class="k-b"></i>in wallets <b>${esc(fmt(Math.round(free)))}</b></span></div>`;
  }

  $("#stats").innerHTML = leaders([
    ["work per Squeek block", c.workPerThousandBlocks ? (c.workPerThousandBlocks / 1000).toFixed(2) : "-"],
    ["settled through round", fmt(c.settledThroughRound)],
    ["reward round", e.round ? `${fmt(e.round)}${e.paused ? ", paused" : ""}` : "-"],
    ["Squeeks claimed at launch", e.issued ? `${fmt(e.issued)} of 9,999` : "-"],
  ], colsFor($("#stats")));
}

// The level ladder: how many Squeeks sit on each rung and how much of the earning power each rung holds.
function renderLevels() {
  if (!S) return;
  const max = S.maxLevel, pol = S.policy ?? {}, total = S.totals.power || 1;
  const rows = [];
  for (let l = max; l >= 1; l--) rows.push({ level: l, ...(S.levelDist.find((x) => x.level === l) ?? { count: 0, power: 0, staked: 0 }), each: pol.basePower?.[l - 1], cd: pol.cooldown?.[l - 1] });
  const maxCount = Math.max(1, ...rows.map((r) => r.count)), maxPower = Math.max(1, ...rows.map((r) => r.power));
  const BAR = 150;
  const bar = (cls, v, m) => `<span class="lbar ${cls}" style="width:${v ? Math.max(2, Math.round((v / m) * BAR)) : 0}px"></span>`;
  const cdText = (r) => (r.level === max ? "can't merge" : r.cd == null ? "-" : r.cd ? `${fmt(r.cd)} blocks` : "none");
  $("#level-table").innerHTML = `<thead><tr><th>Level</th><th>Squeeks</th><th class="r">In vault</th><th class="r">Power each</th><th class="r">Total power</th><th>Share of all power</th><th class="r">Cooldown after merge</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr class="${r.count ? "" : "empty"}">
    <td class="${lvClass(r.level, max)}">L${r.level}</td>
    <td><span class="barcell">${bar("la", r.count, maxCount)}<span>${fmt(r.count)}</span></span></td>
    <td class="r">${fmt(r.staked)}</td>
    <td class="r">${r.each != null ? fmt(r.each) : "-"}</td>
    <td class="r">${fmt(r.power)}</td>
    <td><span class="barcell">${bar("lb", r.power, maxPower)}<span>${pct(r.power / total)}</span></span></td>
    <td class="r">${cdText(r)}</td>
    <td>${r.count ? `<a href="#squeeks" data-level="${r.level}">browse</a>` : ""}</td></tr>`).join("")}</tbody>`;
  const highest = rows.find((r) => r.count);
  $("#levels-note").textContent = highest ? `Two Squeeks of the same level merge into one of the next level. Only Squeeks in the staking vault earn. The highest so far is L${highest.level}.` : "";
}
function renderCharts() {
  const fig = $("#fig-hourly"), plot = fig.querySelector(".plot");
  hourlyChart(fig, S.hourly);
  if (fig.classList.contains("as-table")) { plot.innerHTML = fig._table; return; }
  // the chart shares a row with the figures: once laid out, draw it again at the height the row gives it
  const h = Math.floor(plot.clientHeight);
  if (wideScreen() && h > 200) hourlyChart(fig, S.hourly, h - 4);
}

async function loadSummary() {
  try {
    S = await api("/api/summary");
    $("#notice").hidden = true;
    renderSync();
    if (current === "overview") renderOverview();
    fillLevelOptions();
  } catch (e) {
    const n = $("#notice");
    n.hidden = false;
    n.textContent = e instanceof Starting ? "The indexer is starting. The first sync reads the whole chain history and can take a few minutes." : `Can't reach the dashboard server (${e.message}).`;
  }
}

// ------------------------------------------------------------ fit one page into one window
// On wide screens the squeeks grid and the wallet leaderboard size themselves so a whole page, page numbers
// included, fits the window: no inner scroll box, and no page scroll a few pixels long. Phones scroll as usual.
const fits = () => matchMedia("(min-width: 981px)").matches;
const wideScreen = fits;
const overflowY = () => document.documentElement.scrollHeight - innerHeight;

// Cards: pick the column count that gives the largest cards while every row fits above the page numbers.
// The size found for a window is kept, so every page shows the same card size as the first one;
// it is worked out again only when the window changes size or a page no longer fits with it.
let cardFit = null; // { key: window size, c: columns, w: card width }
function fitCards() {
  const grid = $("#cards");
  const key = `${innerWidth}x${innerHeight}`;
  if (fits() && grid.offsetParent !== null && cardFit?.key === key) {
    grid.style.justifyContent = "center";
    grid.style.gridTemplateColumns = `repeat(${cardFit.c}, ${cardFit.w}px)`;
    if (overflowY() <= 0) return;
  }
  grid.style.gridTemplateColumns = ""; grid.style.justifyContent = "";
  if (!fits() || grid.offsetParent === null) return;
  const cards = grid.querySelectorAll(".card");
  if (!cards.length) return;
  const over = overflowY();
  if (over <= 0) return;
  const cs = getComputedStyle(grid), gap = parseFloat(cs.columnGap) || 12, W = grid.clientWidth;
  const first = cards[0], art = first.querySelector(".art");
  const chrome = first.offsetWidth - art.offsetWidth;   // card padding + border, sideways
  const extra = first.offsetHeight - art.offsetHeight;  // padding, border and the two text rows, vertically
  const natCols = cs.gridTemplateColumns.split(" ").length;
  const avail = grid.offsetHeight - over;               // the height the grid may take
  let best = null;
  for (let c = natCols; c <= 16; c++) {
    const rows = Math.ceil(cards.length / c);
    const byHeight = (avail - gap * (rows - 1)) / rows - extra + chrome; // widest card whose height still fits
    const byWidth = (W - gap * (c - 1)) / c;
    const w = Math.floor(Math.min(byHeight, byWidth));
    if (w >= 80 && (!best || w > best.w)) best = { c, w };
  }
  if (!best) return;
  grid.style.justifyContent = "center";
  // sub-pixel rounding can leave a pixel or two; shave the card width until nothing overflows
  let w = best.w;
  for (; w >= 80; w--) {
    grid.style.gridTemplateColumns = `repeat(${best.c}, ${w}px)`;
    if (overflowY() <= 0) break;
  }
  // a short last page would fit bigger cards; it keeps the size of a full page instead
  if (cards.length >= PAGE || !cardFit || cardFit.key !== key) cardFit = { key, c: best.c, w };
  else { grid.style.gridTemplateColumns = `repeat(${cardFit.c}, ${cardFit.w}px)`; }
}

// Overview: tighten the level table first, then shrink the dot-matrix numerals, until the page fits.
function fitOverview() {
  const m = $("#height svg"), table = $("#level-table");
  if (m) m.style.maxWidth = "";
  for (const k of ["--pad-y", "--fs", "--lh"]) table.style.removeProperty(k);
  if (!fits() || overflowY() <= 0) return;
  const shrinkMatrix = (to) => { if (!m) return false; for (let w = parseFloat(m.style.maxWidth) || 640; w >= to; w -= 20) { m.style.maxWidth = `${w}px`; if (overflowY() <= 0) return true; } return false; };
  // the numerals give way first, down to a size that still reads as the hero; then the table rows; then the numerals again
  if (shrinkMatrix(480)) return;
  fitTable(table);
  if (overflowY() > 0) shrinkMatrix(320);
  // last: a shorter merge chart, if the chart is what sets that row's height
  const fig = $("#fig-hourly"), svg = fig.querySelector(".plot svg"), over = overflowY();
  if (over > 0 && svg && !fig.classList.contains("as-table")) hourlyChart(fig, S.hourly, Math.max(120, Math.floor(svg.getBoundingClientRect().height) - over));
}

// Tables: tighten row padding first, then the font a little, until the table and its page numbers fit.
function fitTable(table) {
  for (const k of ["--pad-y", "--fs", "--lh"]) table.style.removeProperty(k);
  if (!fits() || table.offsetParent === null || overflowY() <= 0) return;
  const steps = [[5, 14, 1.5], [4, 14, 1.5], [3, 14, 1.5], [2, 13.5, 1.5], [2, 13, 1.5], [1, 13, 1.45], [1, 12.5, 1.4], [1, 12, 1.4], [0, 12, 1.35], [0, 11.5, 1.3], [0, 11, 1.25]];
  for (const [pad, fs, lh] of steps) {
    table.style.setProperty("--pad-y", `${pad}px`);
    table.style.setProperty("--fs", `${fs}px`);
    table.style.setProperty("--lh", String(lh));
    if (overflowY() <= 0) return;
  }
}

// ------------------------------------------------------------ squeek grid
const PAGE = 40;
const nftState = { page: 1, total: 0, seq: 0 };
function fillLevelOptions() {
  const sel = $("#nft-filters select[name=level]");
  if (!S || sel.options.length > 1) return;
  for (let l = 1; l <= S.maxLevel; l++) sel.add(new Option(`L${l}`, String(l)));
}
// Update a card grid in place: a card whose Squeek is still in the same spot keeps its element and image,
// only its text rows change; anything else is swapped. A refresh never reloads art or moves the view.
function patchCards(grid, items, empty = "") {
  if (!items.length) { grid.innerHTML = empty; return true; }
  const tpl = document.createElement("template");
  let changed = false;
  if (grid.querySelector(":scope > :not(.card)")) grid.innerHTML = "";
  items.forEach((it, i) => {
    tpl.innerHTML = card(it).trim();
    const fresh = tpl.content.firstElementChild, old = grid.children[i];
    if (!old) { grid.appendChild(fresh); changed = true; return; }
    if (old.dataset.id !== String(it.id)) { old.replaceWith(fresh); changed = true; return; }
    const oldRows = old.querySelectorAll(".row"), newRows = fresh.querySelectorAll(".row");
    newRows.forEach((r, k) => { if (oldRows[k] && oldRows[k].innerHTML !== r.innerHTML) { oldRows[k].innerHTML = r.innerHTML; changed = true; } });
    if (old.getAttribute("aria-label") !== fresh.getAttribute("aria-label")) old.setAttribute("aria-label", fresh.getAttribute("aria-label"));
  });
  while (grid.children.length > items.length) { grid.lastElementChild.remove(); changed = true; }
  return changed;
}
// merge state on a card: "ready", "18k blk" for a cooldown, "max"; the full text is in the tooltip
const cardState = (it) => (it.state === "cooldown" ? `${cardPw(it.blocksUntilMerge)} blk` : it.state === "max" ? "max" : it.state === "unknown" ? "?" : STATE_LABEL[it.state] ?? it.state);
// power on a card, short enough for a narrow card: 3k, 31k, 1.02M
const cardPw = (n) => (n >= 1e6 ? `${trim0((n / 1e6).toFixed(2))}M` : n >= 1000 ? `${trim0((n / 1000).toFixed(n >= 1e4 ? 0 : 1))}k` : fmt(n));
function card(it) {
  return `<button class="card" type="button" data-id="${it.id}" aria-label="Squeek ${it.id}, level ${it.level}">
    <span class="art"><img src="/api/thumb/${it.id}" alt="" width="144" height="144" loading="lazy" decoding="async"></span>
    <span class="row"><b>#${it.id}</b><span class="${lvClass(it.level, S?.maxLevel ?? 10)}">L${it.level}</span></span>
    <span class="row"><span class="dim" title="${fmt(it.power)} power${it.vault ? ", staked in the vault" : ", in a wallet, not earning"}">${it.vault ? `<i class="vault-mark" aria-label="staked"></i>` : ""}${cardPw(it.power)}</span><span class="st st-${it.state}" title="${esc(stateText(it))}">${esc(cardState(it))}</span></span></button>`;
}
function nftQuery() {
  const f = new FormData($("#nft-filters"));
  const p = new URLSearchParams();
  for (const [k, v] of f) if (v) p.set(k, String(v));
  return p;
}
// Page numbers around the current one, with gaps: 1 … 4 5 [6] 7 8 … 120
function pageList(cur, last) {
  const keep = new Set([1, last, cur - 2, cur - 1, cur, cur + 1, cur + 2]);
  if (cur <= 4) [2, 3, 4, 5].forEach((n) => keep.add(n));
  if (cur >= last - 3) [last - 4, last - 3, last - 2, last - 1].forEach((n) => keep.add(n));
  const out = [];
  let prev = 0;
  for (const n of [...keep].filter((n) => n >= 1 && n <= last).sort((x, y) => x - y)) {
    if (n - prev === 2) out.push(n - 1); // a gap of one page shows the number, not "…"
    else if (n - prev > 2) out.push("…");
    out.push(n);
    prev = n;
  }
  return out;
}
function renderPager(el, cur, last) {
  if (last <= 1) { el.innerHTML = ""; return; }
  const btn = (n, label, aria, dis) => `<button type="button" class="pg" data-page="${n}" aria-label="${aria}"${dis ? " disabled" : ""}>${label}</button>`;
  el.innerHTML = btn(cur - 1, "◀", "Previous page", cur === 1)
    + pageList(cur, last).map((n) => n === "…" ? `<span class="gap" aria-hidden="true">…</span>`
      : n === cur ? `<button type="button" class="pg cur" aria-current="page" aria-label="Page ${n}, current">${n}</button>` : btn(n, n, `Page ${n}`)).join("")
    + btn(cur + 1, "▶", "Next page", cur === last);
}
async function loadNfts(reset, page = nftState.page, { silent = false } = {}) {
  if (reset) page = 1;
  const seq = ++nftState.seq; // a newer request wins; older answers are dropped
  const p = nftQuery();
  p.set("offset", (page - 1) * PAGE); p.set("limit", PAGE);
  if (!silent) $("#cards").setAttribute("aria-busy", "true");
  try {
    const r = await api(`/api/nfts?${p}`);
    if (seq !== nftState.seq) return;
    const last = Math.max(1, Math.ceil(r.total / PAGE));
    if (page > last && r.total) return loadNfts(false, last);
    nftState.page = page; nftState.total = r.total;
    const grid = $("#cards"), before = grid.children.length;
    if (silent) patchCards(grid, r.items, `<p class="dim">No Squeeks match these filters.</p>`);
    else grid.innerHTML = r.items.map(card).join("") || `<p class="dim">No Squeeks match these filters.</p>`;
    const from = r.total ? (page - 1) * PAGE + 1 : 0, to = (page - 1) * PAGE + r.items.length;
    $("#nft-count").textContent = r.total ? `${fmt(from)}–${fmt(to)} of ${fmt(r.total)} Squeeks` : "0 Squeeks";
    renderPager($("#pager"), page, last);
    if (!silent || grid.children.length !== before) fitCards(); // 40 cards + page numbers in one window, no page scroll
    if (!silent && page < last) prefetchPage(seq, page + 1);
  } catch {} finally { if (seq === nftState.seq) $("#cards").removeAttribute("aria-busy"); }
}
// Once this page's images are in, quietly fetch the next page's so "▶" is instant.
async function prefetchPage(seq, page) {
  await Promise.all([...document.querySelectorAll("#cards img")].map((img) => img.complete ? null : new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); })));
  if (seq !== nftState.seq) return;
  const p = nftQuery(); p.set("offset", (page - 1) * PAGE); p.set("limit", PAGE);
  const r = await api(`/api/nfts?${p}`).catch(() => null);
  for (const it of r?.items ?? []) { if (seq !== nftState.seq) return; const im = new Image(); im.decoding = "async"; im.src = `/api/thumb/${it.id}`; }
}
$("#pager").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-page]");
  if (!b || b.disabled) return;
  // wide screens scroll the grid box (reset in loadNfts); a phone scrolls the page back to the filters
  loadNfts(false, Number(b.dataset.page)).then(() => { if (!matchMedia("(min-width: 981px)").matches) $("#nft-filters").scrollIntoView({ block: "start" }); });
});
let debounce;
$("#nft-filters").addEventListener("input", (e) => { clearTimeout(debounce); debounce = setTimeout(() => loadNfts(true), e.target.name === "q" ? 260 : 0); });
$("#nft-filters").addEventListener("submit", (e) => { e.preventDefault(); loadNfts(true); });
document.addEventListener("click", (e) => {
  const c = e.target.closest(".card[data-id]");
  if (c) location.hash = `nft/${c.dataset.id}`;
});

// ------------------------------------------------------------ leaderboards
const WPAGE = 30;
const wState = { page: 1, seq: 0 };
async function loadWallets(reset, page = wState.page, { silent = false } = {}) {
  if (reset) page = 1;
  const seq = ++wState.seq; // the latest page/sort/filter wins; slower older answers are dropped
  const offset = (page - 1) * WPAGE;
  const p = new URLSearchParams({ sort: $("#wallet-sort").value, offset, limit: WPAGE });
  const q = $("#wallet-q").value.trim();
  if (q) p.set("q", q.toLowerCase());
  const r = await api(`/api/wallets?${p}`).catch(() => null);
  if (!r || seq !== wState.seq) return;
  const last = Math.max(1, Math.ceil(r.total / WPAGE));
  if (page > last && r.total) return loadWallets(false, last);
  wState.page = page;
  const maxShare = Math.max(1e-9, ...r.items.map((w) => w.share));
  const rows = r.items.map((w, i) => `<tr><td>${offset + i + 1}</td><td>${walletLink(w.address)}</td><td class="r">${fmt(w.count)}</td><td class="r">${fmt(w.inVault)}</td>
    <td class="r">${fmt(w.stakedPower)}</td><td><span class="sharebar" style="width:${Math.round((w.share / maxShare) * 90)}px"></span>${pct(w.share, 2)}</td>
    <td class="r">${fmt(w.power)}</td><td class="${lvClass(w.maxLevel, S?.maxLevel ?? 10)}">L${w.maxLevel}</td><td class="r">${fmt(w.mergeablePairs)}</td>
    <td class="r">${fmt(w.merges)}</td></tr>`).join("");
  const head = `<thead><tr><th>#</th><th>Wallet</th><th class="r">Squeeks</th><th class="r">In vault</th><th class="r">Staked power</th><th>Share of staked power</th><th class="r">Total power</th><th>Top</th><th class="r">Pairs ready</th><th class="r">Merges</th></tr></thead>`;
  const table = $("#wallet-table"), body = rows || `<tr><td colspan="10" class="dim">No wallet matches this address.</td></tr>`;
  const before = table.tBodies[0]?.rows.length ?? -1;
  if (!silent || !table.tBodies[0]) table.innerHTML = `${head}<tbody>${body}</tbody>`;
  else if (table.tBodies[0].innerHTML !== body) table.tBodies[0].innerHTML = body; // same table element, so its fitted sizes stay
  $("#wallet-count").textContent = r.total > WPAGE ? `${fmt(offset + 1)}–${fmt(offset + r.items.length)} of ${fmt(r.total)} wallets` : `${fmt(r.total)} wallets`;
  renderPager($("#wallet-pages"), page, last);
  if (!silent || table.tBodies[0].rows.length !== before) fitTable(table); // 30 rows + page numbers in one window, no page scroll
}
$("#wallet-sort").addEventListener("change", () => loadWallets(true));
let wDebounce;
$("#wallet-q").addEventListener("input", () => { clearTimeout(wDebounce); wDebounce = setTimeout(() => loadWallets(true), 260); });
$("#wallet-pages").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-page]");
  if (!b || b.disabled) return;
  loadWallets(false, Number(b.dataset.page));
});

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-level]");
  if (!a) return;
  const f = $("#nft-filters");
  f.level.value = a.dataset.level; f.state.value = ""; f.custody.value = ""; f.q.value = ""; f.sort.value = "power";
  setTimeout(() => loadNfts(true), 0);
});

// ------------------------------------------------------------ merges
const BOX_ROWS = 30;
const mState = { offset: 0, total: 0, loading: false };
// Show BOX_ROWS rows; anything older scrolls inside the box. Measured, so it holds whatever the row height is.
// The box also stops at the bottom of the window, so the page itself never scrolls a few pixels for it.
function capRows(box, n = BOX_ROWS) {
  const rows = box.querySelectorAll("tbody tr");
  const head = box.querySelector("thead")?.getBoundingClientRect().height ?? 0;
  const rowsH = rows.length > n ? Math.ceil(head + rows[n].getBoundingClientRect().top - rows[0].getBoundingClientRect().top) + 2 : Infinity;
  const note = box.nextElementSibling?.classList.contains("box-note") ? box.nextElementSibling.offsetHeight + 8 : 0;
  const mainPad = parseFloat(getComputedStyle($("main")).paddingBottom) || 0;
  const top = box.getBoundingClientRect().top + scrollY;
  // side by side (wide screens) the boxes fill the window; stacked on a phone the page scrolls anyway
  const fit = matchMedia("(min-width: 981px)").matches ? Math.floor(innerHeight - top - note - mainPad - 1) : Infinity;
  const h = Math.min(rowsH, Math.max(240, fit));
  box.style.maxHeight = Number.isFinite(h) && box.scrollHeight > h ? `${h}px` : "";
}
// Both merge boxes share one row: cap each, then take back exactly what still overflows the window
// (margins below the grid and the section), so the page itself has nothing left to scroll.
function fitMergeBoxes() { fitBoxes([$("#merge-scroll"), $("#vault-scroll")]); }
// Cap each box, then take back whatever still overflows the window (pager, notes, margins below).
function fitBoxes(boxes) {
  boxes.forEach((b) => { b.style.maxHeight = ""; capRows(b); });
  if (!matchMedia("(min-width: 981px)").matches) return;
  const over = document.documentElement.scrollHeight - innerHeight;
  if (over <= 0) return;
  for (const b of boxes) if (b.style.maxHeight) b.style.maxHeight = `${Math.max(240, parseFloat(b.style.maxHeight) - over)}px`;
}
const txLink = (tx) => `<a href="${esc(S?.explorer ?? "")}/tx/${esc(tx)}" target="_blank" rel="noopener">tx</a>`;
function mergeRow(e) {
  const what = e.s != null ? `${nftLink(e.s)} <span class="muted">absorbed</span> ${nftLink(e.d)}` : `${nftLink(e.d)} <span class="muted">merged away</span>`;
  return `<tr><td class="muted" title="block ${fmt(e.b)}">${ago(e.ts, e.tsExact)}</td><td>${walletLink(e.o)}</td>
    <td>${what}</td><td class="${e.lv ? lvClass(e.lv, S?.maxLevel ?? 10) : "muted"}">${e.lv ? `L${e.lv}` : "-"}</td>
    <td>${txLink(e.tx)}</td></tr>`;
}
function vaultRow(e) {
  const dep = e.k === "deposit";
  return `<tr><td class="muted" title="block ${fmt(e.b)}">${ago(e.ts, e.tsExact)}</td><td>${walletLink(e.o)}</td>
    <td><span class="${dep ? "in" : "out"}">${dep ? "deposited" : "withdrew"}</span> ${nftLink(e.id)}</td>
    <td class="${e.level ? lvClass(e.level, S?.maxLevel ?? 10) : "muted"}">${e.level ? `L${e.level}` : "burned"}</td>
    <td class="r">${e.power != null ? fmt(e.power) : "-"}</td><td>${txLink(e.tx)}</td></tr>`;
}
async function loadMerges(reset) {
  if (mState.loading && !reset) return;
  mState.loading = true;
  if (reset) mState.offset = 0;
  const [r, p] = await Promise.all([api(`/api/merges?offset=${mState.offset}&limit=50`), reset ? api("/api/vault?limit=200") : null]).catch(() => [null, null]);
  mState.loading = false;
  if (!r) return;
  const head = `<thead><tr><th>When</th><th>Wallet</th><th>Merge</th><th>Reached</th><th></th></tr></thead>`;
  if (reset) $("#merge-table").innerHTML = `${head}<tbody>${r.items.map(mergeRow).join("") || `<tr><td colspan="5" class="dim">No merges yet.</td></tr>`}</tbody>`;
  else $("#merge-table tbody").insertAdjacentHTML("beforeend", r.items.map(mergeRow).join(""));
  mState.offset += r.items.length;
  mState.total = r.total;
  $("#merge-note").textContent = r.total <= BOX_ROWS ? "" : mState.offset < r.total ? `${fmt(mState.offset)} of ${fmt(r.total)} loaded, scroll the table for older merges` : `all ${fmt(r.total)} merges loaded`;
  if (p) {
    $("#merge-kv").innerHTML = `<span>merges so far <b>${fmt(r.total)}</b></span><span>last hour <b>${fmt(S?.events.merges1h)}</b></span><span>last 24 hours <b>${fmt(S?.events.merges24h)}</b></span><span>ready to merge <b>${fmt(p.ready)}</b></span><span>in cooldown <b>${fmt(p.cooldown)}</b></span><span>in the vault <b>${fmt(p.inVault)}</b></span>`;
    $("#vault-table").innerHTML = `<thead><tr><th>When</th><th>Wallet</th><th>Move</th><th>Level now</th><th class="r">Power</th><th></th></tr></thead><tbody>${p.items.map(vaultRow).join("") || `<tr><td colspan="6" class="dim">No deposits yet.</td></tr>`}</tbody>`;
    $("#vault-note").textContent = p.items.length > BOX_ROWS ? `latest ${fmt(p.items.length)}, scroll the table for older ones` : "";
  }
  // measure once all text is in place: the notes under the boxes count toward the fit
  fitMergeBoxes();
}
// Older merges load by themselves as the box nears its end.
$("#merge-scroll").addEventListener("scroll", (e) => {
  const el = e.currentTarget;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 240 && mState.offset < mState.total) loadMerges(false);
}, { passive: true });

// ------------------------------------------------------------ wallet
let walletAddr = null;
const walletFacts = (w, el) => leaders([
  ["Squeeks held", `${fmt(w.count)} (${fmt(w.inVault)} in the vault)`], ["staked power rank", `#${fmt(w.rank)}`],
  ["staked NFT power", fmt(w.stakedPower)], ["share of all staked power", pct(w.share, 3)], ["power of all its Squeeks", fmt(w.power)],
  ["highest level", `L${w.maxLevel}`], ["pairs ready to merge now", fmt(w.mergeablePairs)], ["merges done", fmt(w.merges)],
], colsFor(el));
const walletLevels = (w) => Object.entries(w.levels).sort((a, b) => Number(b[0]) - Number(a[0])).map(([l, n]) => `L${l}×${n}`).join("  ");
async function loadWallet(addr, { silent = false } = {}) {
  const view = $("#wallet-view");
  if (!silent) { walletAddr = addr; $("#wallet-form").addr.value = addr; view.innerHTML = `<p class="dim">Loading ${esc(short(addr))}</p>`; }
  const r = await api(`/api/wallet/${addr}`).catch(() => null);
  if (silent && (addr !== walletAddr || !r)) return;
  if (!r) { view.innerHTML = `<p class="dim">Couldn't load this wallet.</p>`; return; }
  const w = r.summary;
  // a refresh rewrites only the numbers, the activity list (keeping its scroll) and the cards on the page shown
  if (silent && w && $("#wallet-facts")) {
    const facts = $("#wallet-facts"), html = walletFacts(w, view);
    if (facts.innerHTML !== html) facts.innerHTML = html;
    $("#wallet-levels").textContent = walletLevels(w);
    $("#wallet-actcount").textContent = fmt(r.activity?.length ?? 0);
    const act = $("#wallet-act"), list = activityList(r.activity, addr);
    if (act.innerHTML !== list) { const top = act.scrollTop; act.innerHTML = list; act.scrollTop = top; }
    walletCards.items = r.items;
    showWalletPage(walletCards.page, { silent: true });
    loadEarnings(addr);
    return;
  }
  if (!w) { view.innerHTML = `<p class="dim">${esc(addr)} holds no Squeeks right now.</p>${activityList(r.activity, addr)}`; return; }
  view.innerHTML = `<div class="wallet-split"><div class="wallet-main"><h2><a href="${esc(S?.explorer ?? "")}/address/${esc(addr)}" target="_blank" rel="noopener">${esc(addr)}</a></h2>
    <pre class="facts" id="wallet-facts">${walletFacts(w, view)}</pre>
    <p class="dim" id="wallet-levels">${esc(walletLevels(w))}</p>
    <h3>SQK rewards</h3><pre class="facts" id="wallet-earn"><span class="dim">Loading rewards</span></pre>
    <div class="cards-head"><h3>Squeeks <span class="muted" id="wallet-range"></span></h3><nav class="pager" id="wallet-pager" aria-label="Wallet Squeek pages"></nav></div>
    <div class="cards" id="wallet-cards"></div>
    </div>
    <aside class="activity"><h3>Activity <span class="muted" id="wallet-actcount">${fmt(r.activity?.length ?? 0)}</span></h3><div class="scroll" id="wallet-act" tabindex="0" aria-label="Wallet activity">${activityList(r.activity, addr)}</div></aside></div>`;
  walletCards.items = r.items;
  showWalletPage(1);
  loadEarnings(addr);
}
// A wallet's Squeeks come in one response, so its pages are cut here: 5 cards per page once there are more than 5.
const WALLET_PAGE = 5;
const walletCards = { items: [], page: 1 };
function showWalletPage(page, { silent = false } = {}) {
  const all = walletCards.items, last = Math.max(1, Math.ceil(all.length / WALLET_PAGE));
  page = Math.min(Math.max(1, page), last);
  walletCards.page = page;
  const slice = all.slice((page - 1) * WALLET_PAGE, page * WALLET_PAGE);
  if (silent) patchCards($("#wallet-cards"), slice); else $("#wallet-cards").innerHTML = slice.map(card).join("");
  $("#wallet-range").textContent = last > 1 ? `${fmt((page - 1) * WALLET_PAGE + 1)}–${fmt((page - 1) * WALLET_PAGE + slice.length)} of ${fmt(all.length)}` : "";
  renderPager($("#wallet-pager"), page, last);
}
$("#wallet-view").addEventListener("click", (e) => {
  const b = e.target.closest("#wallet-pager button[data-page]");
  if (b && !b.disabled) showWalletPage(Number(b.dataset.page));
});
async function loadEarnings(addr) {
  const el = $("#wallet-earn");
  if (!el) return;
  const e = await api(`/api/wallet/${addr}/earnings`).catch(() => null);
  if (!e || e.status !== "available") { el.innerHTML = `<span class="dim">Rewards come from the Squeekchain API, which isn't reachable right now.</span>`; return; }
  const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", day: "numeric", timeZone: "UTC" });
  const week = e.days.reduce((n, d) => n + BigInt(d.earnedBaseUnits ?? 0), 0n);
  const html = leaders([
    ["NFT power counted for rewards", fmt(e.nftPower)], ["SQK power from staked SQK", fmt(e.sqkPower)],
    ["SQK staked", sqk(e.staked)], ["claimable now", sqk(e.claimable)],
    ["paid to the wallet so far", sqk(e.paid)], ["claimed straight into stake", sqk(e.claimedToStake)],
    ["earned in the last 7 days", sqk(week)],
    ...e.days.slice().reverse().map((d) => [`  ${day(d.date)} (UTC)`, sqk(d.earnedBaseUnits)]),
  ], colsFor(el));
  if (el.innerHTML !== html) el.innerHTML = html;
}
function activityList(evs, addr) {
  if (!evs?.length) return `<p class="dim">No activity indexed.</p>`;
  return `<ul class="history">${evs.map((e) => `<li><span class="t">${ago(e.ts, e.tsExact)}</span><span>${describe(e, null, addr)}</span></li>`).join("")}</ul>`;
}
$("#wallet-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const a = e.target.addr.value.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) location.hash = `wallet/${a.toLowerCase()}`;
  else $("#wallet-view").innerHTML = `<p class="dim">Enter a full 42-character address starting with 0x.</p>`;
});

// ------------------------------------------------------------ event text
function describe(e, id, addr) {
  const you = (a) => (addr && a === addr ? "this wallet" : walletLink(a));
  switch (e.k) {
    case "mint": return `Minted ${nftLink(e.id)} to ${you(e.to)}`;
    case "transfer": return `${nftLink(e.id)} sent from ${you(e.from)} to ${you(e.to)}`;
    case "burn": return `${nftLink(e.id)} burned in a merge`;
    case "deposit": return `${you(e.o)} deposited ${nftLink(e.id)} into the staking vault`;
    case "withdraw": return `${you(e.o)} withdrew ${nftLink(e.id)} from the staking vault`;
    case "merge": {
      const reached = e.lv ? ` and reached L${e.lv}` : "";
      if (e.s == null) return `${nftLink(e.d)} was merged away${id == null ? ` (${you(e.o)})` : ""}`;
      if (id != null && e.d === id) return `Merged into ${nftLink(e.s)}${e.lv ? `, which reached L${e.lv}` : ""}`;
      return `${nftLink(e.s)} absorbed ${nftLink(e.d)}${reached}${id == null ? ` (${you(e.o)})` : ""}`;
    }
    default: return esc(e.k);
  }
}

// ------------------------------------------------------------ NFT drawer
const drawer = $("#drawer"), scrim = $("#scrim");
let lastFocus = null;
async function openNft(id) {
  lastFocus = document.activeElement;
  drawer.hidden = false;
  drawer.innerHTML = `<header><h2 id="drawer-title">Squeek #${id}</h2><button class="close" type="button" aria-label="Close">esc</button></header><p class="dim">Loading</p>`;
  requestAnimationFrame(() => { drawer.classList.add("open"); scrim.classList.add("open"); });
  drawer.querySelector(".close").focus();
  const [d, m] = await Promise.all([api(`/api/nft/${id}`).catch(() => null), api(`/api/meta/${id}`).catch(() => null)]);
  if (!d) { drawer.innerHTML = `<header><h2 id="drawer-title">Squeek #${id}</h2><button class="close" type="button">esc</button></header><p class="dim">This token was never minted.</p>`; return; }
  const p = d.position;
  const max = d.maxLevel;
  let mergeLine = ["merge", "-"];
  if (d.burned) mergeLine = ["merge", "burned as a donor"];
  else if (p?.state === "ready") mergeLine = ["merge", "ready now"];
  else if (p?.state === "cooldown") mergeLine = ["merge", `in ${fmt(p.blocksUntilMerge)} more Squeek blocks (#${fmt(p.nextMergeHeight)})`];
  else if (p?.state === "max") mergeLine = ["merge", "max level, can't merge"];
  else if (p?.state === "unknown") mergeLine = ["merge", "cooldown not known yet"];
  const rows = d.burned
    ? [["status", "burned in a merge"], ["burned at block", fmt(d.burnBlock)], ["last owner", short(d.burnedBy), walletLink(d.burnedBy)]]
    : [
      [p?.vault ? "depositor" : "owner", short(d.owner), walletLink(d.owner)],
      ["where", p?.vault ? "staking vault, earning" : "wallet, not earning"],
      ["level", `L${p?.level ?? "?"} of ${max}`],
      ["power", `${fmt(p?.power)}  rank #${fmt(p?.powerRank)}`],
      mergeLine,
      ...(d.ownerSummary ? [["holder has", `${fmt(d.ownerSummary.count)} Squeeks, ${pct(d.ownerSummary.share, 2)} of staked power`]] : []),
    ];
  rows.push(["minted", d.mint?.ts ? `${clock(d.mint.ts)} (${ago(d.mint.ts, d.mint.exact)})` : `block ${fmt(d.mint?.block)}`]);
  const attrs = m?.attributes?.length ? `<div class="attrs">${m.attributes.map((a) => `<span><i>${esc(a.trait)}</i>${esc(a.value)}</span>`).join("")}</div>` : "";
  drawer.innerHTML = `<header><h2 id="drawer-title">${esc(m?.name ?? `Squeek #${id}`)}</h2><button class="close" type="button" aria-label="Close">esc</button></header>
    <div class="art">${d.burned ? "" : `<img src="/api/image/${id}" alt="Squeek #${id} artwork">`}</div>
    ${attrs}
    <pre class="facts">${leadersHtml(rows, Math.min(48, colsFor(drawer, 48)))}</pre>
    <h3>History</h3>
    <ul class="history">${d.history.map((e) => `<li><span class="t" title="block ${fmt(e.b)}">${ago(e.ts, e.tsExact)}</span><span>${describe(e, id)} <a class="muted" href="${esc(S?.explorer ?? "")}/tx/${esc(e.tx)}" target="_blank" rel="noopener">tx</a></span></li>`).join("")}</ul>`;
  drawer.querySelector(".close").focus();
}
function closeNft() {
  drawer.classList.remove("open");
  scrim.classList.remove("open");
  setTimeout(() => (drawer.hidden = true), 200);
  if (location.hash.startsWith("#nft/")) history.replaceState(null, "", `#${lastTab}`);
  lastFocus?.focus?.();
}
drawer.addEventListener("click", (e) => { if (e.target.closest(".close")) closeNft(); });
scrim.addEventListener("click", closeNft);

// ------------------------------------------------------------ ecosystem
// Projects come from /ecosystem.json, so adding one needs no code change.
const eco = { data: null, view: "grid" };
try { eco.view = localStorage.getItem("eco-view") === "table" ? "table" : "grid"; } catch {}
const GLOBE = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><ellipse cx="8" cy="8" rx="2.7" ry="6.2"/><line x1="1.8" y1="8" x2="14.2" y2="8"/></svg>`;
const XMARK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path class="fill" d="M12.2 1.5h2.2L9.6 7l5.6 7.5h-4.4L7.4 9.9 3.4 14.5H1.2l5.1-5.9L.9 1.5h4.5l3.1 4.1zm-.8 11.7h1.2L4.7 2.7H3.4z"/></svg>`;
const safeUrl = (u) => (/^https:\/\//.test(u ?? "") ? u : null);
const safeLogo = (u) => (/^eco\/[\w.-]+\.(png|jpe?g|webp|svg)$/.test(u ?? "") ? `/${u}` : null);
function ecoLogo(p) {
  const src = safeLogo(p.logo);
  if (src) return `<img class="eco-logo" src="${esc(src)}" alt="" width="48" height="48" loading="lazy">`;
  const letters = String(p.name ?? "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  return `<span class="eco-logo eco-mono" aria-hidden="true">${esc(letters)}</span>`;
}
function ecoLinks(p) {
  const w = safeUrl(p.website), x = safeUrl(p.x);
  return `${w ? `<a class="eco-ico" href="${esc(w)}" target="_blank" rel="noopener" aria-label="${esc(p.name)} website" title="${esc(w.replace(/^https:\/\//, "").replace(/\/$/, ""))}">${GLOBE}</a>` : ""}${x ? `<a class="eco-ico" href="${esc(x)}" target="_blank" rel="noopener" aria-label="${esc(p.name)} on X" title="${esc(x.replace(/^https:\/\/(x|twitter)\.com\//, "@"))}">${XMARK}</a>` : ""}`;
}
const ecoHome = (p) => safeUrl(p.website) ?? safeUrl(p.x);
function ecoCard(p) {
  const home = ecoHome(p);
  return `<article class="eco-card">
    <header>${ecoLogo(p)}<div class="eco-id"><div class="eco-name">${home ? `<a href="${esc(home)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}${ecoLinks(p)}</div><span class="chip">${esc(p.category ?? "Other")}</span></div></header>
    <p>${esc(p.description ?? "")}</p></article>`;
}
function renderEco() {
  const el = $("#eco-view");
  if (!eco.data) { el.innerHTML = `<p class="dim">Loading projects</p>`; return; }
  const q = $("#eco-q").value.trim().toLowerCase(), cat = $("#eco-cat").value;
  const list = eco.data.projects.filter((p) => (!cat || p.category === cat) && (!q || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q)));
  $("#eco-count").textContent = `${fmt(list.length)} project${list.length === 1 ? "" : "s"}`;
  document.querySelectorAll("#tab-ecosystem .seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === eco.view)));
  if (!list.length) { el.innerHTML = `<p class="dim eco-empty">${cat ? `No ${esc(cat)} projects yet.` : "No project matches this search."}</p>`; return; }
  if (eco.view === "grid") { el.innerHTML = `<div class="eco-grid">${list.map(ecoCard).join("")}</div>`; return; }
  el.innerHTML = `<div class="tablewrap eco-table"><table><thead><tr><th>Project</th><th>Category</th><th>What it is</th><th>Links</th></tr></thead><tbody>${list.map((p) => {
    const home = ecoHome(p);
    return `<tr><td><span class="eco-cell">${ecoLogo(p)}${home ? `<a href="${esc(home)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}</span></td><td><span class="chip">${esc(p.category ?? "Other")}</span></td><td class="eco-desc">${esc(p.description ?? "")}</td><td><span class="eco-links">${ecoLinks(p)}</span></td></tr>`;
  }).join("")}</tbody></table></div>`;
}
async function loadEco() {
  if (!eco.data) {
    eco.data = await fetch("/ecosystem.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({ categories: [], projects: [] }));
    const cats = [...new Set([...(eco.data.categories ?? []), ...eco.data.projects.map((p) => p.category).filter(Boolean)])];
    const sel = $("#eco-cat");
    for (const c of cats) sel.add(new Option(c, c));
  }
  renderEco();
}
$("#eco-q").addEventListener("input", renderEco);
$("#eco-cat").addEventListener("change", renderEco);
$("#tab-ecosystem .seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  eco.view = b.dataset.view;
  try { localStorage.setItem("eco-view", eco.view); } catch {}
  renderEco();
});

// ------------------------------------------------------------ routing
const TABS = ["overview", "squeeks", "leaders", "active", "wallet", "ecosystem"];
let current = "overview", lastTab = "overview";
const loaded = new Set();
function showTab(name) {
  current = name;
  lastTab = name;
  document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll("main > section").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  if (name === "overview") renderOverview();
  if (name === "squeeks" && !loaded.has("squeeks")) { loaded.add("squeeks"); loadNfts(true); }
  else if (name === "squeeks") fitCards(); // the window may have changed size while away
  if (name === "leaders") loadWallets(false);
  if (name === "active") loadMerges(true);
  if (name === "ecosystem") loadEco();
}
function route() {
  const h = location.hash.slice(1);
  const nft = h.match(/^nft\/(\d+)$/);
  const wal = h.match(/^wallet\/(0x[0-9a-fA-F]{40})$/);
  if (nft) { if (!["squeeks", "overview", "leaders", "active", "wallet"].includes(current)) showTab("overview"); return openNft(Number(nft[1])); }
  if (drawer.classList.contains("open")) closeNft();
  if (wal) { showTab("wallet"); return loadWallet(wal[1].toLowerCase()); }
  const tab = TABS.includes(h) ? h : "overview";
  showTab(tab);
}
document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => (location.hash = b.dataset.tab)));
addEventListener("hashchange", route);
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drawer.classList.contains("open")) return closeNft();
  if (e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const i = Number(e.key) - 1;
  if (i >= 0 && i < TABS.length) location.hash = TABS[i];
});

let rz;
addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (current === "overview" && S) renderOverview(); if (current === "active") fitMergeBoxes(); if (current === "leaders") fitTable($("#wallet-table")); if (current === "squeeks") fitCards(); }, 150); });

await loadSummary();
route();
// Everything on screen refreshes every 20 seconds while the tab is visible, in place: same page, same scroll.
async function refreshVisible() {
  if (document.hidden) return;
  await loadSummary();
  // merges: only when nobody is reading further down either list, so the boxes don't jump
  if (current === "active" && mState.offset <= 50 && $("#merge-scroll").scrollTop < 4 && $("#vault-scroll").scrollTop < 4) loadMerges(true);
  if (current === "squeeks" && loaded.has("squeeks")) loadNfts(false, nftState.page, { silent: true });
  if (current === "leaders") loadWallets(false, wState.page, { silent: true });
  if (current === "wallet" && walletAddr && location.hash === `#wallet/${walletAddr}`) loadWallet(walletAddr, { silent: true });
}
setInterval(refreshVisible, 20_000);
// coming back to a tab that sat in the background: catch up right away
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshVisible(); });