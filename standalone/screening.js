// Tiered bluechip / mid-cap screening. Token facts come from Jupiter, pool facts
// and candles from Meteora. Missing data never passes a rule.
import { PublicKey } from '@solana/web3.js';
import { config } from '../config.js';
import { isBlacklisted } from '../token-blacklist.js';
import { isDevBlocked, getBlockedDevs } from '../dev-blocklist.js';
import { isBaseMintOnCooldown, isPoolOnCooldown } from '../pool-memory.js';
import { fetchJson, readRpc } from './rpc.js';
import { TOKEN_PROGRAMS } from './balances.js';
import { poolsForMint, poolWithVolatility } from './meteora.js';
import { judgeToken } from './judgment.js';
import { pickShape } from './regime.js';
import { INDICATOR_GATES } from './indicators.js';
import { poolIndicators } from './meteora.js';
import { log } from '../logger.js';

const number = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

/** Highest enabled tier whose market-cap band contains `mcap`, or null. */
export function tierFor(mcap, s = config.screening) {
  const m = number(mcap);
  if (m == null) return null;
  return s.enabledTiers
    .filter(name => s.tiers[name])
    .sort((a, b) => s.tiers[b].minMcap - s.tiers[a].minMcap)
    .find(name => m >= s.tiers[name].minMcap && (s.tiers[name].maxMcap == null || m < s.tiers[name].maxMcap)) ?? null;
}

/** Positions already open in `tier` versus that tier's cap. Pure; used before deploy. */
export function tierLimits(openByTier, tier, s = config.screening) {
  const max = s.tiers[tier]?.maxPositions ?? 0;
  const open = openByTier[tier] ?? 0;
  return { open, max, full: open >= max };
}

const RETRYABLE_TOKEN_REJECTS = new Set(['Token mint mismatch', 'Token data is stale or has no timestamp']);

export function rejectToken(token, mint, t, s = config.screening, now = Date.now()) {
  if (token?.id !== mint) return 'Token mint mismatch';
  const updated = Date.parse(token.updatedAt);
  if (!Number.isFinite(updated) || now - updated > 90_000 || updated > now + 5000) return 'Token data is stale or has no timestamp';
  if (token.isVerified !== true) return 'Token is not Jupiter-verified';
  if (!Array.isArray(token.tags) || !t.requiredTags.some(tag => token.tags.includes(tag))) return `Token lacks a required tag (${t.requiredTags.join('/')})`;
  const mcap = number(token.mcap);
  if (mcap == null || mcap < t.minMcap || (t.maxMcap != null && mcap >= t.maxMcap)) return 'Market cap outside tier band or unknown';
  if (number(token.holderCount) == null || token.holderCount < t.minHolders) return 'Insufficient holders';
  if (number(token.organicScore) == null || token.organicScore < t.minOrganic) return 'Organic activity below threshold';
  const ageDays = (now - Date.parse(token.createdAt)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < t.minTokenAgeDays) return 'Token too young or age unknown';
  const audit = token.audit;
  const top = number(audit?.topHoldersPercentage);
  if (top == null || top < 0 || top > t.maxTop10Pct) return `topHoldersPercentage failed (${top == null ? 'unknown' : top.toFixed(1)})`;
  if (s.requireRenouncedAuthorities && (audit?.mintAuthorityDisabled !== true || audit?.freezeAuthorityDisabled !== true)) return 'Mint/freeze authority is enabled or unknown';
  return null;
}

/**
 * Pool rules for one tier. `daily_vol_pct` (from candles) is checked unless
 * `volatility: false` — the scanner pre-filters list results without candles.
 */
export function rejectPool(p, mint, t, s = config.screening, { volatility = true, now = Date.now() } = {}) {
  if (p?.token_x?.address !== mint || p?.token_y?.address !== config.tokens.SOL) return 'Requires an exact-mint token/SOL DLMM pool';
  if (p.is_blacklisted !== false) return 'Pool blacklist status unsafe or unknown';
  for (const [label, raw, min, max] of [
    ['TVL', p.tvl, t.minTvl, null],
    ['24h volume', p.volume?.['24h'], t.minVolume24h, null],
    ['bin step', p.pool_config?.bin_step, t.minBinStep, t.maxBinStep],
    ['24h fee/TVL', p.fee_tvl_ratio?.['24h'], t.minFeeTvl24hPct, null],
  ]) {
    const n = number(raw);
    if (n == null || n < min || (max != null && n > max)) return `${label} outside tier limits or unknown`;
  }
  const ageHours = (now - number(p.created_at)) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours < s.minPoolAgeHours) return 'Pool too new for stable fee history';
  // Fees must be steady, not a single spike: the 4h rate scaled to a day vs the 24h rate.
  const r4 = number(p.fee_tvl_ratio?.['4h']), r24 = number(p.fee_tvl_ratio?.['24h']);
  const stability = r4 == null || !(r24 > 0) ? null : (r4 * 6) / r24;
  if (stability == null || stability < s.feeStabilityMin || stability > s.feeStabilityMax) return `Fee stability ${stability?.toFixed(2) ?? 'unknown'} outside ${s.feeStabilityMin}-${s.feeStabilityMax}`;
  if (!(number(p.current_price) > 0)) return 'Pool price unavailable';
  if (volatility) {
    const vol = number(p.daily_vol_pct);
    if (vol == null || vol <= 0) return 'Volatility unavailable';
    if (vol > t.maxDailyVolPct) return `Daily volatility ${vol.toFixed(1)}% above ${t.maxDailyVolPct}%`;
  }
  return null;
}

