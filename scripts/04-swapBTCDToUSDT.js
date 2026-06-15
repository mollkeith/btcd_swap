#!/usr/bin/env node
/**
 * Swap all BTCD to USDT for wallets in private CSV.
 * Use --no-swap to preview balances only.
 */

import dotenv from "dotenv";
import { join } from "node:path";
import { PROJECT_ROOT } from "../lib/paths.js";
import { JsonRpcProvider, Wallet, parseUnits } from "ethers";
import { PGP } from "../lib/constants.js";
import { confirmProceed } from "../lib/common.js";
import { parseCommonFlags } from "../lib/args.js";
import { createLogger } from "../lib/logger.js";
import { loadWalletsFromCsv } from "../lib/wallet.js";
import { randomDelay } from "../lib/random.js";
import { requireCsvPath } from "../lib/walletCsv.js";
import { readFeeBps, processSwapWallet, previewWalletBalances } from "../lib/swap.js";

function printHelp() {
  console.log(`usage: node swapBTCDToUSDT.js [options]

options:
  --csv PATH              Wallet CSV (required)
  --amount AMOUNT         BTCD per wallet or "all" (default: all)
  --min-btcd MIN          Skip below this BTCD (default: 0.01)
  --no-swap               Preview balances only, no transactions
  --delay-min / --delay-max
  --gas-price-gwei GWEI
  --dry-run  --yes
  -h, --help
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minBtcd: 0.01, doSwap: true },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-btcd") { a.minBtcd = Number(argv[i + 1]); return i + 1; }
      if (arg === "--no-swap") { a.doSwap = false; return true; }
      if (arg === "--swap") { a.doSwap = true; return true; }
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
  let jobs;
  try { jobs = loadWalletsFromCsv(csvPath); }
  catch (err) { console.error(`error: ${err.message}`); process.exit(1); }

  const provider = new JsonRpcProvider(PGP.RPC_URL, PGP.CHAIN_ID);
  try { await provider.getBlockNumber(); }
  catch { console.error(`error: cannot connect to RPC ${PGP.RPC_URL}`); process.exit(1); }

  const minBtcdWei = parseUnits(String(args.minBtcd), 18);
  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const feeBps = args.doSwap ? await readFeeBps(provider) : 0;

  console.log("PGP BTCD -> USDT batch swap (CSV)");
  console.log(`  CSV:     ${csvPath}`);
  console.log(`  wallets: ${jobs.length}`);
  console.log(`  amount:  ${args.amount}`);
  console.log(`  swap:    ${args.doSwap}`);
  console.log(`  mode:    ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  if (args.doSwap && !args.yes && !args.dryRun) {
    const ok = await confirmProceed("\nProceed with live swaps? [y/N] ");
    if (!ok) { console.log("aborted"); process.exit(0); }
  }

  const logger = createLogger("swapBTCDToUSDT", { projectRoot: PROJECT_ROOT });
  const results = [];

  for (let idx = 0; idx < jobs.length; idx += 1) {
    const job = jobs[idx];
    const w = new Wallet(job.privateKey);
    console.log(`\n[${idx + 1}/${jobs.length}] ${job.label} (${w.address})`);

    let result;
    try {
      if (!args.doSwap) {
        result = await previewWalletBalances(provider, job);
        console.log(`  BTCD=${result.btcd} USDT=${result.usdt} PGA=${result.pga}`);
      } else {
        result = await processSwapWallet(provider, job, {
          amountArg: args.amount,
          minBtcdWei,
          feeBps,
          gasPrice,
          dryRun: args.dryRun,
        });
        if (result.status === "ok") {
          console.log(`  swap tx: ${result.swap_tx} (+${result.usdt_received} USDT)`);
        } else {
          console.log(`  ${result.status}: ${result.reason || ""}`);
        }
      }
    } catch (err) {
      result = { label: job.label, address: w.address, status: "failed", error: err.message };
      console.log(`  FAILED: ${err.message}`);
    }

    results.push(result);
    logger.append(result);
    if (idx < jobs.length - 1) await randomDelay(args.delayMin, args.delayMax);
  }

  const ok = results.filter((r) => r.status === "ok" || r.status === "preview").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const summaryPath = logger.writeSummary({ ok, skipped, failed });

  console.log(`\nDone: ok=${ok}, skipped=${skipped}, failed=${failed}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
