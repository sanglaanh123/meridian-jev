// Tiny, inspectable strategy policy: a back-off lookup table learned from
// backtest episodes. For each feature key (most specific first) it keeps the
// strategy with the best mean train return, or "skip" when nothing beats zero.
// Deliberately simple: few pools and correlated episodes make richer models overfit.

export const SKIP = "skip";
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const keyOf = (features, fields) => fields.map(f => `${f}=${features[f]}`).join("|") || "*";

/**
 * rows: [{ features: {...}, returns: { strategyId: pnlPct } }]
 * levels: feature-field lists, most specific first, e.g. [["trend","vol","category"], ["trend","vol"], ["trend"], []].
 */
export function learnPolicy(rows, { levels, minSamples = 10, minEdgePct = 0 }) {
  const strategies = Object.keys(rows[0]?.returns ?? {});
  const table = {};
  if (!strategies.length) return { levels, table, minSamples, minEdgePct };
  for (const fields of levels) {
    const groups = new Map();
    for (const row of rows) {
      const key = keyOf(row.features, fields);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const [key, group] of groups) {
      if (group.length < minSamples) continue;
      const scored = strategies.map(id => ({ id, mean: mean(group.map(r => r.returns[id])) })).sort((a, b) => b.mean - a.mean);
      const best = scored[0];
      table[key] = { pick: best.mean > minEdgePct ? best.id : SKIP, mean: best.mean, n: group.length, ranking: scored.slice(0, 3) };
    }
  }
  return { levels, table, minSamples, minEdgePct };
}

/** Most specific matching entry wins; no match at all means skip. */
export function choose(policy, features) {
  for (const fields of policy.levels) {
    const hit = policy.table[keyOf(features, fields)];
    if (hit) return hit.pick;
  }
  return SKIP;
}

/** Mean per-episode return of a chooser (skip = 0) on held-out rows. */
export function evaluate(rows, chooser) {
  if (!rows.length) return { mean: 0, n: 0, traded: 0, winRate: 0 };
  const picks = rows.map(r => { const id = chooser(r); return id === SKIP ? null : r.returns[id]; });
  const traded = picks.filter(p => p != null);
  return {
    mean: mean(picks.map(p => p ?? 0)), n: rows.length, traded: traded.length,
    winRate: traded.length ? traded.filter(p => p > 0).length / traded.length * 100 : 0,
    tradedMean: traded.length ? mean(traded) : 0,
  };
}
