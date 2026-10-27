#!/usr/bin/env node
// Convert a Solana secret (JSON byte array, base58, hex, or 32-byte seed) into the
// base58 form WALLET_PRIVATE_KEY expects. The secret is read from a hidden prompt
// or stdin — never from argv, so it stays out of shell history.
import readline from "node:readline";
import { parseSecretKey, toBase58Secret } from "../secret-key.js";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(`Usage:
  npm run key:convert                      # hidden prompt
  node scripts/convert-key.js < key.txt    # from stdin
  --check   only validate and print the public key (no secret output)
  --json    print the secret as a 64-byte JSON array instead of base58`);
  process.exit(0);
}

async function readSecret() {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = text => { if (!rl.muted) rl.output.write(text); };
  const answer = new Promise(resolve => rl.question("Paste secret key (hidden): ", resolve));
  rl.muted = true;
  const value = await answer;
  rl.close();
  process.stdout.write("\n");
  return value;
}

try {
  const keypair = parseSecretKey(await readSecret());
  console.log(`Public key: ${keypair.publicKey.toBase58()}`);
  if (!args.includes("--check")) {
    const secret = args.includes("--json") ? JSON.stringify([...keypair.secretKey]) : toBase58Secret(keypair);
    console.log(`WALLET_PRIVATE_KEY=${secret}`);
    console.error("Keep this output private: paste it into .env on one line, then clear the terminal.");
  }
} catch (e) {
  console.error(`Invalid key: ${e.message}`);
  process.exit(1);
}
