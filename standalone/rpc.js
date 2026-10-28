import { Connection } from '@solana/web3.js';
import { config } from '../config.js';

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Data request failed (HTTP ${response.status})`);
  return response.json();
}
export function connection(url, wsEndpoint) {
  if (!url) throw new Error('Configure RPC_URL (and optionally BALANCE_RPC_URL/FALLBACK_RPC_URL)');
  return new Connection(url, {
    commitment: 'confirmed', ...(wsEndpoint ? { wsEndpoint } : {}),
    disableRetryOnRateLimit: true,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
  });
}
const connections = new Map();
export async function readRpc(kind, fn) {
  const primary = kind === 'balance' ? config.standalone.balanceRpcUrl : config.standalone.rpcUrl;
  const urls = [...new Set([primary, config.standalone.fallbackRpcUrl].filter(Boolean))];
  if (!urls.length) throw new Error('RPC_URL is required');
  let error;
  for (const url of urls) {
    try {
      if (!connections.has(url)) connections.set(url, connection(url));
      return await fn(connections.get(url));
    } catch (e) { error = e; }
  }
  throw new Error(`RPC ${kind} read failed (${rpcErrorSummary(error)})`);
}

/**
 * Short, log-safe reason for an RPC failure (e.g. "429 max usage reached").
 * Provider errors may contain authenticated URLs or api keys: strip them.
 */
export function rpcErrorSummary(error) {
  const text = String(error?.message ?? error?.name ?? 'Error')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/(api[-_]?key|token|secret)=[^&\s"]+/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 80) || 'Error';
}
