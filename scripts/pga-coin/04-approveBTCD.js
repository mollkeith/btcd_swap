#!/usr/bin/env node
/** Approve BTCD for PGARouterV2 (PGA-coin step 4). */

import { parseUnits } from "ethers";
import { parseCommonFlags } from "../../lib/args.js";
import { approveBtcdForRouter } from "../../lib/pga-coin/pgaSwap.js";
import { runPrivateBatch } from "../../lib/fist/runPrivateBatch.js";
import { PGACOIN_PGP } from "../../lib/pga-coin/constants.js";

function printHelp() {
  console.log(`usage: node scripts/pga-coin/04-approveBTCD.js [options]
  --csv PATH          Private wallet CSV (required)
  --amount AMOUNT     BTCD to approve or "all" (default: all)
  --min-btcd MIN      Skip below this BTCD (default: 0.01)
  --dry-run  --yes
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minBtcd: 0.01 },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-btcd") { a.minBtcd = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

runPrivateBatch({
  scriptName: "pgacoinApproveBTCD",
  chain: "pgp",
  extraParseArgs: parseArgs,
  confirmMessage: "\nProceed with BTCD approve transactions? [y/N] ",
  printHeader({ args, csvPath, jobs }) {
    console.log("Approve BTCD for PGARouterV2 (PGA-coin pipeline step 4)");
    console.log(`  router:  ${PGACOIN_PGP.ROUTER}`);
    console.log(`  CSV:     ${csvPath}`);
    console.log(`  wallets: ${jobs.length}`);
    console.log(`  amount:  ${args.amount}`);
    console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  },
  async processWallet(provider, job, args) {
    const result = await approveBtcdForRouter(provider, job, {
      amountArg: args.amount,
      minBtcdWei: parseUnits(String(args.minBtcd), 18),
      gasPrice: args.gasPrice,
      dryRun: args.dryRun,
    });
    if (result.status === "ok") {
      if (result.approve_tx) console.log(`  approve tx: ${result.approve_tx}`);
      else console.log(`  allowance already sufficient for ${result.btcd_approved} BTCD`);
    }
    return result;
  },
}).catch((e) => { console.error(e); process.exit(1); });
