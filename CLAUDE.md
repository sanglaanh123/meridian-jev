# Meridian engineering guide

The app is a bluechip and mid-cap Meteora DLMM farmer (token-X / SOL pools). Entries come only from the deterministic Meteora pool scanner; the smart-wallet convergence trigger was removed. Data APIs are Jupiter and Meteora only, plus the Solana RPC for signing and balances. There is no legacy mode. The earlier LLM implementation is preserved on the local `legacy` branch at `fd835b7`.

## Entry points and modules

- `index.js`: daemon startup; exports a deterministic management pass.
- `cli.js`: explicit read commands and manual close/claim/swap; `start` launches the daemon. `scan` and `screen --mint` are read-only.
- `setup.js`: standalone configuration wizard; enables shadow mode.
- `standalone/runtime.js`: signal pursuit, screening deadlines, entry execution with tier sizing and caps, deterministic management, fast exit polling, heartbeat, process lock.
- `standalone/scanner.js`: Meteora pool scan, tier pre-filter, tier interleaving, signal emission. No network on import.
- `standalone/meteora.js`: the only client for `dlmm.datapi.meteora.ag` (pools, pool, OHLCV, hourly history) and realized volatility.
- `standalone/regime.js`: trend/volatility regime from candles and the `auto` shape choice (coin label → `labelStrategies`, else `regimeStrategies`); shared with the research scripts.
- `standalone/indicators.js`: pure trend/range indicators ported from the user's MTA-HedgeB (efficiency ratio) and M-EMA-Bot (ER regime, SMC BOS/CHoCH structure, ATR ZLEMA) plus ADX/ATR; `INDICATOR_GATES` / `INDICATOR_EXITS` are shared by screening (entry gate), `manageOnce` (exit, slow pass only) and `scripts/indicator-lab.js`. Per-label choice: `labelIndicators`.
- `standalone/labels.js`: coin label set and loader for `coin-labels.json` (user-editable, git-ignored); `scripts/label-coins.js` lists coins and suggests labels.
- `scripts/backtest.js`, `scripts/strategy-lab.js`, `scripts/tune.js`, `scripts/binstep-lab.js`, `scripts/label-coins.js` (+ `backtest-sim.js`, `policy.js`, `history.js`, `lab-data.js`): read-only research on Meteora history; cache in `.backtest-cache/`.
- `db.js`: the SQLite store (`node:sqlite`, `meridian.db`, override `MERIDIAN_DB`): connection, schema migrations, document-row mapping, read-only queries, and the one-time import of legacy JSON state files. Nothing opens on import.
- `standalone/store.js`: persisted signals, cooldowns, and recovery attempts (`signals`/`attempts` tables; `data` is the in-memory working copy, `save()` rewrites both atomically).
- `standalone/screening.js`: tier selection plus Jupiter token rules, Meteora pool rules, on-chain mint checks, and `choosePool` (the coin label's `labelPoolRules`: fee24 | tvl | fit | largest | smallest picks which of the mint's pools / bin steps to farm).
- `standalone/judgment.js`: optional Jev (TypeSafe) bluechip classifier (`off`/`shadow`/`veto`/`approve`); no network on import.
- `standalone/balances.js`, `standalone/rpc.js`: standard RPC balances, cached prices, read fallback.
- `standalone/transactions.js`: in-process priority queue for wallet writes; exits precede queued entries.
- `tools/executor.js`: deploy/close/claim/swap dispatch, transaction preflight checks (including a fresh tier pool check), notifications, post-close swaps.
- `tools/dlmm.js`: local Meteora SDK transactions and Meteora position/PnL reads. Preserve lazy SDK loading, position cache invalidation, and pool-rent checks.
- `tools/pnl.js`: optional on-chain PnL engine and Meteora cost-basis reads.
- `tools/wallet.js`: balances and direct Jupiter swaps.
- `secret-key.js`: the single wallet-secret parser (base58, byte array, hex, seed).
- `exit-rules.js`, `state.js`: deterministic rules (tier stop loss, volatility × bin-step range sizing) and position tracking.
- `performance.js`: local performance accounting (`performance` table) with the tier, signal source and Jev answers; `getPerformanceBreakdown` feeds `cli.js db stats` and the Telegram Stats view.
- `pool-memory.js`, `token-blacklist.js`, `dev-blocklist.js`: local history and safety filters.
- `telegram.js`, `standalone/telegram-admin.js`: notifications and the admin console.

## Invariants

- Entries require a fresh scanner signal, then full tier screening (token, pool, volatility) and pre-submit rechecks. Manual pools are an explicit `manualPools` list: safety checks and the auto shape, no tier bands. Do not expose an entry bypass through the CLI.
- Tier thresholds live in `config.screening.tiers` (flat `<tier><Field>` user keys). Tokens below the lowest enabled tier are rejected.
- `shadowMode` forces `DRY_RUN=true` across transaction paths.
- Missing data must not be interpreted as empty positions, spendable funds, or calm volatility.
- Keep entry screening independent of exit polling. Serialize wallet mutations through the existing queue.
- Preserve `before_submit` and `on_prepared` hooks and persisted attempt recovery.
- Read fresh positions and funds before deployment. Preserve position limits (global and per tier), duplicate guards, range floors, and bin-array initialization checks.
- The `minBinsBelow` floor is 35. Only token-X / SOL-token-Y pools are supported for execution.
- Jev may decide entries only after deterministic screening passes. Hard rules are never bypassed. Jev never sizes positions or exits them. `approve` mode is fail-closed. Numbers are never sent for judgment.
- Never import the old agent, prompt, HiveMind, or server adapters into the active graph. Do not add data APIs beyond Jupiter and Meteora.
- Do not edit user secrets, runtime state, or the local archive branch as part of routine refactors.

## Configuration and state

`config.js` loads `user-config.json` once. `validateConfig()` refuses to start on an invalid `jevMode` or an unknown tier. The example file documents supported settings. Restart after changes. Secrets belong in environment variables or `.env`; never commit them. All runtime state lives in `meridian.db`; legacy JSON state is imported once and kept as `*.migrated`. Keep the database, `.migrated` files and logs intact. Tests use a temp database via `MERIDIAN_DB` (set in `test/setup-env.js`).

## Checks

Run `npm test` after changes.
- `test/test-standalone.js` covers tiers, screening, the scanner, volatility, range sizing, signals and cooldowns, balances, priority ordering, exits, Jev, and secret-key formats.
- `test/cleanup.test.js` checks module resolution, no-network imports, the CLI surface, the Telegram menu schema, and mocked Meteora position mapping.

Do not start the live daemon or send transactions to validate a refactor. `node cli.js scan` is the read-only live check.
