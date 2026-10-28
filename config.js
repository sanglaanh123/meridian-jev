import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import { LABELS, loadCoinLabels } from "./standalone/labels.js";
import { INDICATOR_GATES, INDICATOR_EXITS } from "./standalone/indicators.js";

export { REPO_ROOT, repoPath };

const USER_CONFIG_PATH = repoPath("user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// Per-tier screening, sizing and exit overrides. Flat user-config keys
// (e.g. midcapMinTvl) keep the Telegram editor and user-config.json simple.
export const TIER_DEFAULTS = {
  bluechip: {
    minMcap: 500_000_000, maxMcap: null, requiredTags: ["strict", "verified"],
    minHolders: 10_000, minTokenAgeDays: 30, minOrganic: 60, maxTop10Pct: 70,
    minTvl: 200_000, minVolume24h: 100_000, minBinStep: 1, maxBinStep: 100,
    minFeeTvl24hPct: 0.03, maxDailyVolPct: 12,
    sizeMult: 1, maxPositions: 3, stopLossPct: -15, rangeVolMult: 2,
    allowedCategories: ["lst", "major_defi", "infrastructure", "wrapped_asset", "established_meme"],
  },
  midcap: {
    minMcap: 20_000_000, maxMcap: 500_000_000, requiredTags: ["verified"],
    minHolders: 5_000, minTokenAgeDays: 14, minOrganic: 70, maxTop10Pct: 50,
    minTvl: 75_000, minVolume24h: 50_000, minBinStep: 10, maxBinStep: 200,
    minFeeTvl24hPct: 0.1, maxDailyVolPct: 25,
    sizeMult: 0.5, maxPositions: 2, stopLossPct: -10, rangeVolMult: 2.5,
    allowedCategories: ["lst", "major_defi", "infrastructure", "wrapped_asset", "established_meme"],
  },
};
export const SHAPES = ["spot", "curve", "bid_ask"];
export const DEFAULT_REGIME_STRATEGIES = {
  "down/low": "bid_ask", "down/mid": "bid_ask", "down/high": "bid_ask",
  "range/low": "bid_ask", "range/mid": "bid_ask", "range/high": "skip",
  "up/low": "bid_ask", "up/mid": "skip", "up/high": "skip",
};
// Strategy per coin label (see standalone/labels.js). Calm groups farm a wide bid_ask
// ladder with a stop (scripts/tune.js on low-volatility coins); volatile groups follow
// the regime map; LSTs earn ~0 fees on SOL pairs, so skip them.
const CALM_ENTRY = { shape: "bid_ask", rangeVolMult: 4, stopLossPct: -10, outOfRangeWaitMinutes: 240 };
export const DEFAULT_LABEL_STRATEGIES = {
  lst: "skip", wrapped: CALM_ENTRY, defi_bluechip: CALM_ENTRY, calm: CALM_ENTRY, volatile: "regime", meme: "regime",
};
// Pool rule per label, chosen on the fit period by scripts/binstep-lab.js (60d): on the
// later test period each beat "highest fee/TVL" (fee24), except meme where it is fee24.
export const DEFAULT_LABEL_POOL_RULES = {
  lst: "tvl", wrapped: "tvl", defi_bluechip: "tvl", calm: "largest", volatile: "fit", meme: "fee24",
};
// Indicator gate/exit per label, picked by scripts/indicator-lab.js (60d, validate → test):
// calm groups: enter only in 4h ER chop with 4h structure not down, exit on a 1h ATR-ZLEMA
// down-flip (test −0.40 → −0.11 %/72h); volatile groups: enter only with 1h ADX < 20, exit
// on a 4h ZLEMA down-flip (test −0.66 → −0.08). Both still slightly negative.
const CALM_INDICATORS = { gate: "er4_chop_and_struct", exit: "zl1_down" };
const VOLATILE_INDICATORS = { gate: "adx1_low", exit: "zl4_down" };
export const DEFAULT_LABEL_INDICATORS = {
  lst: { gate: "none", exit: "none" }, wrapped: CALM_INDICATORS, defi_bluechip: CALM_INDICATORS, calm: CALM_INDICATORS,
  volatile: VOLATILE_INDICATORS, meme: VOLATILE_INDICATORS,
};
export const tierKey = (tier, field) => `${tier}${field[0].toUpperCase()}${field.slice(1)}`;
const tiers = Object.fromEntries(Object.entries(TIER_DEFAULTS).map(([tier, defaults]) => [
  tier,
  Object.fromEntries(Object.entries(defaults).map(([field, value]) => [field, u[tierKey(tier, field)] ?? value])),
]));

function normalizeManualPools(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    if (typeof item === "string") return { pool: item.trim() };
    if (item && typeof item === "object") {
      const entry = { pool: String(item.pool ?? "").trim() };
      if ("takeProfitPct" in item) entry.takeProfitPct = item.takeProfitPct;
      if ("stopLossPct" in item) entry.stopLossPct = item.stopLossPct;
      if ("shape" in item) entry.shape = item.shape;
      if ("rangeVolMult" in item) entry.rangeVolMult = item.rangeVolMult;
      if ("outOfRangeWaitMinutes" in item) entry.outOfRangeWaitMinutes = item.outOfRangeWaitMinutes;
      return entry;
    }
    return { pool: "" };
  });
}