export async function checkMintOnChain(mint, requireRenounced = config.screening.requireRenouncedAuthorities) {
  const result = await readRpc('main', c => c.getParsedAccountInfo(new PublicKey(mint), 'confirmed'));
  const account = result.value;
  const info = account?.data?.parsed?.info;
  if (!account || !TOKEN_PROGRAMS.includes(account.owner.toString()) || !info) throw new Error('On-chain mint read failed');
  if (requireRenounced && (info.mintAuthority !== null || info.freezeAuthority !== null)) throw new Error('On-chain mint authority check failed');
  const allowed = new Set(['metadataPointer', 'tokenMetadata']);
  if (account.owner.toString() === TOKEN_PROGRAMS[1] && !Array.isArray(info.extensions)) throw new Error('Token-2022 extensions unavailable');
  for (const extension of info.extensions || []) if (!allowed.has(extension.extension)) throw new Error(`Unsupported Token-2022 extension: ${extension.extension}`);
}

export async function screenMint(mint, { poolAddress = null } = {}) {
  const s = config.screening;
  if (isBlacklisted(mint) || isBaseMintOnCooldown(mint)) return { pass: false, terminal: true, reason: 'Token is blocked or on cooldown' };
  const assets = await fetchJson(`https://datapi.jup.ag/v1/assets/search?query=${mint}`);
  const token = (Array.isArray(assets) ? assets : []).find(t => t.id === mint);
  const tier = tierFor(token?.mcap, s);
  if (token && !tier) return { pass: false, terminal: true, reason: 'Market cap below the midcap floor or tier disabled' };
  const t = s.tiers[tier];
  const reason = rejectToken(token, mint, t ?? {}, s);
  // A fresh token record that fails a rule is a fact for this window; only a missing
  // or stale record is worth retrying. Terminal rejects park the mint in the scanner.
  if (reason) return { pass: false, terminal: !RETRYABLE_TOKEN_REJECTS.has(reason), reason, tier };
  if (token.dev ? isDevBlocked(token.dev) : Object.keys(getBlockedDevs()).length > 0) return { pass: false, terminal: true, reason: 'Deployer blocked or unavailable' };
  try {
    await checkMintOnChain(mint);
  } catch (e) {
    // Authority and Token-2022 extension failures are facts about the mint, not outages.
    if (/authority|extension/i.test(e.message)) return { pass: false, terminal: true, reason: e.message, tier };
    throw e;
  }
  const addresses = poolAddress ? [poolAddress] : (await poolsForMint(mint)).map(p => p.address).slice(0, 6);
  const candidates = [], rejected = [];
  let readFailed = false;
  for (const address of addresses) {
    if (isPoolOnCooldown(address)) { rejected.push('Pool cooldown'); continue; }
    try {
      const p = await poolWithVolatility(address);
      const why = rejectPool(p, mint, t, s);
      if (why) { rejected.push(why); continue; }
      candidates.push(p);
    } catch (e) { rejected.push(e.message); readFailed = true; }
  }
  // Every pool failing the rules is terminal; a failed pool read is retried.
  if (!candidates.length) return { pass: false, terminal: !readFailed, reason: rejected.slice(0, 3).join('; ') || 'No eligible token/SOL pool', tier };
  // Shape follows each pool's regime under strategy "auto"; the label's pool rule picks the pool.
  const label = config.strategy.coinLabels[mint]?.label ?? null;
  const chosen = choosePool(candidates, { label, tier: t });
  if (!chosen.pool) return { pass: false, terminal: true, reason: chosen.reason, tier, label };
  const { pool, pick, rule } = chosen;
  // Indicator entry gate for the label (missing candles never pass).
  const gate = indicatorsFor(label).gate;
  let indicators = null;
  if (gate !== 'none') {
    try { indicators = summarizeIndicators(await poolIndicators(pool.address)); }
    catch (e) { return { pass: false, reason: `indicator data unavailable (${e.message})`, tier, label }; }
    if (!INDICATOR_GATES[gate](indicators.raw)) return { pass: false, terminal: true, reason: `indicator gate ${gate} closed (${indicators.text})`, tier, label };
  }
  // Jev runs only after the deterministic rules pass. shadow: record only; veto: reject is
  // terminal, errors fail open; approve: only an approve verdict proceeds, errors fail closed.
  const jevMode = config.jev.mode;
  let jev = null;
  if (['shadow', 'veto', 'approve'].includes(jevMode)) {
    try {
      jev = await judgeToken(token, t.allowedCategories);
      log('screen_jev', `${mint.slice(0, 8)} ${token.symbol ?? '?'} [${tier}]: ${jev.decision} (${jev.reason}) ${JSON.stringify(jev.answers)}`);
    } catch (e) {
      log('screen_jev', `${mint.slice(0, 8)} Jev error: ${e.message}`);
      if (jevMode === 'approve') return { pass: false, reason: 'jev unavailable', tier, label };
    }
    if (jev && jevMode !== 'shadow') {
      if (jev.decision === 'reject') return { pass: false, terminal: true, reason: `Jev reject: ${jev.reason}`, tier, label, jev };
      if (jevMode === 'approve' && jev.decision !== 'approve') return { pass: false, terminal: true, reason: `Jev ${jev.decision}: ${jev.reason}`, tier, label, jev };
    }
  }
  return { pass: true, pool, token, tier, label, jev, shape: pick.shape, shapeReason: `${pick.why}; pool by ${rule}, bin step ${pool.pool_config.bin_step}${gate !== 'none' ? `; gate ${gate} open (${indicators.text})` : ''}`, overrides: pick.overrides, indicators: indicators?.text ?? null, fetchedAt: Date.now() };
}

