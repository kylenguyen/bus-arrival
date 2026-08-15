const num = (raw: string | undefined, fallback: number) => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: num(process.env.PORT, 8080),

  // Absent key => mock mode. The board stays fully usable so the thing can be
  // built, deployed and demoed before DataMall approves the account.
  accountKey: process.env.LTA_ACCOUNT_KEY?.trim() || null,
  baseUrl: process.env.LTA_BASE_URL ?? 'https://datamall2.mytransport.sg/ltaodataservice',

  // The guide gives Bus Arrival an update frequency of 20 s (§2.1; it was
  // tightened from 30 s in guide v6.2), so caching below that costs accuracy
  // nothing and keeps us well inside the account quota no matter how many
  // people load the page at once. Raise it towards 20_000 if spend needs it.
  arrivalTtlMs: num(process.env.ARRIVAL_TTL_MS, 15_000),

  // The stop list changes a few times a year. Reload daily.
  stopRefreshMs: num(process.env.STOP_REFRESH_MS, 24 * 60 * 60 * 1000),

  // Routes move on the same cadence as stops. Reload daily.
  routeRefreshMs: num(process.env.ROUTE_REFRESH_MS, 24 * 60 * 60 * 1000),

  upstreamTimeoutMs: num(process.env.UPSTREAM_TIMEOUT_MS, 8_000),
} as const;

export const mockMode = config.accountKey === null;
