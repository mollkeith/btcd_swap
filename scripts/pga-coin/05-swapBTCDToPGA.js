#!/usr/bin/env node
/** Swap BTCD -> native PGA on PGARouterV2 via FastSwapTokenToEth (PGA-coin step 5). */

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
  previewBtcdToPgaSwap,
  swapBtcdToPga,
  formatPgaPerBtcd,
  estimatePgaOut,
} from "../../lib/pga-coin/pgaSwap.js";
import { PGACOIN_PGP } from "../../lib/pga-coin/constants.js";

function printHelp() {
  console.log(`usage: node scripts/pga-coin/05-swapBTCDToPGA.js [options]
  --csv PATH              Private wallet CSV (required)
  --amount AMOUNT         BTCD or "all" (default: all)
  --min-btcd MIN          Skip below (default: 0.01)
  --slippage-bps BPS      Slippage in basis points (default: 100 = 1%)
  --slippage PCT          Slippage percent, e.g. 1 = 1% (overrides --slippage-bps)
  --delay-min / --delay-max
  --gas-price-gwei GWEI
  --dry-run  --yes
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: { amount: "all", minBtcd: 0.01, slippageBps: 100, slippagePct: null },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-btcd") { a.minBtcd = Number(argv[i + 1]); return i + 1; }
      if (arg === "--slippage-bps") { a.slippageBps = Number(argv[i + 1]); return i + 1; }
      if (arg === "--slippage") { a.slippagePct = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  if (args.slippagePct !== null) {
    if (args.slippagePct < 0 || args.slippagePct > 50) {
      throw new Error("--slippage must be between 0 and 50 (percent)");
    }
    args.slippageBps = Math.round(args.slippagePct * 100);
  }
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

  args.gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const minBtcdWei = parseUnits(String(args.minBtcd), 18);
  const slippagePct = (args.slippageBps / 100).toFixed(2);

  console.log("PGP BTCD -> native PGA swap (PGA-coin pipeline step 5)");
  console.log(`  router:   ${PGACOIN_PGP.ROUTER}`);
  console.log(`  CSV:      ${csvPath}`);
  console.log(`  wallets:  ${jobs.length}`);
  console.log(`  slippage: ${slippagePct}% (${args.slippageBps} bps)`);
  console.log(`  mode:     ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  const previews = [];
  for (const job of jobs) {
    const preview = await previewBtcdToPgaSwap(provider, job, {
      amountArg: args.amount,
      minBtcdWei,
      slippageBps: args.slippageBps,
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
  const marketPgaPerBtcd = await estimatePgaOut(provider, oneBtcd);
  const marketRate = formatPgaPerBtcd(oneBtcd, marketPgaPerBtcd);

  console.log("\nMarket quote (PGARouterV2 [BTCD, WPGA]):");
  console.log(`  1 BTCD ≈ ${marketRate} PGA`);

  console.log("\nSwap preview:");
  for (const p of previews) {
    if (p.status === "ready") {
      console.log(
        `  ${p.label} (${p.address})\n` +
          `    ${p.btcd_in} BTCD → ~${p.pga_estimated} PGA ` +
          `(min ${p.pga_min_out} PGA @ ${slippagePct}% slippage)`
      );
    } else {
      console.log(`  ${p.label} (${p.address}): skip — ${p.reason || p.status}`);
    }
  }

  const totalBtcd = ready.reduce((s, p) => s + p.btcd_in_wei, 0n);
  const totalPga = ready.reduce((s, p) => s + p.pga_estimated_wei, 0n);
  console.log(
    `\nTotal: ${ready.length} wallet(s), ` +
      `${fmtAmount(totalBtcd)} BTCD → ~${fmtAmount(totalPga)} PGA (estimated)`
  );

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed(
      "\nProceed with BTCD -> PGA swaps at the quotes above? [y/N] "
    );
    if (!ok) {
      console.log("aborted");
      process.exit(0);
    }
  }

  const logger = createLogger("pgacoinSwapBTCDToPGA", { projectRoot: PROJECT_ROOT });
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
      result = await swapBtcdToPga(provider, job, {
        amountArg: args.amount,
        minBtcdWei,
        slippageBps: args.slippageBps,
        gasPrice: args.gasPrice,
        dryRun: args.dryRun,
      });
      if (result.status === "ok") {
        console.log(`  swap tx: ${result.swap_tx} (~${result.pga_estimated} PGA, balance ${result.pga_after})`);
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
  const summaryPath = logger.writeSummary({ ok, skipped, failed, slippage_bps: args.slippageBps });

  console.log(`\nDone: ok=${ok}, skipped=${skipped}, failed=${failed}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
