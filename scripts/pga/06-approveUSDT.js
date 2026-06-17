#!/usr/bin/env node
/** Approve USDT for bridge (PGA pipeline step 6). */

import { parseUnits } from "ethers";
import { parseCommonFlags } from "../../lib/args.js";
import { approveUsdtForBridge } from "../../lib/pga/usdtBridge.js";
import { runPrivateBatch } from "../../lib/fist/runPrivateBatch.js";
import { PGA_PIPELINE } from "../../lib/pga/constants.js";

function printHelp() {
  console.log(`usage: node scripts/pga/06-approveUSDT.js [options]
  --csv PATH          Private wallet CSV (required)
  --amount AMOUNT     USDT to approve or "all" (default: all)
  --min-usdt MIN      Skip below (default: 0.01)
  --dry-run  --yes
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minUsdt: 0.01 },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-usdt") { a.minUsdt = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

runPrivateBatch({
  scriptName: "pgaApproveUSDT",
  chain: "pgp",
  extraParseArgs: parseArgs,
  confirmMessage: "\nProceed with USDT approve (bridge)? [y/N] ",
  printHeader({ args, csvPath, jobs }) {
    console.log("Approve USDT for bridge (PGA pipeline step 6)");
    console.log(`  bridge:  ${PGA_PIPELINE.BRIDGE}`);
    console.log(`  CSV:     ${csvPath}`);
    console.log(`  wallets: ${jobs.length}`);
    console.log(`  amount:  ${args.amount}`);
    console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  },
  async processWallet(provider, job, args) {
    const result = await approveUsdtForBridge(provider, job, {
      amountArg: args.amount,
      minUsdtWei: parseUnits(String(args.minUsdt), 18),
      gasPrice: args.gasPrice,
      dryRun: args.dryRun,
    });
    if (result.status === "ok") {
      if (result.approve_tx) console.log(`  approve tx: ${result.approve_tx}`);
      else console.log(`  allowance already sufficient for ${result.usdt_approved} USDT`);
    }
    return result;
  },
}).catch((e) => { console.error(e); process.exit(1); });
