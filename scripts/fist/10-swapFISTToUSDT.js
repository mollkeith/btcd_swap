#!/usr/bin/env node
/** Swap FIST -> USDT on PancakeSwap V2 BSC (step 10). */

import { parseUnits } from "ethers";
import { parseCommonFlags } from "../../lib/args.js";
import { swapFistToUsdt } from "../../lib/fist/pancakeV2.js";
import { runPrivateBatch } from "../../lib/fist/runPrivateBatch.js";
import { FIST_BSC } from "../../lib/fist/constants.js";

function printHelp() {
  console.log(`usage: node scripts/fist/10-swapFISTToUSDT.js [options]
  --csv PATH              Private wallet CSV (required)
  --amount AMOUNT         FIST or "all" (default: all)
  --min-fist MIN          Skip below (default: 1)
  --slippage-bps BPS      Slippage (default: 100)
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minFist: 1, slippageBps: 100, gasPriceGwei: 3 },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-fist") { a.minFist = Number(argv[i + 1]); return i + 1; }
      if (arg === "--slippage-bps") { a.slippageBps = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

runPrivateBatch({
  scriptName: "fistSwapFISTToUSDT",
  chain: "bsc",
  extraParseArgs: parseArgs,
  confirmMessage: "\nProceed with FIST -> USDT swaps on Pancake? [y/N] ",
  printHeader({ args, csvPath, jobs }) {
    console.log("BSC FIST -> USDT (PancakeSwap V2, FIST pipeline step 10)");
    console.log(`  router:  ${FIST_BSC.PANCAKE_V2_ROUTER}`);
    console.log(`  CSV:     ${csvPath}`);
    console.log(`  wallets: ${jobs.length}`);
    console.log(`  slippage: ${args.slippageBps} bps`);
    console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  },
  async processWallet(provider, job, args) {
    const result = await swapFistToUsdt(provider, job, {
      amountArg: args.amount,
      minFistWei: parseUnits(String(args.minFist), FIST_BSC.FIST_DECIMALS),
      slippageBps: args.slippageBps,
      gasPrice: args.gasPrice,
      dryRun: args.dryRun,
    });
    if (result.status === "ok") {
      console.log(`  swap tx: ${result.swap_tx} (+${result.usdt_received} USDT)`);
    }
    return result;
  },
}).catch((e) => { console.error(e); process.exit(1); });
