#!/usr/bin/env node
/**
 * Generate n EVM wallets; save private + public CSV files.
 */

import { Wallet } from "ethers";
import { join } from "node:path";
import { PROJECT_ROOT } from "../lib/paths.js";
import { writeWalletsCsv } from "../lib/csv.js";
import { createLogger } from "../lib/logger.js";

function printHelp() {
  console.log(`usage: node createWallets.js [options]

options:
  --count N           Number of wallets (required)
  --out-dir DIR       Output directory (default: data)
  --prefix NAME       Filename prefix (default: wallets)
  -h, --help
`);
}

function parseArgs(argv) {
  const args = { outDir: "data", prefix: "wallets" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--count") args.count = Number(argv[++i]);
    else if (arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--prefix") args.prefix = argv[++i];
    else if (arg === "-h" || arg === "--help") { printHelp(); process.exit(0); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.count || args.count < 1) {
    throw new Error("--count N is required (N >= 1)");
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  const outDir = join(PROJECT_ROOT, args.outDir);
  const privatePath = join(outDir, `${args.prefix}-private.csv`);
  const publicPath = join(outDir, `${args.prefix}.csv`);

  const rows = [];
  for (let i = 1; i <= args.count; i += 1) {
    const w = Wallet.createRandom();
    rows.push({ index: i, address: w.address, privateKey: w.privateKey });
  }

  writeWalletsCsv(privatePath, rows, { includePrivateKey: true });
  writeWalletsCsv(publicPath, rows, { includePrivateKey: false });

  const logger = createLogger("createWallets", { projectRoot: PROJECT_ROOT });
  const results = rows.map((r) => ({
    index: r.index,
    address: r.address,
    status: "created",
  }));
  for (const r of results) logger.append(r);

  const summaryPath = logger.writeSummary({
    count: rows.length,
    private_csv: privatePath,
    public_csv: publicPath,
  });

  console.log(`Created ${rows.length} wallets`);
  console.log(`  private: ${privatePath}`);
  console.log(`  public:  ${publicPath}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
