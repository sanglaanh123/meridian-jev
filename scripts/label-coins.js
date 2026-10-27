#!/usr/bin/env node
// List scanner-universe coins with the facts that matter for strategy choice
// (volatility, trend, fees, bin step, Jev text answers) and a suggested label.
//
//   node scripts/label-coins.js [--max-pools 40] [--days 60] [--write]
//
// --write merges into coin-labels.json: stats and "suggested" are refreshed,
// a "label" you set by hand is never overwritten. Read-only otherwise.
import "../envcrypt.js";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { LABELS, COIN_LABELS_PATH, loadCoinLabels } from "../standalone/labels.js";
import { realizedVolatility } from "../standalone/meteora.js";
import { buildUniverse, jevFeatures, JEV_QUESTIONS } from "./lab-data.js";
import { loadHistory, hourNowSec } from "./history.js";

const { values: flags } = parseArgs({
  options: {
    "max-pools": { type: "string", default: "40" },
    days: { type: "string", default: "60" },
    write: { type: "boolean", default: false },
    refresh: { type: "boolean", default: false },
  },
});
const quantile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) * p)] : null; };

/** Rule-based suggestion; Jev answers are hints, measured volatility decides. */
export function suggestLabel({ volMedian, jev }) {
  const yes = q => (jev?.[q]?.noul ?? 0) >= 0.5;
  if (yes("staking") || volMedian < 0.5) return "lst";
  if (yes("wrapped") && volMedian < 6) return "wrapped";
  if ((jev?.established?.noul ?? 0) >= 0.7 && (yes("governance") || yes("utility")) && volMedian < 6) return "defi_bluechip";
  if (yes("meme") || volMedian >= 12) return "meme";
  if (volMedian < 5) return "calm";
  return "volatile";
}

const universe = await buildUniverse({ maxPools: Number(flags["max-pools"]) });
const jev = process.env.TYPESAFE_API_KEY ? await jevFeatures(universe, JEV_QUESTIONS) : {};
const endSec = hourNowSec();
const rows = [];
for (const u of universe) {
  const { candles, lpFees } = await loadHistory(u.pool.address, { days: Number(flags.days), endSec, refresh: flags.refresh });
  const vols = [];
  for (let i = 24; i < candles.length; i += 6) { const v = realizedVolatility(candles.slice(i - 24, i + 1)); if (v != null) vols.push(v); }
  const last = candles.length - 1;
  const fee24 = lpFees.slice(-24).reduce((a, b) => a + b, 0) / u.pool.tvl * 100;
  const row = {
    mint: u.mint, symbol: u.symbol, tier: u.tier,
    mcapM: Math.round(u.pool.token_x.market_cap / 1e6), pool: u.pool.address, binStep: u.pool.pool_config.bin_step,
    volMedian: quantile(vols, 0.5) ?? NaN, volP90: quantile(vols, 0.9) ?? NaN,
    trend30Pct: last >= 720 ? (candles[last].close / candles[last - 720].close - 1) * 100 : null,
    feeTvl24hPct: fee24,
    jevYes: Object.keys(JEV_QUESTIONS).filter(q => (jev[u.mint]?.[q]?.noul ?? 0) >= 0.5),
    established: jev[u.mint]?.established?.noul ?? null,
  };
  row.suggested = suggestLabel({ volMedian: row.volMedian, jev: jev[u.mint] });
  rows.push(row);
}

const existing = loadCoinLabels();
console.log(`${"symbol".padEnd(9)}${"tier".padEnd(9)}${"mcap".padStart(7)}${"bin".padStart(5)}${"vol/d med".padStart(10)}${"p90".padStart(6)}${"30d".padStart(7)}${"fee/TVL".padStart(8)}  ${"Jev yes".padEnd(28)}${"suggested".padEnd(14)}label`);
for (const r of rows.sort((a, b) => a.volMedian - b.volMedian)) {
  const own = existing[r.mint]?.label;
  console.log(`${r.symbol.padEnd(9)}${r.tier.padEnd(9)}${(r.mcapM + "M").padStart(7)}${String(r.binStep).padStart(5)}${(r.volMedian.toFixed(1) + "%").padStart(10)}${(r.volP90.toFixed(1) + "%").padStart(6)}${(r.trend30Pct == null ? "–" : r.trend30Pct.toFixed(0) + "%").padStart(7)}${(r.feeTvl24hPct.toFixed(2) + "%").padStart(8)}  ${(r.jevYes.join("+") || "-").padEnd(28)}${r.suggested.padEnd(14)}${own ?? "(unset)"}`);
}
console.log(`\nLabels: ${Object.entries(LABELS).map(([k, v]) => `${k} = ${v}`).join("\n        ")}`);

if (flags.write) {
  const next = { ...existing };
  for (const r of rows) {
    const { mint, ...stats } = r;
    next[mint] = {
      ...stats,
      volMedian: Number(r.volMedian.toFixed(2)), volP90: Number(r.volP90.toFixed(2)),
      trend30Pct: r.trend30Pct == null ? null : Number(r.trend30Pct.toFixed(1)), feeTvl24hPct: Number(r.feeTvl24hPct.toFixed(3)),
      label: existing[mint]?.label ?? r.suggested, // a hand-set label always wins
      updatedAt: new Date().toISOString(),
    };
  }
  fs.writeFileSync(COIN_LABELS_PATH, JSON.stringify(next, null, 2) + "\n");
  console.log(`\nWrote ${Object.keys(next).length} coins to coin-labels.json (hand-set labels kept). Edit "label" to change a coin's strategy group.`);
}
