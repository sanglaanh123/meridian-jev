# Meridian (jev fork)

Automated **Meteora DLMM** liquidity farmer for Solana, focused on **bluechip and mid-cap tokens paired with SOL**. The bot:
- scans Meteora pools on a schedule
- screens tokens by market-cap tier and by a per-coin label
- enters only when indicators confirm a ranging market
- manages positions with deterministic rules: stop loss, out-of-range, indicator exits

Thin-liquidity memecoin pools are filtered out by design. No LLM or server is required. Data comes only from **Jupiter** and **Meteora**, plus the Solana RPC used for signing and balances.

> **Status: dry run only.** Over the last 60 days of backtests, the average result is still **negative after costs**. The current configuration loses about −0.1% per 72h position, versus −0.4% to −0.7% before the indicator gates. Do not trade real funds yet. See [Research & backtests](#research--backtests).

---

## How it works

```
Scanner (15 min) ─► Tier ─► Coin label ─► Screening ─► Pool / bin step ─► Indicator gate ─► Deploy
                                                                                               │
          Exit poller (3 s) + management pass (10 min): stop loss · OOR · low yield · indicator exit
```

1. **Scan.** Every `scanMin` minutes the bot lists token/SOL pools from the Meteora Data API (`dlmm.datapi.meteora.ag`). The list is filtered server-side by TVL and 24h volume.

2. **Tier by market cap** (from Jupiter):

   | Tier | Market cap | Min TVL | Size | Max positions | Stop |
   |---|---|---|---|---|---|
   | `bluechip` | ≥ 500M | 200k | ×1 | 3 | −15% |
   | `midcap` | 20M–500M | 75k | ×0.5 | 2 | −10% |

   Tokens below 20M are rejected. Every tier value can be overridden with a flat `<tier><Field>` key, for example `midcapMinTvl`.

3. **Pool pre-filter** (no extra requests):
   - TVL, volume and bin-step band
   - minimum 24h fee/TVL
   - pool age of at least 24h
   - **fee stability:** the 4h fee rate must stay close to the 24h rate, which rejects one-off fee spikes

   Candidates are interleaved across tiers. Without this, mid caps always win on fee/TVL and bluechips would never be screened.

4. **Token screening** (Jupiter + RPC):
   - token is verified and carries a required tag
   - enough holders, enough age, and organic score above the threshold
   - top-holder share within the limit
   - mint/freeze authorities renounced
   - Token-2022 extension check
   - daily realized volatility from hourly candles
   - optional Jev classifier

5. **Strategy by coin label** (`coin-labels.json`). Each label sets three things:
   - **Shape and parameters** (`labelStrategies`): spot / curve / bid_ask, range width, stop, OOR wait, or `skip`.
   - **Which pool / bin step** to farm (`labelPoolRules`).
   - **Indicator entry gate and exit** (`labelIndicators`).

6. **Entry:**
   - The pool and price move are rechecked right before submission.
   - Size = `computeDeployAmount` × the tier `sizeMult`, within the per-tier position cap.
   - The range covers `rangeVolMult` × daily volatility at the pool's bin step, with a 35-bin floor.
   - Only **one-sided SOL below the price** is supported.

7. **Management:**
   - **3 s poller** (Meteora PnL): stop loss, take profit, trailing take profit.
   - **10 min management pass:** out-of-range close, low-yield close, indicator exit, and fee claims.
   - All wallet writes go through one queue, and exits always run before entries.

---

## Setup

Requires Node.js ≥ 18 and a dedicated Solana RPC endpoint. Public RPCs are rate-limited.

```sh
npm install
npm run setup     # writes user-config.json with shadow mode on
npm start         # or: npm run pm2:start
```

### Environment (`.env`)

| Variable | Purpose |
|---|---|
| `RPC_URL` | Main RPC: reads and transaction submission |
| `BALANCE_RPC_URL`, `FALLBACK_RPC_URL` | Optional separate RPC for balance reads, and a fallback for reads |
| `WALLET_PRIVATE_KEY` | Signing key (base58). Convert a byte-array, hex or seed export with `npm run key:convert` |
| `WALLET_ADDRESS` | Read-only mode, no private key |
| `DRY_RUN=true` | Simulate every transaction |
| `JUPITER_API_KEY` | Jupiter price and swap access |
| `JUPITER_REFERRAL_FEE_BPS` | Swap referral fee. Default 50 bps (0.5%); set `0` to disable, **recommended for small capital** |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS` | Notifications and the Telegram admin console |
| `TYPESAFE_API_KEY` | Jev, only needed when `jevMode` is not `off` |
| `PNL_SOURCE`, `PNL_RPC_URL` | PnL source: `meteora` (default) or `rpc` |

Secrets live only in `.env` and are never committed.

### Dry run vs. live

The default is `shadowMode: true`, which forces `DRY_RUN=true`.

Set `dryRunSolBalance` (for example `1`) so a dry run sizes entries like a real 1 SOL wallet. The simulated balance is fixed; it is not reduced after each entry.

To go live:
1. Review the dry-run results with `node cli.js db stats` or `node cli.js performance`.
2. Set `shadowMode: false` and remove `DRY_RUN=true`.
3. Restart.

---

## Key configuration (`user-config.json`)

`user-config.example.json` lists every key. Restart after editing; the Telegram console applies most settings live. At startup, `validateConfig()` rejects an invalid `jevMode`, tier, label, shape, gate or exit.

| Group | Keys | Defaults |
|---|---|---|
| Scanner | `scannerEnabled`, `scanMin`, `scanMaxCandidates`, `scanMaxSignals`, `signalCooldownSec` | on, 15 min, 5, 1, 3600 s |
| Tiers | `enabledTiers`, `<tier><Field>` (`bluechipMinTvl`, `midcapStopLossPct`, …) | `["bluechip","midcap"]` |
| Shared filters | `requireRenouncedAuthorities`, `minPoolAgeHours`, `feeStabilityMin/Max` | `true`, 24, 0.3–3 |
| Strategy | `strategy` | `"auto"` |
| Regime | `regimeTrendPct`, `regimeLowVolPct`, `regimeHighVolPct`, `regimeStrategies`, `regimeFallbackStrategy` | 5 / 5 / 12, built-in map, `bid_ask` |
| Labels | `labelStrategies`, `labelPoolRules`, `labelIndicators`, `unlabeledStrategy`, `unlabeledPoolRule`, `unlabeledIndicators` | see the label table below |
| Sizing | `maxPositions`, `deployAmountSol`, `positionSizePct`, `maxDeployAmount`, `gasReserve`, `minSolToOpen` | 4, 0.5, 0.35, 50, 0.2, 0.55 |
| Exits | `stopLossPct`, `takeProfitPct`, `trailingTakeProfit`, `outOfRangeWaitMinutes`, `outOfRangeBinsToClose`, `minFeePerTvl24h`, `minAgeBeforeYieldCheck` | −15, `null` (off), off, 120, 30, 0.02, 360 |
| Fees | `minClaimAmount`, `autoSwapAfterClaim` | $5, on |
| Jev | `jevMode`, `jevMinEstablished`, `jevRiskMax` | `off`, 0.7, 0.7 |

Each value in `regimeStrategies` / `labelStrategies` can be:
- a shape name: `"spot" | "curve" | "bid_ask"`
- `"skip"`: do not enter
- `"regime"`: use the regime map
- `{ "regimes": { ... } }`: a label-specific regime map
- a tuned entry: `{ "shape": "bid_ask", "rangeVolMult": 4, "stopLossPct": -10, "outOfRangeWaitMinutes": 240 }`

A tuned entry's stop and OOR wait are stored on the position and used for its exits.

---

## Coin labels

Labels group coins that behave alike, so each group gets its own strategy.

```sh
node scripts/label-coins.js            # list coins: volatility, 30-day trend, fee/TVL, bin step, Jev answers, suggested label
node scripts/label-coins.js --write    # create/refresh coin-labels.json (labels you edited by hand are kept)
```

Edit the `"label"` field in `coin-labels.json` to move a coin to another group. The file is git-ignored.

| Label | Examples | Default strategy | Pool rule | Gate → exit |
|---|---|---|---|---|
| `lst` | JitoSOL | `skip` (≈ zero fees) | tvl | – |
| `wrapped` | ETH, WBTC, cbBTC, NVDAx | bid_ask ×4, stop −10%, OOR wait 240 min | tvl | 4h chop + 4h structure not down → exit on 1h ZLEMA down-flip |
| `defi_bluechip` | JUP | same as `wrapped` | tvl | same as `wrapped` |
| `calm` | HYPE, ZEC, MET, SKR | same as `wrapped` | largest | same as `wrapped` |
| `volatile` | GRASS, ORE, BP, CARDS | regime map | fit | 1h ADX < 20 → exit on 4h ZLEMA down-flip |
| `meme` | PUMP, STONK, ANSEM, … | regime map | fee24 | same as `volatile` |

Pool rules:
- `fee24`: highest 24h fee/TVL
- `tvl`: highest TVL
- `fit`: bin step whose 35-bin ladder spans exactly the needed range
- `largest` / `smallest`: largest / smallest bin step

Unlabeled coins use the regime map, the `fee24` pool rule, and no indicators.

> Bridged tokens (ETH, WBTC, cbBTC, …) usually keep mint/freeze authority, so `requireRenouncedAuthorities` rejects them. Farming the `wrapped` group requires relaxing that rule and accepting the issuer risk.

---

## Indicators

Ported from the author's own repos into [standalone/indicators.js](standalone/indicators.js). Plain JS, closed candles only.

- **MTA-HedgeB (sideway detector):**
  - efficiency ratio = `|drift| / Σ|Δclose|`
  - position in the range
  - up/down balance
  - ATR%
  - zigzag swings
- **M-EMA-Bot:**
  - 4h ER regime (bull / bear / chop)
  - SMC market structure: fractal swings, BOS/CHoCH
  - ATR ZLEMA
  - ADX

Entry gates and exits are named in `INDICATOR_GATES` / `INDICATOR_EXITS`, and the same definitions are used by the bot and the backtests. 1h and 4h candles come straight from Meteora. Missing data never opens an entry and never closes a position.

## Regime

[standalone/regime.js](standalone/regime.js) classifies a pool by its 72h/24h trend (`up` / `down` / `range`) and its daily volatility (`low` / `mid` / `high`), for example `range/low`. Labels set to `"regime"` look up this key in `regimeStrategies`.

## Jev (optional)

Jev is TypeSafe's model. The bot sends it token text only (name, symbol, tags, links), never numbers. Jev answers three questions:
- Is this a recognised, established project?
- Does it impersonate another token?
- Which category is it?

`jevMode`:
- `off`: Jev is not called.
- `shadow`: log only.
- `veto`: a reject blocks the entry; a Jev error lets the entry through.
- `approve`: only an approve verdict enters; a Jev error blocks.

Backtests showed Jev **did not improve results**. Keep it on `shadow`.

---

## CLI

```sh
node cli.js help
node cli.js status                    # stored signals + attempts (no network)
node cli.js scan                      # preview one scanner pass, read-only
node cli.js screen --mint ADDRESS     # screen one token: tier, label, regime, pool, indicators — read-only
node cli.js pool --pool ADDRESS       # pool metrics + daily volatility
node cli.js balance | positions | performance [--hours N] | config
node cli.js manage --dry-run          # run one management pass
node cli.js close --position ADDRESS [--reason TEXT] [--skip-swap] [--dry-run]
node cli.js claim --position ADDRESS
node cli.js swap --from MINT --to MINT --amount N
node cli.js blacklist [add|remove] --mint ADDRESS
node cli.js db stats [--hours N]      # PnL by tier, label and close reason (default 168h)
node cli.js db positions [--open]     # tracked positions
node cli.js db signals                # scanner signals + entry attempts
node cli.js db decisions [--limit N]  # recent deploy/close decisions
node cli.js db query "SELECT ..."     # read-only SQL against meridian.db
```

The Telegram admin console has the same summary under 📊 Stats (or `/stats`).

There is no manual deploy command; only the scanner opens positions. `--dry-run` simulates every transaction.

**Telegram admin** (`/menu`, `/status`): scanner, tier, sizing, exit and RPC settings, shadow toggle, key import/export, restart.

---

## Research & backtests

All scripts below only read Meteora history. Data is cached in `.backtest-cache/` (git-ignored). Every tuning script splits time into **fit/validate → test** to avoid overfitting.

| Script | Purpose |
|---|---|
| `scripts/backtest.js` | Grid search over range width, stop and OOR wait per tier |
| `scripts/strategy-lab.js` | Compares 6 strategies (spot / curve / bid_ask × one- / two-sided) per regime; learns a policy, optionally with Jev features |
| `scripts/tune.js` | Tunes regime thresholds and per-regime parameters; tests Jev questions and the `minEstablished` gate (`--symbols` tunes one coin group) |
| `scripts/binstep-lab.js` | Compares pool / bin-step rules per label |
| `scripts/indicator-lab.js` | Compares indicator entry gates, exits, range widths and shape skew per label group |
| `scripts/rebalance-lab.js` | Auto-rebalancing (HawkFi HFL-style, swapless or swap, cooldowns, widths) vs the bot's close-and-re-enter |
| `scripts/label-coins.js` | Lists coins and suggests labels |

**Headline results** (60 days, after 0.6% swap and transaction costs; % per 72h position, test period):

| Configuration | Calm coins | Volatile coins |
|---|---|---|
| Original (spot, tier params) | −0.51 | −1.31 |
| Regime-based auto shape | −0.40 | −0.66 to −0.80 |
| **+ indicator gate/exit (current)** | **−0.11** | **−0.08** |
| Hold SOL | 0 | 0 |

**Takeaways:**
- **One-sided SOL below the price means buying a falling token.** Pool fees (0.03–1%/day) do not cover the price drift.
- Almost all of the improvement comes from **not entering trending markets**.
- **The real fee share of a position is still unknown.** The model assumes the pool-average fee/TVL; only a live position can measure it.
- The 0.5% Jupiter referral fee is the largest single cost. Disable it.
- **Auto-rebalancing loses more.** Rebalancing the moment price leaves the range turns impermanent loss into a realized loss on every exit. HawkFi-style HFL Regular (14 bins, swapless, 0 cooldown) simulated at −14%/week on calm coins and −36%/week on volatile coins versus holding SOL. Even the widest, slowest variant (69 bins, 24h cooldown) trailed the current close-and-wait strategy, so the bot does not rebalance.

---

## Local state

All of these files are git-ignored.

| File | Contents |
|---|---|
| `user-config.json` | Configuration |
| `coin-labels.json` | Coin labels |
| `meridian.db` | SQLite state (`db.js`): `signals`, `attempts` (crash recovery), `positions`, `position_events`, `performance`, `pools` (history, cooldowns), `token_blacklist`, `dev_blocklist`, `decisions`, `kv` |
| `*.json.migrated` | Legacy JSON state files, kept after their one-time import into `meridian.db` |
| `logs/` | Daily logs |

`MERIDIAN_DB` overrides the database path. On first open, legacy JSON state files (`wallet-monitor-state.json`, `state.json`, `lessons.json`, `pool-memory.json`, `token-blacklist.json`, `dev-blocklist.json`, `decision-log.json`) next to the database are imported once and renamed to `.migrated`. Stop the daemon before upgrading so it does not write JSON after the import.

A `submitting` attempt left by a crash needs on-chain reconciliation before that mint can be tried again. Do not delete state to bypass it.

## Tests

```sh
npm test
```

Covers:
- syntax
- unit logic: tiers, screening, scanner, regime, labels, pool rules, indicators, simulator, exit rules, Jev, secret keys
- module imports
- the CLI surface
- the Telegram menu schema

Tests never send transactions, never touch the network, and never write to `logs/` or `meridian.db`.

## History

- The smart-wallet convergence trigger and its memecoin screening were replaced by the pool scanner. The old code remains in git history.
- The **`legacy`** branch (`fd835b7`) keeps the original LLM runtime.
