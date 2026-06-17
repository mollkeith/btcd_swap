#!/usr/bin/env node
/** Approve PGA (BSC) for PancakeSwap V2 (PGA-coin step 8). */

import { parseUnits } from "ethers";
import { parseCommonFlags } from "../../lib/args.js";
import { DEFAULT_GAS } from "../../lib/constants.js";
import { approvePgaForPancake } from "../../lib/pga-coin/pancakeV2.js";
import { runPrivateBatch } from "../../lib/fist/runPrivateBatch.js";
import { PGACOIN_BSC } from "../../lib/pga-coin/constants.js";

function printHelp() {
  console.log(`usage: node scripts/pga-coin/08-approvePGABSC.js [options]
  --csv PATH          Private wallet CSV (required)
  --amount AMOUNT     PGA to approve or "all" (default: all)
  --min-pga MIN       Skip below this PGA (default: 0.05)
  --gas-price-gwei GWEI  BSC gas (default BSC_GAS_PRICE_GWEI)
  --dry-run  --yes
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minPga: 0.05, gasPriceGwei: DEFAULT_GAS.bscGwei },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-pga") { a.minPga = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

runPrivateBatch({
  scriptName: "pgacoinApprovePGABSC",
  chain: "bsc",
  extraParseArgs: parseArgs,
  confirmMessage: "\nProceed with PGA (BSC) approve transactions? [y/N] ",
  printHeader({ args, csvPath, jobs }) {
    console.log("Approve PGA for PancakeSwap V2 (PGA-coin pipeline step 8)");
    console.log(`  router:  ${PGACOIN_BSC.PANCAKE_V2_ROUTER}`);
    console.log(`  CSV:     ${csvPath}`);
    console.log(`  wallets: ${jobs.length}`);
    console.log(`  amount:  ${args.amount}`);
    console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  },
  async processWallet(provider, job, args) {
    const result = await approvePgaForPancake(provider, job, {
      amountArg: args.amount,
      minPgaWei: parseUnits(String(args.minPga), PGACOIN_BSC.PGA_DECIMALS),
      gasPrice: args.gasPrice,
      dryRun: args.dryRun,
    });
    if (result.status === "ok") {
      if (result.approve_tx) console.log(`  approve tx: ${result.approve_tx}`);
      else console.log(`  allowance already sufficient for ${result.pga_approved} PGA`);
    }
    return result;
  },
}).catch((e) => { console.error(e); process.exit(1); });
