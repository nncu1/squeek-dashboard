// Stand-in for api.squeekchain.com + media.squeekchain.com, shaped like the real responses.
import http from "node:http";

export function startMockApi(port) {
  const hits = { status: 0, status304: 0, stats: 0, stats304: 0 };
  const status = {
    schemaVersion: 1, measurement: { freshness: "online", observedAt: new Date().toISOString(), cumulativeWorkUnits: "55910", provenance: "hardware", coreStatus: "ACTIVE", rpmMilli: 73330, speedMmPerSecond: 1073, distanceMm: 5727194 },
    settlementQueue: { status: "available", state: "empty" },
  };
  const stats = {
    schemaVersion: 1, range: "7d",
    lifetime: { acceptedWorkUnits: "55910", observedDistanceMm: "52639612", activeDayCount: 5, settledBlockCount: "4949" },
    activity: { summary: { observedWorkUnits: "55910", medianWorkPerActiveDay: "10710" } },
    records: {
      mostWorkHalfHour: { value: "1706", occurredAt: "2026-10-13T23:30:00.000Z", coverage: "complete" },
      mostWorkUtcDay: { value: "14969", occurredAt: "2026-10-13T12:00:00.000Z", coverage: "complete" },
      maximumDailyDistanceMm: { value: "13142782", occurredAt: "2026-10-13T12:00:00.000Z", coverage: "complete" },
      peakObservedSpeedMmPerSecond: { value: "1526", occurredAt: "2026-10-14T22:44:45.996Z", coverage: "complete" },
      longestActiveWindowMinutes: { value: "250", occurredAt: "2026-10-13T22:00:00.000Z", coverage: "complete" },
      longestActiveDayStreak: { value: "5", occurredAt: "2026-10-12T12:00:00.000Z", coverage: "partial" },
    },
    rounds: { observedCount: 661, activeCount: 126, zeroWorkCount: 535, activeRateBps: 1906, medianActiveWork: "475" },
  };
  const E = 10n ** 18n;
  // shaped like /v1/economy/state of the 24 Oct 2026 release
  const economy = {
    schemaVersion: 2, status: "available",
    lifecycle: { stage: "active", startRound: "47", currentRound: "311", paused: false },
    supply: { capBaseUnits: String(2_100_000_000n * E), liveSupplyBaseUnits: String(5_603_205n * E), totalMintedBaseUnits: String(5_603_205n * E), paidBaseUnits: String(2_398_379n * E) },
    mining: { processedThroughRound: "308", totalNftPower: String(4_705_600n * E), totalSqkPower: String(1_237_382n * E) },
    staking: { totalStakedBaseUnits: String(1_523_841n * E) },
    nft: { issued: "9999", burned: "2094", live: "7905", maximumLevel: 10,
      cooldownBlocks: ["0", "3000", "7000", "14000", "21000", "28000", "35000", "42000", "49000", "0"],
      basePower: ["1000", "2200", "4840", "10648", "23426", "51536", "113380", "249436", "548759", "1207269"] },
  };
  const stream = { schemaVersion: 1, state: "idle", playback: { kind: "canonical-hls" }, observedAt: new Date().toISOString(), validUntil: null, errorCode: null };
  const days = Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10), earnedBaseUnits: String(BigInt(i * 1000) * 10n ** 18n) }));

  const send = (res, code, body, etag) => {
    res.writeHead(code, { "content-type": "application/json", ...(etag ? { etag } : {}) });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const inm = req.headers["if-none-match"];
    if (u.pathname === "/v1/status") {
      hits.status++;
      if (inm === 'W/"s1"') { hits.status304++; return send(res, 304, undefined, 'W/"s1"'); }
      return send(res, 200, status, 'W/"s1"');
    }
    if (u.pathname === "/v1/measurement/stats") {
      hits.stats++;
      if (inm === 'W/"m1"') { hits.stats304++; return send(res, 304, undefined, 'W/"m1"'); }
      return send(res, 200, stats, 'W/"m1"');
    }
    if (u.pathname === "/v1/economy/state") return send(res, 200, economy);
    if (u.pathname === "/live/current.json") return send(res, 200, stream);
    const acc = u.pathname.match(/^\/v1\/accounts\/(0x[0-9a-f]{40})$/);
    if (acc) return send(res, 200, { schemaVersion: 2, status: "available", account: acc[1], chain: { safeThroughBlock: "1" },
      claim: { claimableBaseUnits: String(12n * E) }, lifetime: { paidBaseUnits: "0", claimedToStakeBaseUnits: String(87_529n * E) },
      power: { nftPower: String(48_400n * E), sqkPower: String(108_099n * E), pending: [], pendingCount: "0" },
      stake: { principalBaseUnits: String(87_529n * E) }, earnings: days, tokens: [], tokenCounts: { staking: "22", wallet: "2" } });
    // /v1/core is left out on purpose: the indexer must read the core height from chain then
    if (u.pathname.startsWith("/v1/squeeks/")) return send(res, 200, { schemaVersion: 2, status: "unavailable", reason: "indexer_unavailable" });
    send(res, 404, { error: "not_found" });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, hits })));
}
