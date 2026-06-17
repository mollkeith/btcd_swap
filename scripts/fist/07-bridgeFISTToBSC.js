#!/usr/bin/env node
/** Bridge FIST from PGP to BSC (step 7). */

import { parseUnits } from "ethers";
import { parseCommonFlags } from "../../lib/args.js";
import { bridgeFistToBsc } from "../../lib/fist/fistBridge.js";
import { runPrivateBatch } from "../../lib/fist/runPrivateBatch.js";
import { FIST_PGP } from "../../lib/fist/constants.js";

function printHelp() {
  console.log(`usage: node scripts/fist/07-bridgeFISTToBSC.js [options]
  --csv PATH              Private wallet CSV (required)
  --amount AMOUNT         FIST or "all" (default: all)
  --min-fist MIN          Skip below (default: 0.01)
  --recipient ADDRESS     BSC recipient (default: same wallet)
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minFist: 0.01, recipient: "" },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-fist") { a.minFist = Number(argv[i + 1]); return i + 1; }
      if (arg === "--recipient") { a.recipient = argv[i + 1]; return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

runPrivateBatch({
  scriptName: "fistBridgeToBSC",
  chain: "pgp",
  extraParseArgs: parseArgs,
  confirmMessage: "\nProceed with FIST bridge to BSC? [y/N] ",
  printHeader({ args, csvPath, jobs }) {
    console.log("PGP FIST -> BSC bridge (FIST pipeline step 7)");
    console.log(`  bridge:  ${FIST_PGP.BRIDGE}`);
    console.log(`  dest:    chain ${FIST_PGP.BRIDGE_DEST_CHAIN_ID}`);
    console.log(`  CSV:     ${csvPath}`);
    console.log(`  wallets: ${jobs.length}`);
    console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  },
  async processWallet(provider, job, args) {
    const result = await bridgeFistToBsc(provider, job, {
      amountArg: args.amount,
      minFistWei: parseUnits(String(args.minFist), FIST_PGP.FIST_DECIMALS),
      recipient: args.recipient,
      gasPrice: args.gasPrice,
      dryRun: args.dryRun,
    });
    if (result.status === "ok") {
      console.log(`  bridge tx: ${result.bridge_tx} (${result.fist_bridged} FIST)`);
      console.log("  note: BSC FIST arrival may take several minutes");
    }
    return result;
  },
}).catch((e) => { console.error(e); process.exit(1); });
