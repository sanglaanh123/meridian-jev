// Shared data for the research scripts: the token/pool universe, Jev text
// features (cached per mint and question set) and hourly history.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { listPools } from "../standalone/meteora.js";
import { fetchJson } from "../standalone/rpc.js";
import { tierFor } from "../standalone/screening.js";
import { jevAsk } from "../standalone/judgment.js";
import { cacheDir } from "./history.js";
import { erMetrics, classifyEr, atrSeries, zigzagSwingPct, structureSeries, atrZlemaTrend, adxSeries, resample } from "../standalone/indicators.js";

/** Verified tier tokens with a liquid SOL pool (largest TVL pool per mint). */
export async function buildUniverse({ maxPools = 30 } = {}) {
  const listed = await listPools({ filter: ["is_blacklisted=false", `token_y=${config.tokens.SOL}`, "tvl>=50000", "volume_24h>=25000"], sort: "tvl:desc", pageSize: 200 });
  const universe = [];
  const seen = new Set();
  for (const p of listed) {
    const mint = p.token_x?.address;
    const tier = tierFor(p.token_x?.market_cap);
    if (!mint || seen.has(mint) || !tier) continue;
    seen.add(mint);
    const assets = await fetchJson(`https://datapi.jup.ag/v1/assets/search?query=${mint}`).catch(() => []);
    const token = (Array.isArray(assets) ? assets : []).find(t => t.id === mint);
    if (token?.isVerified !== true) continue;
    universe.push({ mint, tier, token, pool: p, symbol: token.symbol });
    if (universe.length >= maxPools) break;
  }
  return universe;
}

/** Atomic text questions used to describe tokens (research + coin labels). */
export const JEV_QUESTIONS = {
  established: { type: "noul", instructions: "Is this token a widely recognised, established Solana project or asset?" },
  meme: { type: "noul", instructions: "Is this token primarily a meme or community joke coin?" },
  utility: { type: "noul", instructions: "Does this token belong to a product or protocol with real usage, such as an exchange, lending market or network?" },
  governance: { type: "noul", instructions: "Is this the governance token of a DeFi protocol?" },
  staking: { type: "noul", instructions: "Is this a liquid staking or yield-bearing token?" },
  wrapped: { type: "noul", instructions: "Is this a wrapped, bridged or tokenized real-world asset such as BTC, ETH or a stock?" },
  persona: { type: "noul", instructions: "Is the token tied to a celebrity, influencer or political figure?" },
  ai: { type: "noul", instructions: "Is this an AI or agent themed token?" },
};

/** Jev answers for a question set, one request per token, cached by question-set hash. */
export async function jevFeatures(universe, questions) {
  const hash = createHash("sha1").update(JSON.stringify(questions)).digest("hex").slice(0, 10);
  const file = path.join(cacheDir, `jev-${hash}.json`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  for (const u of universe) {
    if (cache[u.mint]) continue;
    const t = u.token;
    const state = { token: { name: t.name, symbol: t.symbol, verified: t.isVerified === true, tags: t.tags, website: t.website, twitter: t.twitter } };
    try { cache[u.mint] = await jevAsk(state, questions); }
    catch (e) { console.log(`  Jev failed for ${u.symbol}: ${e.message}`); }
  }
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  return cache;
}

/** Hourly feature arrays; 4h features come from 4h bars closed at or before each hour. */
export function hourlyIndicatorFeatures(candles) {
  const { bars, closeIndex } = resample(candles, 4);
  const st4 = structureSeries(bars, 3), zl4 = atrZlemaTrend(bars), zl1 = atrZlemaTrend(candles), adx1 = adxSeries(candles), atr1 = atrSeries(candles, 14);
  const f = [];
  let k = -1;
  for (let i = 0; i < candles.length; i++) {
    while (k + 1 < closeIndex.length && closeIndex[k + 1] <= i) k++;
    const er4 = k >= 5 ? erMetrics(bars, k, 6) : null;
    f.push({
      er1: erMetrics(candles, i, 24), er4, regime4: classifyEr(er4),
      struct4: k >= 0 ? st4[k].trend : 0, zl4: k >= 0 ? zl4[k] : null, zl1: zl1[i], adx1: adx1[i],
      atrPct1: atr1[i] == null ? null : atr1[i] / candles[i].close * 100,
      swingPct: zigzagSwingPct(candles, i, 72, 1),
    });
  }
  return f;
}

