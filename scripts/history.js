// Cached Meteora hourly history for research scripts (.backtest-cache/, git-ignored).
import fs from "node:fs";
import path from "node:path";
import { repoPath } from "../repo-root.js";
import { hourlyHistory } from "../standalone/meteora.js";

export const cacheDir = repoPath(".backtest-cache");

/** Hourly candles plus LP fees (fees minus protocol fees) aligned to the candles. */
export async function loadHistory(address, { days, endSec, refresh = false }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const startSec = endSec - (days + 1) * 86_400; // +1 day warmup for rolling gates
  const stamp = new Date(endSec * 1000).toISOString().slice(0, 13);
  const cached = async (kind, load) => {
    const file = path.join(cacheDir, `${address}-${kind}-${days}d-${stamp}.json`);
    if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    const data = await load();
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  };
  const [raw, volume] = await Promise.all([
    cached("ohlcv", () => hourlyHistory(address, "ohlcv", startSec, endSec)),
    cached("fees", () => hourlyHistory(address, "volume/history", startSec, endSec)),
  ]);
  const feeAt = new Map(volume.map(v => [v.timestamp, Math.max(0, (v.fees ?? 0) - (v.protocol_fees ?? 0))]));
  const candles = raw.filter(c => c.close > 0);
  return { candles, lpFees: candles.map(c => feeAt.get(c.timestamp) ?? 0) };
}

export const hourNowSec = () => Math.floor(Date.now() / 3_600_000) * 3600;
