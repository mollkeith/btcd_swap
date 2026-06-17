#!/usr/bin/env node
/** Create wallets for BTCD -> native PGA -> BSC -> USDT pipeline. */

import { Wallet } from "ethers";
import { PROJECT_ROOT } from "../../lib/paths.js";
import { writeWalletsCsv } from "../../lib/csv.js";
import { createLogger } from "../../lib/logger.js";
import {
  nextWalletIndex,
  ensureWalletCsvNotExists,
  formatWalletIndex,
} from "../../lib/walletCsv.js";

function printHelp() {
  console.log(`usage: node scripts/pga-coin/01-createWallets.js --count N [--index N]`);
}

function parseArgs(argv) {
  const args = { outDir: "data", index: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--count") args.count = Number(argv[++i]);
    else if (arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--index") args.index = Number(argv[++i]);
    else if (arg === "-h" || arg === "--help") { printHelp(); process.exit(0); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.count || args.count < 1) throw new Error("--count N is required");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const index = args.index !== null ? formatWalletIndex(args.index) : nextWalletIndex(args.outDir);
  const { publicCsv, privateCsv, pubAbs, privAbs } = ensureWalletCsvNotExists(index, args.outDir);

  const rows = Array.from({ length: args.count }, (_, i) => {
    const w = Wallet.createRandom();
    return { index: i + 1, address: w.address, privateKey: w.privateKey };
  });

  writeWalletsCsv(privAbs, rows, { includePrivateKey: true });
  writeWalletsCsv(pubAbs, rows, { includePrivateKey: false });

  const logger = createLogger("pgacoinCreateWallets", { projectRoot: PROJECT_ROOT });
  rows.forEach((r) => logger.append({ file_index: index, wallet_index: r.index, address: r.address, status: "created" }));
  logger.writeSummary({ index, count: rows.length, public_csv: publicCsv, private_csv: privateCsv });

  console.log(`Created ${rows.length} wallets -> ${index}-wallets (PGA-coin pipeline)`);
  console.log(`  public:  ${publicCsv}`);
  console.log(`  private: ${privateCsv}`);
  console.log("\nNext steps:");
  console.log(`  npm run pgacoin:02:transfer-pga -- --csv ${publicCsv}`);
  console.log(`  npm run pgacoin:03:transfer-btcd -- --csv ${publicCsv} --min-btcd 1 --max-btcd 100`);
  console.log(`  npm run pgacoin:04:approve-btcd -- --csv ${privateCsv}`);
  console.log(`  npm run pgacoin:05:swap-btcd-pga -- --csv ${privateCsv}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
