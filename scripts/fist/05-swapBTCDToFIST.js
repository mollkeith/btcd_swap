#!/usr/bin/env node
/** Swap BTCD -> FIST on PGARouterV2 (step 5). */

import { parseUnits } from "ethers";
import { parseCommonFlags } from "../../lib/args.js";
import { swapBtcdToFist } from "../../lib/fist/pgpRouter.js";
import { runPrivateBatch } from "../../lib/fist/runPrivateBatch.js";
import { FIST_PGP } from "../../lib/fist/constants.js";

function printHelp() {
  console.log(`usage: node scripts/fist/05-swapBTCDToFIST.js [options]
  --csv PATH              Private wallet CSV (required)
  --amount AMOUNT         BTCD or "all" (default: all)
  --min-btcd MIN          Skip below (default: 0.01)
  --slippage-bps BPS      Slippage (default: 100 = 1%)
  --dry-run  --yes
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minBtcd: 0.01, slippageBps: 100 },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-btcd") { a.minBtcd = Number(argv[i + 1]); return i + 1; }
      if (arg === "--slippage-bps") { a.slippageBps = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

runPrivateBatch({
  scriptName: "fistSwapBTCDToFIST",
  chain: "pgp",
  extraParseArgs: parseArgs,
  confirmMessage: "\nProceed with BTCD -> FIST swaps? [y/N] ",
  printHeader({ args, csvPath, jobs }) {
    console.log("PGP BTCD -> FIST swap (FIST pipeline step 5)");
    console.log(`  router:  ${FIST_PGP.ROUTER}`);
    console.log(`  CSV:     ${csvPath}`);
    console.log(`  wallets: ${jobs.length}`);
    console.log(`  slippage: ${args.slippageBps} bps`);
    console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  },
  async processWallet(provider, job, args) {
    const result = await swapBtcdToFist(provider, job, {
      amountArg: args.amount,
      minBtcdWei: parseUnits(String(args.minBtcd), 18),
      slippageBps: args.slippageBps,
      gasPrice: args.gasPrice,
      dryRun: args.dryRun,
    });
    if (result.status === "ok") {
      console.log(`  swap tx: ${result.swap_tx} (+${result.fist_received} FIST)`);
    }
    return result;
  },
}).catch((e) => { console.error(e); process.exit(1); });
