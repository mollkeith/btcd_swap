#!/usr/bin/env node
/**
 * Master wallet sends BNB on BSC to each CSV address.
 */

import dotenv from "dotenv";
import { join } from "node:path";
import { PROJECT_ROOT } from "../lib/paths.js";
import { JsonRpcProvider, parseUnits } from "ethers";
import { BSC, DEFAULT_GAS } from "../lib/constants.js";
import { fmtAmount, confirmProceed, sendLegacyTx } from "../lib/common.js";
import { readWalletsCsv } from "../lib/csv.js";
import { parseCommonFlags } from "../lib/args.js";
import { createLogger } from "../lib/logger.js";
import { loadMasterWallet } from "../lib/wallet.js";
import { randomDelay } from "../lib/random.js";

function printHelp() {
  console.log(`usage: node transferBNBFee.js [options]

options:
  --csv PATH              Address CSV (default: data/wallets.csv)
  --bnb-amount BNB        BNB per address (default: 0.002, or BNB_FEE_AMOUNT in .env)
  --gas-limit LIMIT       Gas limit (default: 21000)
  --delay-min / --delay-max
  --gas-price-gwei GWEI   BSC gas price (default from BSC_GAS_PRICE_GWEI)
  --dry-run  --yes
  -h, --help
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: {
      csv: "data/wallets.csv",
      bnbAmount: process.env.BNB_FEE_AMOUNT || "0.002",
      gasLimit: DEFAULT_GAS.gasLimitBnbTransfer,
      gasPriceGwei: DEFAULT_GAS.bscGwei,
    },
    onUnknown(arg, argv, i, a) {
      if (arg === "--bnb-amount" || arg === "--amount") {
        a.bnbAmount = argv[i + 1]; return i + 1;
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

  const rows = readWalletsCsv(join(PROJECT_ROOT, args.csv), { requirePrivateKey: false });
  const provider = new JsonRpcProvider(BSC.RPC_URL, BSC.CHAIN_ID);
  await provider.getBlockNumber();

  const master = loadMasterWallet(provider);
  const amountWei = parseUnits(String(args.bnbAmount), 18);
  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const gasLimit = args.gasLimit;
  const gasCost = gasPrice * BigInt(gasLimit);

  console.log("Transfer BNB fee from master (BSC)");
  console.log(`  master:  ${master.address}`);
  console.log(`  RPC:     ${BSC.RPC_URL}`);
  console.log(`  amount:  ${args.bnbAmount} BNB each`);
  console.log(`  wallets: ${rows.length}`);
  console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed("\nProceed with BNB transfers? [y/N] ");
    if (!ok) { console.log("aborted"); process.exit(0); }
  }

  const logger = createLogger("transferBNBFee", { projectRoot: PROJECT_ROOT });
  const results = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    console.log(`\n[${idx + 1}/${rows.length}] -> ${row.address}`);

    let result = { index: row.index, address: row.address, bnb_amount: args.bnbAmount, status: "pending" };
    try {
      const masterBal = await provider.getBalance(master.address);
      if (masterBal < amountWei + gasCost) {
        result.status = "skipped";
        result.reason = `master BNB insufficient (need ~${fmtAmount(amountWei + gasCost)}, have ${fmtAmount(masterBal)})`;
        console.log(`  skipped: ${result.reason}`);
      } else {
        const hash = await sendLegacyTx(master, {
          to: row.address,
          value: amountWei,
          gasLimit,
          gasPrice,
          chainId: BSC.CHAIN_ID,
          type: 0,
        }, { dryRun: args.dryRun });
        const masterAfter = await provider.getBalance(master.address);
        result = { ...result, status: "ok", tx: hash, master_bnb_after: fmtAmount(masterAfter) };
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
  });

  console.log(`\nMaster BNB balance: ${fmtAmount(await provider.getBalance(master.address))}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(results.some((r) => r.status === "failed") ? 2 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
