// Jev (TypeSafe System One) as a bluechip classifier: is this an established,
// recognised project, is it impersonating one, and what kind of asset is it.
// Text only — numbers are never sent; deterministic screening has already passed.
// No network on import.
import { config } from '../config.js';
import { fetchJson } from './rpc.js';

const URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODES = ['off', 'shadow', 'veto', 'approve'];
export const CATEGORIES = {
  lst: 'a liquid staking token for SOL',
  major_defi: 'the governance or utility token of a major DeFi protocol',
  infrastructure: 'an infrastructure, oracle, wallet or network token',
  wrapped_asset: 'a wrapped or bridged asset such as BTC or ETH, or a tokenized stock',
  established_meme: 'a long-standing community meme coin with broad recognition',
  other: 'none of the other categories',
};
const cache = new Map();

const shuffle = list => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
export async function jevAsk(state, questions) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY is not set');
  const cfg = config.jev;
  const result = await fetchJson(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: cfg.model, state, questions }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!result?.answers || typeof result.answers !== 'object') throw new Error('Invalid Jev response');
  return result.answers;
}
// Pure: combines answers into approve | reject | uncertain. Jev never sees these rules.
export function decideEntry(answers, allowedCategories, cfg = config.jev) {
  const imp = answers?.impersonation?.noul;
  if (typeof imp === 'number' && imp >= cfg.riskMax) return { decision: 'reject', reason: `impersonation ${imp.toFixed(2)} >= ${cfg.riskMax}` };
  const cat = answers?.category;
  if (cat?.choice && !allowedCategories.includes(cat.choice) && (cat.confidence ?? 0) >= cfg.minConfidence) return { decision: 'reject', reason: `category ${cat.choice} not allowed for this tier` };
  if (typeof imp !== 'number') return { decision: 'uncertain', reason: 'impersonation answer missing' };
  const est = answers?.established?.noul;
  if (typeof est !== 'number') return { decision: 'uncertain', reason: 'established answer missing' };
  if (est < cfg.minEstablished) return { decision: 'uncertain', reason: `established ${est.toFixed(2)} < ${cfg.minEstablished}` };
  return { decision: 'approve', reason: `established ${est.toFixed(2)}, ${cat?.choice ?? 'uncategorised'}, impersonation ${imp.toFixed(2)}` };
}
// Returns null when Jev is off; throws on request errors (callers apply the mode's failure policy).
export async function judgeToken(token, allowedCategories) {
  const cfg = config.jev;
  if (!['shadow', 'veto', 'approve'].includes(cfg.mode)) return null;
  const hit = cache.get(token.id);
  if (hit && Date.now() - hit.at < cfg.cacheMin * 60_000) return { ...hit.answersOnly, ...decideEntry(hit.answersOnly.answers, allowedCategories, cfg) };
  const state = { token: { name: token.name, symbol: token.symbol, verified: token.isVerified === true, tags: token.tags, website: token.website, twitter: token.twitter } };
  const questions = {
    established: { type: 'noul', instructions: 'Is this token a widely recognised, established Solana project or asset?', criteria: { true: 'A well-known project or asset that experienced Solana users would recognise by name.', false: 'An obscure, new or unrecognised token.' } },
    impersonation: { type: 'noul', instructions: 'Does the token name or symbol imitate a different well-known token, project or brand?', criteria: { true: 'The name or symbol copies or counterfeits another well-known token, project or brand.', false: 'The name and symbol are the genuine identity of this token, or are original.' } },
    category: { type: 'choice', instructions: 'Which category best describes this token?', criteria: Object.fromEntries(shuffle(Object.keys(CATEGORIES)).map(k => [k, CATEGORIES[k]])) },
  };
  const answers = await jevAsk(state, questions);
  const flat = {
    established: { noul: answers.established?.noul },
    impersonation: { noul: answers.impersonation?.noul },
    category: { choice: answers.category?.choice, confidence: answers.category?.confidence },
  };
  const now = Date.now();
  for (const [mint, e] of cache) if (now - e.at >= cfg.cacheMin * 60_000) cache.delete(mint);
  // Cache answers, not the verdict: the verdict depends on the tier's allowed categories.
  cache.set(token.id, { at: now, answersOnly: { answers: flat } });
  return { answers: flat, ...decideEntry(flat, allowedCategories, cfg) };
}
