import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// One parser for every wallet secret format. Errors describe the shape only —
// never echo the secret itself.
function fromBytes(bytes, label) {
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`${label} decodes to ${bytes.length} bytes; expected 64 (secret key) or 32 (seed) — the key is likely truncated or mis-copied`);
}

/** Accepts a JSON byte array, base58, or hex secret (64-byte key or 32-byte seed). */
export function parseSecretKey(raw) {
  const text = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
  if (!text) throw new Error("Secret key is empty");
  if (text.split(/\s+/).length >= 12) throw new Error("Seed phrases are not supported; export the private key from your wallet instead");
  if (text.startsWith("[")) {
    let bytes;
    try { bytes = JSON.parse(text); } catch { throw new Error("Byte array is not valid JSON"); }
    if (!Array.isArray(bytes) || bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error("Byte array must contain integers 0-255");
    return fromBytes(Uint8Array.from(bytes), "Byte array");
  }
  const hex = text.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]+$/.test(hex) && (hex.length === 128 || hex.length === 64)) return fromBytes(Uint8Array.from(Buffer.from(hex, "hex")), "Hex key");
  let bytes;
  try { bytes = bs58.decode(text); } catch { throw new Error("Key is not valid base58, hex, or a JSON byte array"); }
  return fromBytes(bytes, `Base58 key (${text.length} chars)`);
}

/** Canonical form stored in WALLET_PRIVATE_KEY. */
export const toBase58Secret = keypair => bs58.encode(keypair.secretKey);
