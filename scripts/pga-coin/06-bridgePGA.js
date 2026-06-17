#!/usr/bin/env node
/** Bridge native PGA from PGP to BSC via BridgeEth (PGA-coin step 6). */

import { parseUnits } from "ethers";
import { parseCommonFlags } from "../../lib/args.js";
import { bridgePgaToBsc } from "../../lib/pga-coin/pgaBridge.js";
import { runPrivateBatch } from "../../lib/fist/runPrivateBatch.js";
import { PGACOIN_PGP } from "../../lib/pga-coin/constants.js";

function printHelp() {
  console.log(`usage: node scripts/pga-coin/06-bridgePGA.js [options]
  --csv PATH              Private wallet CSV (required)
  --amount AMOUNT         PGA to bridge or "all" (default: all; "all" = balance - gas reserve)
  --min-pga MIN           Skip if bridgeable below this (default: 0.05)
  --reserve PGA           Keep this much PGA for gas (default: ~2x bridge tx gas)
  --recipient ADDRESS     BSC recipient (default: same wallet)
  --delay-min / --delay-max
  --gas-price-gwei GWEI
  --dry-run  --yes

note: PGA is both the bridged asset and the gas token, so "all" leaves a gas reserve.
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minPga: 0.05, reserve: null, recipient: "" },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-pga") { a.minPga = Number(argv[i + 1]); return i + 1; }
      if (arg === "--reserve") { a.reserve = argv[i + 1]; return i + 1; }
      if (arg === "--recipient") { a.recipient = argv[i + 1]; return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

runPrivateBatch({
  scriptName: "pgacoinBridgePGA",
  chain: "pgp",
  extraParseArgs: parseArgs,
  confirmMessage: "\nProceed with PGA bridge to BSC? [y/N] ",
  printHeader({ args, csvPath, jobs }) {
    console.log("PGP native PGA -> BSC bridge (PGA-coin pipeline step 6)");
    console.log(`  bridge:  ${PGACOIN_PGP.BRIDGE}  (BridgeEth, payable)`);
    console.log(`  dest:    chain ${PGACOIN_PGP.BRIDGE_DEST_CHAIN_ID}`);
    console.log(`  reserve: ${args.reserve !== null ? `${args.reserve} PGA` : "auto (~2x gas)"}`);
    console.log(`  CSV:     ${csvPath}`);
    console.log(`  wallets: ${jobs.length}`);
    console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  },
  async processWallet(provider, job, args) {
    const result = await bridgePgaToBsc(provider, job, {
      amountArg: args.amount,
      minPgaWei: parseUnits(String(args.minPga), PGACOIN_PGP.PGA_DECIMALS),
      reserveWei: args.reserve !== null ? parseUnits(String(args.reserve), PGACOIN_PGP.PGA_DECIMALS) : undefined,
      recipient: args.recipient,
      gasPrice: args.gasPrice,
      dryRun: args.dryRun,
    });
    if (result.status === "ok") {
      console.log(`  bridge tx: ${result.bridge_tx} (${result.pga_bridged} PGA, reserved ${result.pga_reserved})`);
      console.log("  note: BSC PGA arrival may take several minutes");
    }
    return result;
  },
}).catch((e) => { console.error(e); process.exit(1); });