export const indicatorsFor = (label, strategy = config.strategy) => (label ? strategy.labelIndicators?.[label] : null) ?? strategy.unlabeledIndicators ?? { gate: 'none', exit: 'none' };

/** Compact, loggable view of an indicator snapshot (raw kept for the predicates). */
export function summarizeIndicators(raw) {
  const n = (x, d = 2) => (x == null ? '?' : x.toFixed(d));
  return { raw, text: `ER4h ${n(raw.er4?.er)} ${raw.regime4 ?? '?'} · struct4h ${raw.struct4 === 1 ? 'up' : raw.struct4 === -1 ? 'down' : 'none'} · ZLEMA 4h/1h ${raw.zl4 ?? '?'}/${raw.zl1 ?? '?'} · ADX1h ${n(raw.adx1, 0)}` };
}

/** Bin step whose minimum ladder (minBinsBelow) spans exactly `rangePct` downward. */
export const fittedBinStep = (rangePct, bins = config.strategy.minBinsBelow) => (Math.exp(-Math.log(1 - Math.min(95, rangePct) / 100) / bins) - 1) * 10_000;

export const POOL_RULES = ['fee24', 'tvl', 'fit', 'largest', 'smallest'];
const POOL_ORDER = {
  fee24: (a, b) => b.fee_tvl_ratio['24h'] - a.fee_tvl_ratio['24h'],
  tvl: (a, b) => b.tvl - a.tvl,
  fit: (a, b) => Math.abs(Math.log(a.pool_config.bin_step / a.fitStep)) - Math.abs(Math.log(b.pool_config.bin_step / b.fitStep)),
  largest: (a, b) => b.pool_config.bin_step - a.pool_config.bin_step,
  smallest: (a, b) => a.pool_config.bin_step - b.pool_config.bin_step,
};

/**
 * Pick the pool to farm among screened candidates. Each candidate gets its
 * regime/label shape; "skip" candidates drop out. The coin label's rule
 * (labelPoolRules, default fee24) orders the rest; ties go to TVL.
 */
export function choosePool(candidates, { label = null, tier, strategy = config.strategy }) {
  const rule = (label ? strategy.labelPoolRules?.[label] : strategy.unlabeledPoolRule) ?? 'fee24';
  const live = [];
  let skipped = null;
  for (const p of candidates) {
    const pick = pickShape(p.regime, strategy, label);
    if (pick.shape === 'skip') { skipped = pick.why; continue; }
    const rangeVolMult = pick.overrides.rangeVolMult ?? tier.rangeVolMult;
    live.push({ ...p, pick, fitStep: Math.max(1, fittedBinStep(rangeVolMult * p.daily_vol_pct)) });
  }
  if (!live.length) return { pool: null, reason: `${skipped ?? 'no pool'} is configured to skip` };
  live.sort((a, b) => POOL_ORDER[rule](a, b) || b.tvl - a.tvl || a.address.localeCompare(b.address));
  const { pick, fitStep, ...pool } = live[0];
  return { pool, pick, rule };
}
