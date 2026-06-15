#!/usr/bin/env node
/**
 * Generate n EVM wallets; save indexed CSV files (never overwrites).
 * Output: data/01-wallets.csv, data/01-wallets-private.csv, ...
 */

import { Wallet } from "ethers";
import { PROJECT_ROOT } from "../lib/paths.js";
import { writeWalletsCsv } from "../lib/csv.js";
import { createLogger } from "../lib/logger.js";
import {
  nextWalletIndex,
  ensureWalletCsvNotExists,
  formatWalletIndex,
} from "../lib/walletCsv.js";

function printHelp() {
  console.log(`usage: node scripts/01-createWallets.js [options]

options:
  --count N           Number of wallets (required)
  --out-dir DIR       Output directory (default: data)
  --index N           File index, e.g. 1 -> 01-wallets.csv (default: next available)
  -h, --help

Each run creates new files (never overwrites):
  data/01-wallets.csv
  data/01-wallets-private.csv
`);
}

function parseArgs(argv) {
  const args = { outDir: "data", index: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--count") args.count = Number(argv[++i]);
    else if (arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--index") args.index = Number(argv[++i]);
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.count || args.count < 1) {
    throw new Error("--count N is required (N >= 1)");
  }
  if (args.index !== null && (!Number.isInteger(args.index) || args.index < 1)) {
    throw new Error("--index must be a positive integer");
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

  const index =
    args.index !== null
      ? formatWalletIndex(args.index)
      : nextWalletIndex(args.outDir);

  const { publicCsv, privateCsv, pubAbs, privAbs } = ensureWalletCsvNotExists(
    index,
    args.outDir
  );

  const rows = [];
  for (let i = 1; i <= args.count; i += 1) {
    const w = Wallet.createRandom();
    rows.push({ index: i, address: w.address, privateKey: w.privateKey });
  }

  writeWalletsCsv(privAbs, rows, { includePrivateKey: true });
  writeWalletsCsv(pubAbs, rows, { includePrivateKey: false });

  const logger = createLogger("createWallets", { projectRoot: PROJECT_ROOT });
  for (const row of rows) {
    logger.append({
      file_index: index,
      wallet_index: row.index,
      address: row.address,
      status: "created",
    });
  }

  const summaryPath = logger.writeSummary({
    index,
    count: rows.length,
    public_csv: publicCsv,
    private_csv: privateCsv,
  });

  console.log(`Created ${rows.length} wallets -> ${index}-wallets`);
  console.log(`  public:  ${publicCsv}`);
  console.log(`  private: ${privateCsv}`);
  console.log(`\nNext steps:`);
  console.log(`  npm run 02:transfer-pga -- --csv ${publicCsv}`);
  console.log(`  npm run 03:transfer-btcd -- --csv ${publicCsv} --min-btcd 1 --max-btcd 100`);
  console.log(`  npm run 04:swap-btcd -- --csv ${privateCsv}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
