// Per-coin labels (coin-labels.json, user-editable, git-ignored) that pick the
// auto strategy for a token. Generate or refresh suggestions with
// `node scripts/label-coins.js --write`; your own "label" values are kept.
import fs from 'node:fs';
import { repoPath } from '../repo-root.js';

export const LABELS = {
  lst: 'SOL liquid staking token — pegged to SOL, near-zero volatility',
  wrapped: 'wrapped/bridged major or tokenized stock (BTC, ETH, NVDA…)',
  defi_bluechip: 'established DeFi/infrastructure token with modest volatility',
  calm: 'other token with low daily volatility',
  volatile: 'token with medium/high daily volatility',
  meme: 'meme/community token or very high volatility',
};
export const COIN_LABELS_PATH = repoPath('coin-labels.json');

/** { mint: { symbol, label, suggested, ... } } — missing or unreadable file means no labels. */
export function loadCoinLabels(file = COIN_LABELS_PATH) {
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (e) {
    throw new Error(`coin-labels.json is unreadable: ${e.message}`);
  }
}
