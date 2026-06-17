#!/usr/bin/env node
/** Bridge USDT from PGP to BSC (PGA pipeline step 7). */

import { parseUnits } from "ethers";
import { parseCommonFlags } from "../../lib/args.js";
import { bridgeUsdtToBsc } from "../../lib/pga/usdtBridge.js";
import { runPrivateBatch } from "../../lib/fist/runPrivateBatch.js";
import { PGA_PIPELINE } from "../../lib/pga/constants.js";

function printHelp() {
  console.log(`usage: node scripts/pga/07-bridgeUSDTToBSC.js [options]
  --csv PATH              Private wallet CSV (required)
  --amount AMOUNT         USDT or "all" (default: all)
  --min-usdt MIN          Skip below (default: 0.01)
  --recipient ADDRESS     BSC recipient (default: same wallet)
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minUsdt: 0.01, recipient: "" },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-usdt") { a.minUsdt = Number(argv[i + 1]); return i + 1; }
      if (arg === "--recipient") { a.recipient = argv[i + 1]; return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

runPrivateBatch({
  scriptName: "pgaBridgeUSDTToBSC",
  chain: "pgp",
  extraParseArgs: parseArgs,
  confirmMessage: "\nProceed with USDT bridge to BSC? [y/N] ",
  printHeader({ args, csvPath, jobs }) {
    console.log("PGP USDT -> BSC bridge (PGA pipeline step 7)");
    console.log(`  bridge:  ${PGA_PIPELINE.BRIDGE}`);
    console.log(`  dest:    chain ${PGA_PIPELINE.BRIDGE_DEST_CHAIN_ID}`);
    console.log(`  CSV:     ${csvPath}`);
    console.log(`  wallets: ${jobs.length}`);
    console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  },
  async processWallet(provider, job, args) {
    const result = await bridgeUsdtToBsc(provider, job, {
      amountArg: args.amount,
      minUsdtWei: parseUnits(String(args.minUsdt), 18),
      recipient: args.recipient,
      gasPrice: args.gasPrice,
      dryRun: args.dryRun,
    });
    if (result.status === "ok") {
      console.log(`  bridge tx: ${result.bridge_tx} (${result.usdt_bridged} USDT)`);
      console.log("  note: BSC USDT arrival may take several minutes");
    }
    return result;
  },
}).catch((e) => { console.error(e); process.exit(1); });
