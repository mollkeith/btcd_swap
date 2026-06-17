#!/usr/bin/env node
/** Approve FIST on PGP for bridge (step 6). */

import { parseUnits } from "ethers";
import { parseCommonFlags } from "../../lib/args.js";
import { approveFistForBridge } from "../../lib/fist/fistBridge.js";
import { runPrivateBatch } from "../../lib/fist/runPrivateBatch.js";
import { FIST_PGP } from "../../lib/fist/constants.js";

function printHelp() {
  console.log(`usage: node scripts/fist/06-approveFIST.js [options]
  --csv PATH          Private wallet CSV (required)
  --amount AMOUNT     FIST or "all" (default: all)
  --min-fist MIN      Skip below (default: 0.01)
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minFist: 0.01 },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-fist") { a.minFist = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

runPrivateBatch({
  scriptName: "fistApproveFIST",
  chain: "pgp",
  extraParseArgs: parseArgs,
  confirmMessage: "\nProceed with FIST approve (bridge)? [y/N] ",
  printHeader({ args, csvPath, jobs }) {
    console.log("Approve FIST for bridge (FIST pipeline step 6)");
    console.log(`  bridge:  ${FIST_PGP.BRIDGE}`);
    console.log(`  CSV:     ${csvPath}`);
    console.log(`  wallets: ${jobs.length}`);
    console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  },
  async processWallet(provider, job, args) {
    const result = await approveFistForBridge(provider, job, {
      amountArg: args.amount,
      minFistWei: parseUnits(String(args.minFist), FIST_PGP.FIST_DECIMALS),
      gasPrice: args.gasPrice,
      dryRun: args.dryRun,
    });
    if (result.status === "ok") {
      if (result.approve_tx) console.log(`  approve tx: ${result.approve_tx}`);
      else console.log(`  allowance already sufficient for ${result.fist_approved} FIST`);
    }
    return result;
  },
}).catch((e) => { console.error(e); process.exit(1); });
