#!/usr/bin/env node
import './envcrypt.js';
import { parseArgs } from 'node:util';

const HELP = `Meridian — bluechip + mid-cap DLMM farmer (Jupiter + Meteora)

Commands:
  start                           Start the pool scanner and deterministic exits
  status                          Show persisted signal and attempt state (no network)
  scan                            Preview one scanner pass, read-only; never signals or deploys
  balance                         Read native SOL and token balances
  positions [--wallet ADDRESS]    Read open positions
  pnl --pool ADDRESS --position ADDRESS
  screen --mint ADDRESS           Screen one mint, read-only; never deploys
  pool --pool ADDRESS             Read Meteora pool metrics plus daily volatility
  active-bin --pool ADDRESS       Read the current on-chain bin
  manage                          Run one deterministic management pass
  close --position ADDRESS [--reason TEXT] [--skip-swap]
  claim --position ADDRESS
  swap --from MINT --to MINT --amount NUMBER
  blacklist                       List blocked token mints
  blacklist add --mint ADDRESS [--reason TEXT]
  blacklist remove --mint ADDRESS
  performance [--hours NUMBER]     Read local closed-position history
  db stats [--hours NUMBER]       PnL breakdown by tier, label and close reason (default 168h)
  db positions [--open]           Tracked positions from the database
  db signals                      Scanner signals and entry attempts
  db decisions [--limit NUMBER]   Recent deploy/close decisions
  db query "SELECT ..."           Read-only SQL against meridian.db
  config                          Show non-secret strategy and threshold settings
  help

Flags: --dry-run forces all transaction operations to simulate only.
Configuration: user-config.json (restart the daemon after editing).
State: meridian.db (SQLite; legacy JSON state files are imported on first open).
New entries are made only by the Meteora pool scanner after tiered screening;
there is no manual deploy command.
`;
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries([
    ...['wallet','pool','position','mint','reason','from','to','amount','hours','limit'].map(k => [k, { type: 'string' }]),
    ...['help','dry-run','skip-swap','open'].map(k => [k, { type: 'boolean' }]),
  ]),
});
if (flags['dry-run']) process.env.DRY_RUN = 'true';
const out = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
function requireFlag(key) { if (!flags[key]) throw new Error(`--${key} is required`); return flags[key]; }
function positiveFlag(key, fallback) {
  const n = Number(flags[key] ?? fallback);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} must be positive`);
  return n;
}
async function main() {
  const [cmd = 'help', action] = positionals;
  if (flags.help || cmd === 'help') { process.stdout.write(HELP); return; }
  // Load config before tools so shadow mode is applied to every write.
  const { config } = await import('./config.js');
  switch (cmd) {
    case 'start': return (await import('./standalone/runtime.js')).startStandalone();
    case 'status': {
      const { MonitorStore } = await import('./standalone/store.js');
      const { data } = new MonitorStore();
      return out({ shadow: config.standalone.shadow, tiers: config.screening.enabledTiers, signals: data.signals, attempts: data.attempts });
    }
    case 'balance': return out(await (await import('./tools/wallet.js')).getWalletBalances({ force: true }));
    case 'positions': return out(await (await import('./tools/dlmm.js')).getMyPositions({ force: true, wallet_address: flags.wallet }));
    case 'pnl': return out(await (await import('./tools/dlmm.js')).getPositionPnl({ pool_address: requireFlag('pool'), position_address: requireFlag('position') }));
    case 'screen': return out(await (await import('./standalone/screening.js')).screenMint(requireFlag('mint')));
    case 'pool': return out(await (await import('./standalone/meteora.js')).poolWithVolatility(requireFlag('pool')));
    case 'scan': return out(await (await import('./standalone/scanner.js')).scanOnce({ emit: false }));
    case 'active-bin': return out(await (await import('./tools/dlmm.js')).getActiveBin({ pool_address: requireFlag('pool') }));
    case 'manage': return out(await (await import('./standalone/runtime.js')).manageOnce());
    case 'close': case 'claim': case 'swap': {
      const { executeTool } = await import('./tools/executor.js');
      if (cmd === 'close') return out(await executeTool('close_position', { position_address: requireFlag('position'), reason: flags.reason || 'manual close', skip_swap: !!flags['skip-swap'] }));
      if (cmd === 'claim') return out(await executeTool('claim_fees', { position_address: requireFlag('position') }));
      const amount = Number(requireFlag('amount'));
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('--amount must be positive');
      return out(await executeTool('swap_token', { input_mint: requireFlag('from'), output_mint: requireFlag('to'), amount }));
    }
    case 'blacklist': {
      const blocked = await import('./token-blacklist.js');
      if (!action) return out(blocked.listBlacklist());
      if (action === 'add') return out(blocked.addToBlacklist({ mint: requireFlag('mint'), reason: flags.reason || 'manual block' }));
      if (action === 'remove') return out(blocked.removeFromBlacklist({ mint: requireFlag('mint') }));
      throw new Error('Use blacklist, blacklist add, or blacklist remove');
    }
    case 'performance': {
      const { getPerformanceHistory, getPerformanceSummary } = await import('./performance.js');
      return out({ summary: getPerformanceSummary(), recent: getPerformanceHistory({ hours: positiveFlag('hours', 24) }) });
    }
    case 'db': {
      if (action === 'stats') return out((await import('./performance.js')).getPerformanceBreakdown({ hours: positiveFlag('hours', 168) }));
      if (action === 'positions') return out((await import('./state.js')).getTrackedPositions(!!flags.open));
      if (action === 'signals') {
        const { MonitorStore } = await import('./standalone/store.js');
        const { signals, attempts } = new MonitorStore().data;
        return out({ signals, attempts });
      }
      if (action === 'decisions') return out((await import('./decision-log.js')).getRecentDecisions(positiveFlag('limit', 20)));
      if (action === 'query') {
        const sql = positionals[2];
        if (!sql) throw new Error('Usage: db query "SELECT ..."');
        return out((await import('./db.js')).readOnlyQuery(sql));
      }
      throw new Error('Use db stats, db positions, db signals, db decisions, or db query');
    }
    case 'config': return out({ shadowMode: config.standalone.shadow, scanner: config.scanner, risk: config.risk, screening: config.screening, jev: config.jev, management: config.management, strategy: config.strategy, schedule: config.schedule });
    default: throw new Error(`Unknown command "${cmd}". Run meridian help. Legacy commands are archived on the legacy branch.`);
  }
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; });
