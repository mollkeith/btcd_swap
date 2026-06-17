#!/usr/bin/env node
/** Swap PGA -> USDT on PancakeSwap V2 BSC (PGA-coin step 9). */

import dotenv from "dotenv";
import { join } from "node:path";
import { Wallet, parseUnits } from "ethers";
import { PROJECT_ROOT } from "../../lib/paths.js";
import { DEFAULT_GAS } from "../../lib/constants.js";
import { confirmProceed, fmtAmount } from "../../lib/common.js";
import { parseCommonFlags } from "../../lib/args.js";
import { createLogger } from "../../lib/logger.js";
import { loadWalletsFromCsv } from "../../lib/wallet.js";
import { randomDelay } from "../../lib/random.js";
import { requireCsvPath } from "../../lib/walletCsv.js";
import { connectBscProvider } from "../../lib/provider.js";
import {
  previewPgaToUsdtSwap,
  swapPgaToUsdt,
  formatUsdtPerPga,
  estimateUsdtOut,
} from "../../lib/pga-coin/pancakeV2.js";
import { PGACOIN_BSC } from "../../lib/pga-coin/constants.js";

function printHelp() {
  console.log(`usage: node scripts/pga-coin/09-swapPGAToUSDT.js [options]
  --csv PATH              Private wallet CSV (required)
  --amount AMOUNT         PGA or "all" (default: all)
  --min-pga MIN           Skip below (default: 0.05)
  --slippage-bps BPS      Slippage in basis points (default: 600 = 6%)
  --slippage PCT          Slippage percent, e.g. 6 = 6% (overrides --slippage-bps)
                          NOTE: PGA has a ~3.5% on-transfer sell tax — slippage MUST
                          exceed it (use >= 5%), or the swap reverts.
  --delay-min / --delay-max
  --gas-price-gwei GWEI   BSC gas (default BSC_GAS_PRICE_GWEI)
  --dry-run  --yes
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: {
      amount: "all",
      minPga: 0.05,
      slippageBps: 600, // PGA has a ~3.5% sell tax; slippage must exceed it
      slippagePct: null,
      gasPriceGwei: DEFAULT_GAS.bscGwei,
    },
    onUnknown(arg, argv, i, a) {
      if (arg === "--amount") { a.amount = argv[i + 1]; return i + 1; }
      if (arg === "--min-pga") { a.minPga = Number(argv[i + 1]); return i + 1; }
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

  let provider;
  try {
    ({ provider } = await connectBscProvider());
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  args.gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const minPgaWei = parseUnits(String(args.minPga), PGACOIN_BSC.PGA_DECIMALS);
  const slippagePct = (args.slippageBps / 100).toFixed(2);

  console.log("BSC PGA -> USDT (PancakeSwap V2, PGA-coin pipeline step 9)");
  console.log(`  router:   ${PGACOIN_BSC.PANCAKE_V2_ROUTER}`);
  console.log(`  CSV:      ${csvPath}`);
  console.log(`  wallets:  ${jobs.length}`);
  console.log(`  slippage: ${slippagePct}% (${args.slippageBps} bps)`);
  console.log(`  mode:     ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  const previews = [];
  for (const job of jobs) {
    const preview = await previewPgaToUsdtSwap(provider, job, {
      amountArg: args.amount,
      minPgaWei,
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

  const onePga = parseUnits("1", PGACOIN_BSC.PGA_DECIMALS);
  const marketUsdtPerPga = await estimateUsdtOut(provider, onePga);
  const marketRate = formatUsdtPerPga(onePga, marketUsdtPerPga);

  console.log("\nMarket quote (PancakeSwap V2):");
  console.log(`  1 PGA ≈ ${marketRate} USDT`);

  console.log("\nSwap preview:");
  for (const p of previews) {
    if (p.status === "ready") {
      console.log(
        `  ${p.label} (${p.address})\n` +
          `    ${p.pga_in} PGA → ~${p.usdt_estimated} USDT ` +
          `(min ${p.usdt_min_out} USDT @ ${slippagePct}% slippage)`
      );
    } else {
      console.log(`  ${p.label} (${p.address}): skip — ${p.reason || p.status}`);
    }
  }

  const totalPga = ready.reduce((s, p) => s + p.pga_in_wei, 0n);
  const totalUsdt = ready.reduce((s, p) => s + p.usdt_estimated_wei, 0n);
  console.log(
    `\nTotal: ${ready.length} wallet(s), ` +
      `${fmtAmount(totalPga, PGACOIN_BSC.PGA_DECIMALS)} PGA → ~${fmtAmount(totalUsdt)} USDT (estimated)`
  );

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed(
      "\nProceed with PGA -> USDT swaps at the quotes above? [y/N] "
    );
    if (!ok) {
      console.log("aborted");
      process.exit(0);
    }
  }

  const logger = createLogger("pgacoinSwapPGAToUSDT", { projectRoot: PROJECT_ROOT });
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
      result = await swapPgaToUsdt(provider, job, {
        amountArg: args.amount,
        minPgaWei,
        slippageBps: args.slippageBps,
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
  const summaryPath = logger.writeSummary({ ok, skipped, failed, slippage_bps: args.slippageBps });

  console.log(`\nDone: ok=${ok}, skipped=${skipped}, failed=${failed}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
