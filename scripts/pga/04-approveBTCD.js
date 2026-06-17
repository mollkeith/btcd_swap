#!/usr/bin/env node
/** Approve BTCD for swap contract (PGA pipeline step 4). */

import { parseUnits } from "ethers";
import { parseCommonFlags } from "../../lib/args.js";
import { approveBtcdForSwap } from "../../lib/pga/swapContract.js";
import { runPrivateBatch } from "../../lib/fist/runPrivateBatch.js";
import { PGA_PIPELINE } from "../../lib/pga/constants.js";

function printHelp() {
  console.log(`usage: node scripts/pga/04-approveBTCD.js [options]
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
  scriptName: "pgaApproveBTCD",
  chain: "pgp",
  extraParseArgs: parseArgs,
  confirmMessage: "\nProceed with BTCD approve (swap contract)? [y/N] ",
  printHeader({ args, csvPath, jobs }) {
    console.log("Approve BTCD for swap contract (PGA pipeline step 4)");
    console.log(`  swap:    ${PGA_PIPELINE.SWAP_CONTRACT}`);
    console.log(`  CSV:     ${csvPath}`);
    console.log(`  wallets: ${jobs.length}`);
    console.log(`  amount:  ${args.amount}`);
    console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  },
  async processWallet(provider, job, args) {
    const result = await approveBtcdForSwap(provider, job, {
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
