import { deployPosition, getMyPositions, claimFees, closePosition } from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { withWalletLock } from "../standalone/transactions.js";
import { invalidateBalances } from "../standalone/balances.js";
import { config, MIN_SAFE_BINS_BELOW } from "../config.js";
import { addPoolNote } from "../pool-memory.js";
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";
import { poolWithVolatility } from "../standalone/meteora.js";
import { rejectPool } from "../standalone/screening.js";
import { manualSafety } from "../standalone/manual.js";
function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Last gate before any transaction: a fresh Meteora read of the pool must still
// pass the tier rules the entry was screened under (volatility from fresh candles).
async function validateDeployPoolThresholds(args) {
  const tier = config.screening.tiers[args.tier];
  if (!tier) return { pass: false, reason: `Deploy requires a screened tier (got ${args.tier ?? "none"})` };
  let detail;
  try {
    detail = await poolWithVolatility(args.pool_address);
  } catch (error) {
    return { pass: false, reason: `Could not verify pool screening thresholds before deploy: ${error.message}` };
  }
  const why = rejectPool(detail, detail?.token_x?.address, tier, config.screening);
  if (why) return { pass: false, reason: `Pool failed ${args.tier} rules before deploy: ${why}` };
  return {
    pass: true,
    entryMarketData: {
      entry_mcap: numberOrNull(detail.token_x?.market_cap),
      entry_tvl: numberOrNull(detail.tvl),
      entry_volume: numberOrNull(detail.volume?.["24h"]),
      entry_holders: numberOrNull(detail.token_x?.holders),
      base_mint: detail.token_x?.address,
    },
  };
}

// User-named pools skip tier bands. Pair, blacklist, price and volatility still have to hold.
async function validateManualDeploy(args) {
  let detail;
  try {
    detail = await poolWithVolatility(args.pool_address);
  } catch (error) {
    return { pass: false, reason: `Could not verify manual pool before deploy: ${error.message}` };
  }
  const why = manualSafety(detail);
  if (why) return { pass: false, reason: `Manual pool blocked: ${why}` };
  return {
    pass: true,
    entryMarketData: {
      entry_mcap: numberOrNull(detail.token_x?.market_cap),
      entry_tvl: numberOrNull(detail.tvl),
      entry_volume: numberOrNull(detail.volume?.["24h"]),
      entry_holders: numberOrNull(detail.token_x?.holders),
      base_mint: detail.token_x?.address,
    },
  };
}

const toolMap = {
  deploy_position: deployPosition,
  claim_fees: claimFees,
  close_position: closePosition,
  swap_token: swapToken,
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Swap a base token back to SOL with retry. Jupiter can transiently fail (no route,
 * quote error) and a single attempt silently leaves the token unsold — this retries
 * with a delay, re-fetching the balance each attempt (amounts can shift on partial
 * fills). Treats both a throw AND result.success===false / missing tx as failure.
 * Returns { swapped, result, token } — swapped=false if nothing to do or all attempts failed.
 */
async function swapBaseToSolWithRetry(baseMint, label) {
  const attempts = Math.max(1, Number(config.management.autoSwapRetryAttempts ?? 3));
  const delayMs = Math.max(0, Number(config.management.autoSwapRetryDelayMs ?? 3000));
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const balances = await getWalletBalances({ force: true });
      if (balances.error) throw new Error("Balance unavailable after transaction");
      const token = balances.tokens?.find((t) => t.mint === baseMint);
      if (!token || token.balance <= 0 || (token.usd != null && token.usd < 0.10)) {
        // Nothing left to swap (already sold or dust) — treat as done.
        return { swapped: attempt > 1, result: null, token: null };
      }
      log("executor", `Auto-swapping ${label} ${token.symbol || baseMint.slice(0, 8)} ($${token.usd == null ? "unknown" : token.usd.toFixed(2)}) back to SOL (attempt ${attempt}/${attempts})`);
      const swapResult = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
      const ok = swapResult && swapResult.success !== false && !swapResult.error && (swapResult.tx || swapResult.amount_out);
      if (ok) return { swapped: true, result: swapResult, token };
      lastErr = swapResult?.error || swapResult?.reason || "swap returned no tx";
    } catch (e) {
      lastErr = e.message;
    }
    log("executor_warn", `Auto-swap ${label} attempt ${attempt}/${attempts} failed: ${lastErr}`);
    if (attempt < attempts) await sleep(delayMs);
  }
  log("executor_warn", `Auto-swap ${label} failed after ${attempts} attempts — base token left unsold (${baseMint.slice(0, 8)})`);
  return { swapped: false, result: null, token: null };
}

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args = {}) {
  if (WRITE_TOOLS.has(name)) return withWalletLock(async () => {
    try { return await executeToolUnlocked(name, args); }
    finally { invalidateBalances(); }
  }, name === "close_position" ? 10 : name === "deploy_position" ? 0 : 5);
  return executeToolUnlocked(name, args);
}
async function executeToolUnlocked(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
      } else if (name === "close_position") {
        notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0 }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold (retried).
        if (!args.skip_swap && result.base_mint) {
          const { swapped, result: swapResult } = await swapBaseToSolWithRetry(result.base_mint, "after close");
          if (swapped) {
            // Tell the model the swap already happened so it doesn't call swap_token again
            result.auto_swapped = true;
            result.auto_swap_note = `Base token already auto-swapped back to SOL (${result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
            if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        await swapBaseToSolWithRetry(result.base_mint, "after claim");
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return the failure to the deterministic caller.
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      if (typeof args.before_submit !== "function") {
        return { pass: false, reason: "Entries require a fresh scanner signal" };
      }
      const poolThresholds = args.source === "manual"
        ? await validateManualDeploy(args)
        : await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.error || !Array.isArray(positions.positions)) return { pass: false, reason: "Position read unavailable" };
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      // Dry run checks only against a configured simulated balance.
      if (process.env.DRY_RUN !== "true" || config.standalone.dryRunSolBalance != null) {
        const balance = await getWalletBalances({ force: true, nativeOnly: true });
        if (balance.error || !Number.isFinite(balance.sol)) return { pass: false, reason: "Balance read unavailable" };
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }



    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
