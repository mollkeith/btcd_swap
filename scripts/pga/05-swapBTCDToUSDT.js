#!/usr/bin/env node
/** Swap BTCD -> USDT on PGP swap contract (PGA pipeline step 5). */

import dotenv from "dotenv";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, parseUnits } from "ethers";
import { PROJECT_ROOT } from "../../lib/paths.js";
import { PGP } from "../../lib/constants.js";
import { confirmProceed, fmtAmount } from "../../lib/common.js";
import { parseCommonFlags } from "../../lib/args.js";
import { createLogger } from "../../lib/logger.js";
import { loadWalletsFromCsv } from "../../lib/wallet.js";
import { randomDelay } from "../../lib/random.js";
import { requireCsvPath } from "../../lib/walletCsv.js";
import {
  previewBtcdToUsdtSwap,
  swapBtcdToUsdt,
  readFeeBps,
  estimateUsdtOut,
  formatUsdtPerBtcd,
} from "../../lib/pga/swapContract.js";
import { PGA_PIPELINE } from "../../lib/pga/constants.js";

function printHelp() {
  console.log(`usage: node scripts/pga/05-swapBTCDToUSDT.js [options]
  --csv PATH              Private wallet CSV (required)
  --amount AMOUNT         BTCD or "all" (default: all)
  --min-btcd MIN          Skip below (default: 0.01)
  --delay-min / --delay-max
  --gas-price-gwei GWEI
  --dry-run  --yes
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minBtcd: 0.01 },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-btcd") { a.minBtcd = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

async function main() {
  dotenv.config({ path: join(PROJECT_ROOT, ".env") });

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  let csvPath;
  try {
    csvPath = join(PROJECT_ROOT, requireCsvPath(args));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  let jobs;
  try {
    jobs = loadWalletsFromCsv(csvPath);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  const provider = new JsonRpcProvider(PGP.RPC_URL, PGP.CHAIN_ID);
  try {
    await provider.getBlockNumber();
  } catch {
    console.error(`error: cannot connect to RPC ${PGP.RPC_URL}`);
    process.exit(1);
  }

  const feeBps = await readFeeBps(provider, PGA_PIPELINE.SWAP_CONTRACT);
  args.gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const minBtcdWei = parseUnits(String(args.minBtcd), 18);

  console.log("PGP BTCD -> USDT swap (PGA pipeline step 5)");
  console.log(`  swap:     ${PGA_PIPELINE.SWAP_CONTRACT}`);
  console.log(`  CSV:      ${csvPath}`);
  console.log(`  wallets:  ${jobs.length}`);
  console.log(`  fee:      ${feeBps} bps (${(feeBps / 100).toFixed(2)}%)`);
  console.log(`  mode:     ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  const previews = [];
  for (const job of jobs) {
    const preview = await previewBtcdToUsdtSwap(provider, job, {
      amountArg: args.amount,
      minBtcdWei,
      feeBps,
    });
    previews.push(preview);
  }

  const ready = previews.filter((p) => p.status === "ready");
  if (ready.length === 0) {
    console.log("\nNo wallets ready to swap.");
    for (const p of previews) {
      console.log(`  ${p.label} (${p.address}): ${p.reason || p.status}`);
    }
    process.exit(0);
  }

  const oneBtcd = parseUnits("1", 18);
  const marketUsdtPerBtcd = estimateUsdtOut(oneBtcd, feeBps);
  const marketRate = formatUsdtPerBtcd(oneBtcd, marketUsdtPerBtcd);

  console.log("\nMarket quote (swap contract):");
  console.log(`  1 BTCD ≈ ${marketRate} USDT (after ${feeBps} bps fee)`);

  console.log("\nSwap preview:");
  for (const p of previews) {
    if (p.status === "ready") {
      console.log(
        `  ${p.label} (${p.address})\n` +
          `    ${p.btcd_in} BTCD → ~${p.usdt_estimated} USDT`
      );
    } else {
      console.log(`  ${p.label} (${p.address}): skip — ${p.reason || p.status}`);
    }
  }

  const totalBtcd = ready.reduce((s, p) => s + p.btcd_in_wei, 0n);
  const totalUsdt = ready.reduce((s, p) => s + p.usdt_estimated_wei, 0n);
  console.log(
    `\nTotal: ${ready.length} wallet(s), ` +
      `${fmtAmount(totalBtcd)} BTCD → ~${fmtAmount(totalUsdt)} USDT (estimated)`
  );

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed(
      "\nProceed with BTCD -> USDT swaps at the quotes above? [y/N] "
    );
    if (!ok) {
      console.log("aborted");
      process.exit(0);
    }
  }

  const logger = createLogger("pgaSwapBTCDToUSDT", { projectRoot: PROJECT_ROOT });
  const results = [];

  for (let idx = 0; idx < jobs.length; idx += 1) {
    const job = jobs[idx];
    const preview = previews[idx];
    const w = new Wallet(job.privateKey);
    console.log(`\n[${idx + 1}/${jobs.length}] ${job.label} (${w.address})`);

    if (preview.status !== "ready") {
      console.log(`  skipped: ${preview.reason || preview.status}`);
      results.push(preview);
      logger.append(preview);
      continue;
    }

    let result;
    try {
      result = await swapBtcdToUsdt(provider, job, {
        amountArg: args.amount,
        minBtcdWei,
        feeBps,
        gasPrice: args.gasPrice,
        dryRun: args.dryRun,
      });
      if (result.status === "ok") {
        console.log(`  swap tx: ${result.swap_tx} (+${result.usdt_received} USDT)`);
      } else {
        console.log(`  ${result.status}: ${result.reason || ""}`);
      }
    } catch (err) {
      result = { label: job.label, address: w.address, status: "failed", error: err.message };
      console.log(`  FAILED: ${err.message}`);
    }

    results.push(result);
    logger.append(result);
    if (idx < jobs.length - 1) await randomDelay(args.delayMin, args.delayMax);
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const summaryPath = logger.writeSummary({ ok, skipped, failed, fee_bps: feeBps });

  console.log(`\nDone: ok=${ok}, skipped=${skipped}, failed=${failed}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
