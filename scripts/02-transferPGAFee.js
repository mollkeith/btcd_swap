#!/usr/bin/env node
/**
 * Master wallet sends PGA (native token) to each address in CSV.
 * Ref: https://pgp.elastos.io/tx/0xbb401471a4a20d989b2af55a9d41feb55218618d3ae6d0d69d8e44360db63197
 */

import dotenv from "dotenv";
import { join } from "node:path";
import { PROJECT_ROOT } from "../lib/paths.js";
import { JsonRpcProvider, parseUnits } from "ethers";
import { PGP, DEFAULT_GAS } from "../lib/constants.js";
import { fmtAmount, confirmProceed, sendLegacyTx } from "../lib/common.js";
import { readWalletsCsv } from "../lib/csv.js";
import { parseCommonFlags } from "../lib/args.js";
import { createLogger } from "../lib/logger.js";
import { loadMasterWallet } from "../lib/wallet.js";
import { randomDelay } from "../lib/random.js";
import { requireCsvPath } from "../lib/walletCsv.js";

function printHelp() {
  console.log(`usage: node transferPGAFee.js [options]

options:
  --csv PATH              Wallet CSV (required)
  --pga-amount PGA        PGA per address (default: 2, or PGA_FEE_AMOUNT in .env)
  --gas-limit LIMIT       Gas limit (default: 31500)
  --delay-min / --delay-max
  --gas-price-gwei GWEI
  --dry-run  --yes
  -h, --help
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: {
      pgaAmount: process.env.PGA_FEE_AMOUNT || "2",
      gasLimit: DEFAULT_GAS.gasLimitPgaTransfer,
    },
    onUnknown(arg, argv, i, a) {
      if (arg === "--pga-amount" || arg === "--amount") {
        a.pgaAmount = argv[i + 1]; return i + 1;
      }
      if (arg === "--gas-limit") { a.gasLimit = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

async function main() {
  dotenv.config({ path: join(PROJECT_ROOT, ".env") });
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`error: ${err.message}`); process.exit(1); }

let csvPath;
  try {
    csvPath = join(PROJECT_ROOT, requireCsvPath(args));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  const rows = readWalletsCsv(csvPath, { requirePrivateKey: false });
  const provider = new JsonRpcProvider(PGP.RPC_URL, PGP.CHAIN_ID);
  await provider.getBlockNumber();

  const master = loadMasterWallet(provider);
  const amountWei = parseUnits(String(args.pgaAmount), 18);
  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const gasLimit = args.gasLimit;
  const gasCost = gasPrice * BigInt(gasLimit);
  const totalNeeded = (amountWei + gasCost) * BigInt(rows.length);

  console.log("Transfer PGA (native) from master");
  console.log(`  master:  ${master.address}`);
  console.log(`  amount:  ${args.pgaAmount} PGA each`);
  console.log(`  gas:     limit=${gasLimit} price=${args.gasPriceGwei} gwei`);
  console.log(`  wallets: ${rows.length}`);
  console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed("\nProceed with PGA transfers? [y/N] ");
    if (!ok) { console.log("aborted"); process.exit(0); }
  }

  const logger = createLogger("transferPGAFee", { projectRoot: PROJECT_ROOT });
  const results = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    console.log(`\n[${idx + 1}/${rows.length}] -> ${row.address}`);

    let result = { index: row.index, address: row.address, pga_amount: args.pgaAmount, status: "pending" };
    try {
      const masterBal = await provider.getBalance(master.address);
      if (masterBal < amountWei + gasCost) {
        result.status = "skipped";
        result.reason = `master PGA insufficient (need ~${fmtAmount(amountWei + gasCost)}, have ${fmtAmount(masterBal)})`;
        console.log(`  skipped: ${result.reason}`);
      } else {
        const hash = await sendLegacyTx(master, {
          to: row.address,
          value: amountWei,
          gasLimit,
          gasPrice,
          chainId: PGP.CHAIN_ID,
          type: 0,
        }, { dryRun: args.dryRun });
        const masterAfter = await provider.getBalance(master.address);
        result = { ...result, status: "ok", tx: hash, master_pga_after: fmtAmount(masterAfter) };
        console.log(`  tx: ${hash}`);
      }
    } catch (err) {
      result = { ...result, status: "failed", error: err.message };
      console.log(`  FAILED: ${err.message}`);
    }

    results.push(result);
    logger.append(result);
    if (idx < rows.length - 1) await randomDelay(args.delayMin, args.delayMax);
  }

  const summaryPath = logger.writeSummary({
    ok: results.filter((r) => r.status === "ok").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    total_pga_needed: fmtAmount(totalNeeded),
  });

  console.log(`\nMaster PGA balance: ${fmtAmount(await provider.getBalance(master.address))}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(results.some((r) => r.status === "failed") ? 2 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