const manualPoolsInvalid = u.manualPools != null && !Array.isArray(u.manualPools);

export const config = {
  // Bluechip + mid-cap DLMM farmer. Scanner entries are tier-screened. An optional
  // manualPools list keeps named pools open with the auto shape. Shadow mode never
  // submits transactions.
  standalone: {
    shadow: u.shadowMode !== false,
    rpcUrl: nonEmptyString(process.env.RPC_URL, u.rpcUrl),
    balanceRpcUrl: nonEmptyString(process.env.BALANCE_RPC_URL, u.balanceRpcUrl, process.env.RPC_URL),
    fallbackRpcUrl: nonEmptyString(process.env.FALLBACK_RPC_URL, u.fallbackRpcUrl),
    walletAddress: nonEmptyString(process.env.WALLET_ADDRESS, u.walletAddress),
    screeningDeadlineSec: u.screeningDeadlineSec ?? 120,
    retrySec: u.screeningRetrySec ?? 15,
    maxPriceMovePct: u.maxEntryPriceMovePct ?? 3,
    // A screened-out or entered mint is not re-signalled before this cooldown.
    cooldownSec: u.signalCooldownSec ?? 3600,
    // Simulated native SOL used for sizing and fund gates while DRY_RUN is on; null = real balance.
    dryRunSolBalance: u.dryRunSolBalance == null || numericConfig(u.dryRunSolBalance) < 0 ? null : numericConfig(u.dryRunSolBalance),
  },

  // ─── Meteora pool scanner (discovery entry trigger) ───
  scanner: {
    enabled:              u.scannerEnabled              ?? true,
    scanMin:              u.scanMin                     ?? 15,
    maxCandidatesPerScan: u.scanMaxCandidates           ?? 5,
    maxSignalsPerScan:    u.scanMaxSignals              ?? 1,
  },

  // ─── Manual pools (hold a named pool: auto shape, TP/SL, slow rebalance) ───
  manual: {
    pools: normalizeManualPools(u.manualPools),
    poolsInvalid: manualPoolsInvalid,
    checkMin: numericConfig(u.manualCheckMin) ?? 5,
    takeProfitPct: u.manualTakeProfitPct !== undefined ? u.manualTakeProfitPct : null,
    stopLossPct: u.manualStopLossPct ?? u.stopLossPct ?? u.emergencyPriceDropPct ?? -15,
    reentryMinutes: numericConfig(u.manualReentryMinutes) ?? 60,
    stopCooldownMinutes: numericConfig(u.manualStopCooldownMinutes) ?? 360,
  },

  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 4,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening (tiered: bluechip + midcap) ───
  screening: {
    enabledTiers:                u.enabledTiers                ?? ["bluechip", "midcap"],
    tiers,
    requireRenouncedAuthorities: u.requireRenouncedAuthorities ?? true,
    minPoolAgeHours:             u.minPoolAgeHours             ?? 24,
    feeStabilityMin:             u.feeStabilityMin             ?? 0.3,  // fee/TVL 4h×6 vs 24h band
    feeStabilityMax:             u.feeStabilityMax             ?? 3,
  },

  // ─── Jev (TypeSafe) bluechip classifier; key from TYPESAFE_API_KEY env only ───
  jev: {
    mode:           u.jevMode           ?? "off",   // off | shadow | veto | approve
    model:          u.jevModel          ?? "jev-latest",
    riskMax:        u.jevRiskMax        ?? 0.7,     // impersonation at/above this rejects
    minEstablished: u.jevMinEstablished ?? 0.7,     // "established project" needed to approve
    minConfidence:  u.jevMinConfidence  ?? 0.6,     // category confidence needed to reject on category
    timeoutMs:      u.jevTimeoutMs      ?? 8000,
    cacheMin:       u.jevCacheMin       ?? 30,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? true,  // compound claimed fees back into SOL
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 30,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 120,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -15, // fallback when the tier has none
    takeProfitPct:         u.takeProfitPct !== undefined ? u.takeProfitPct : null,  // null = off (long farming)
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 0.02,  // % per day, same scale as pool fee_tvl_ratio
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 360, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? false,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    // "auto" picks the shape per entry from the pool's regime (standalone/regime.js).
    strategy:     u.strategy     ?? "auto",
    // regime key "<trend>/<vol>" → spot | curve | bid_ask | skip. Defaults come from
    // `node scripts/strategy-lab.js` (60d, one-sided SOL): bid_ask lost least in every
    // regime; range/high, up/mid and up/high lost >1% per 72h even then, so skip them.
    regimeStrategies: { ...DEFAULT_REGIME_STRATEGIES, ...(u.regimeStrategies ?? {}) },
    regimeFallback: u.regimeFallbackStrategy ?? "bid_ask",  // when candles are too short to classify
    // Coin labels (coin-labels.json) pick a group strategy under "auto"; see pickShape.
    labelStrategies: { ...DEFAULT_LABEL_STRATEGIES, ...(u.labelStrategies ?? {}) },
    unlabeledStrategy: u.unlabeledStrategy ?? "regime",   // "skip" = trade labeled coins only
    // Which of a coin's SOL pools (bin steps) to farm, per label: fee24 | tvl | fit | largest | smallest.
    labelPoolRules: { ...DEFAULT_LABEL_POOL_RULES, ...(u.labelPoolRules ?? {}) },
    unlabeledPoolRule: u.unlabeledPoolRule ?? "fee24",
    // Indicator entry gate / exit per label ({ gate, exit } names in standalone/indicators.js).
    labelIndicators: Object.fromEntries(Object.entries(DEFAULT_LABEL_INDICATORS).map(([label, d]) => [label, { ...d, ...(u.labelIndicators?.[label] ?? {}) }])),
    unlabeledIndicators: { gate: "none", exit: "none", ...(u.unlabeledIndicators ?? {}) },
    coinLabels: loadCoinLabels(),
    // up/down needs |72h move| > trendPct with the 24h move agreeing; vol buckets by daily realized vol %.
    regimeThresholds: {
      trendPct: u.regimeTrendPct ?? 5,
      lowVol:   u.regimeLowVolPct ?? 5,
      highVol:  u.regimeHighVolPct ?? 12,
    },
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── PnL fetcher / poller (public infra: Meteora APIs) ──
  pnl: {
    // Position discovery, value, fees, and PnL come from the Meteora portfolio
    // + /pnl APIs — no per-tick on-chain reads, so the poller stays cheap.
    // "rpc" keeps the on-chain engine (DLMM SDK + Jupiter) available as an
    // explicit opt-in.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, process.env.RPC_URL, "https://api.mainnet-beta.solana.com"),
    source: nonEmptyString(u.pnlSource, process.env.PNL_SOURCE, "meteora"), // meteora | rpc
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

};

/** Startup validation for values whose typos would otherwise silently disable a gate. */
export function validateConfig() {
  const problems = [];
  if (!["off", "shadow", "veto", "approve"].includes(config.jev.mode)) problems.push(`jevMode "${config.jev.mode}" — use off, shadow, veto or approve`);
  if (!Array.isArray(config.screening.enabledTiers) || !config.screening.enabledTiers.length) problems.push("enabledTiers must list at least one tier");
  if (![...SHAPES, "auto"].includes(config.strategy.strategy)) problems.push(`strategy "${config.strategy.strategy}" — use auto, ${SHAPES.join(", ")}`);
  if (!SHAPES.includes(config.strategy.regimeFallback)) problems.push(`regimeFallbackStrategy "${config.strategy.regimeFallback}" — use ${SHAPES.join(", ")}`);
  const checkEntry = (where, entry) => {
    if (entry === "regime") return;
    if (entry && typeof entry === "object" && entry.regimes) { for (const [k, e] of Object.entries(entry.regimes)) checkEntry(`${where}.regimes["${k}"]`, e); return; }
    const shape = typeof entry === "string" ? entry : entry?.shape;
    if (![...SHAPES, "skip"].includes(shape) || (typeof entry !== "string" && shape === "skip")) problems.push(`${where} shape "${shape}" — use ${SHAPES.join(", ")}, "skip" or "regime"`);
  };
  for (const [label, entry] of Object.entries(config.strategy.labelStrategies)) {
    if (!LABELS[label]) problems.push(`labelStrategies has unknown label "${label}" — use ${Object.keys(LABELS).join(", ")}`);
    checkEntry(`labelStrategies["${label}"]`, entry);
  }
  checkEntry("unlabeledStrategy", config.strategy.unlabeledStrategy);
  for (const [label, ind] of [...Object.entries(config.strategy.labelIndicators), ["(unlabeled)", config.strategy.unlabeledIndicators]]) {
    if (label !== "(unlabeled)" && !LABELS[label]) problems.push(`labelIndicators has unknown label "${label}"`);
    if (!INDICATOR_GATES[ind.gate]) problems.push(`labelIndicators["${label}"].gate "${ind.gate}" — use ${Object.keys(INDICATOR_GATES).join(", ")}`);
    if (!INDICATOR_EXITS[ind.exit]) problems.push(`labelIndicators["${label}"].exit "${ind.exit}" — use ${Object.keys(INDICATOR_EXITS).join(", ")}`);
  }
  const POOL_RULES = ["fee24", "tvl", "fit", "largest", "smallest"];
  for (const [label, rule] of Object.entries(config.strategy.labelPoolRules)) {
    if (!LABELS[label]) problems.push(`labelPoolRules has unknown label "${label}"`);
    if (!POOL_RULES.includes(rule)) problems.push(`labelPoolRules["${label}"] = "${rule}" — use ${POOL_RULES.join(", ")}`);
  }
  if (!POOL_RULES.includes(config.strategy.unlabeledPoolRule)) problems.push(`unlabeledPoolRule "${config.strategy.unlabeledPoolRule}" — use ${POOL_RULES.join(", ")}`);
  for (const [mint, c] of Object.entries(config.strategy.coinLabels)) {
    if (c?.label != null && !LABELS[c.label]) problems.push(`coin-labels.json ${c.symbol ?? mint}: unknown label "${c.label}"`);
  }
  for (const [key, entry] of Object.entries(config.strategy.regimeStrategies)) {
    const shape = typeof entry === "string" ? entry : entry?.shape;
    if (![...SHAPES, "skip"].includes(shape) || (typeof entry !== "string" && shape === "skip")) problems.push(`regimeStrategies["${key}"] shape "${shape}" — use ${SHAPES.join(", ")} or "skip"`);
    if (entry && typeof entry === "object") {
      if (entry.rangeVolMult !== undefined && !(entry.rangeVolMult > 0)) problems.push(`regimeStrategies["${key}"].rangeVolMult must be > 0`);
      if (entry.stopLossPct != null && !(entry.stopLossPct < 0)) problems.push(`regimeStrategies["${key}"].stopLossPct must be negative or null`);
      if (entry.outOfRangeWaitMinutes !== undefined && !(entry.outOfRangeWaitMinutes >= 0)) problems.push(`regimeStrategies["${key}"].outOfRangeWaitMinutes must be ≥ 0`);
    }
  }
  const th = config.strategy.regimeThresholds;
  if (!(th.trendPct > 0) || !(th.lowVol > 0) || !(th.highVol > th.lowVol)) problems.push("regime thresholds need trendPct > 0 and 0 < lowVol < highVol");
  for (const tier of config.screening.enabledTiers ?? []) {
    if (!config.screening.tiers[tier]) problems.push(`unknown tier "${tier}" in enabledTiers — use ${Object.keys(config.screening.tiers).join(", ")}`);
  }
  if (config.manual.poolsInvalid) problems.push("manualPools must be an array");
  if (!(config.manual.checkMin >= 1)) problems.push("manualCheckMin must be ≥ 1");
  if (config.manual.takeProfitPct != null && !(config.manual.takeProfitPct > 0)) problems.push("manualTakeProfitPct must be positive or null");
  if (!(config.manual.stopLossPct < 0)) problems.push("manualStopLossPct must be negative");
  if (!(config.manual.reentryMinutes >= 0)) problems.push("manualReentryMinutes must be ≥ 0");
  if (!(config.manual.stopCooldownMinutes >= 0)) problems.push("manualStopCooldownMinutes must be ≥ 0");
  const seenPools = new Set();
  config.manual.pools.forEach((entry, i) => {
    const pool = entry.pool;
    if (!pool) { problems.push(`manualPools[${i}] pool is empty`); return; }
    const key = pool.toLowerCase();
    if (seenPools.has(key)) problems.push(`manualPools duplicates "${pool}"`);
    seenPools.add(key);
    if ("takeProfitPct" in entry && entry.takeProfitPct != null && !(entry.takeProfitPct > 0)) problems.push(`manualPools[${i}].takeProfitPct must be positive or omitted`);
    if ("stopLossPct" in entry && !(entry.stopLossPct < 0)) problems.push(`manualPools[${i}].stopLossPct must be negative`);
    if ("shape" in entry && !SHAPES.includes(entry.shape)) problems.push(`manualPools[${i}].shape "${entry.shape}" — use ${SHAPES.join(", ")}`);
    if ("rangeVolMult" in entry && !(entry.rangeVolMult > 0)) problems.push(`manualPools[${i}].rangeVolMult must be > 0`);
    if ("outOfRangeWaitMinutes" in entry && !(entry.outOfRangeWaitMinutes >= 0)) problems.push(`manualPools[${i}].outOfRangeWaitMinutes must be ≥ 0`);
  });
  return problems;
}

// Shadow applies to every existing transaction path, including CLI commands.
if (config.standalone.shadow) process.env.DRY_RUN = "true";

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}
