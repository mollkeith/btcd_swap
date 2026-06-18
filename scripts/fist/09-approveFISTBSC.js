#!/usr/bin/env node
/** Approve FIST on BSC for PancakeSwap V2 (step 9). */

import { parseUnits } from "ethers";
import { parseCommonFlags } from "../../lib/args.js";
import { DEFAULT_GAS } from "../../lib/constants.js";
import { approveFistForPancake } from "../../lib/fist/pancakeV2.js";
import { runPrivateBatch } from "../../lib/fist/runPrivateBatch.js";
import { FIST_BSC } from "../../lib/fist/constants.js";

function printHelp() {
  console.log(`usage: node scripts/fist/09-approveFISTBSC.js [options]
  --csv PATH          Private wallet CSV (required)
  --amount AMOUNT     FIST or "all" (default: all)
  --min-fist MIN      Skip below (default: 1, BSC FIST 6 decimals)
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minFist: 1, gasPriceGwei: DEFAULT_GAS.bscGwei },
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
  scriptName: "fistApproveFISTBSC",
  chain: "bsc",
  extraParseArgs: parseArgs,
  confirmMessage: "\nProceed with BSC FIST approve (Pancake)? [y/N] ",
  printHeader({ args, csvPath, jobs }) {
    console.log("Approve FIST on BSC for PancakeSwap (FIST pipeline step 9)");
    console.log(`  router:  ${FIST_BSC.PANCAKE_V2_ROUTER}`);
    console.log(`  CSV:     ${csvPath}`);
    console.log(`  wallets: ${jobs.length}`);
    console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  },
  async processWallet(provider, job, args) {
    const result = await approveFistForPancake(provider, job, {
      amountArg: args.amount,
      minFistWei: parseUnits(String(args.minFist), FIST_BSC.FIST_DECIMALS),
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
