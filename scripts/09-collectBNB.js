#!/usr/bin/env node
/**
 * Collect remaining BNB from BSC wallets to COLLECT_ADDRESS or master wallet.
 * Sends balance minus gas; skips wallets with nothing left after gas reserve.
 */

import dotenv from "dotenv";
import { join } from "node:path";
import { PROJECT_ROOT } from "../lib/paths.js";
import { Wallet, parseUnits } from "ethers";
import { BSC, DEFAULT_GAS } from "../lib/constants.js";
import { connectBscProvider } from "../lib/provider.js";
import { fmtAmount, confirmProceed, sendLegacyTx } from "../lib/common.js";
import { parseCommonFlags } from "../lib/args.js";
import { createLogger } from "../lib/logger.js";
import { loadWalletsFromCsv, loadMasterWallet, getCollectAddress } from "../lib/wallet.js";
import { randomDelay } from "../lib/random.js";
import { requireCsvPath } from "../lib/walletCsv.js";

function printHelp() {
  console.log(`usage: node scripts/09-collectBNB.js [options]

options:
  --csv PATH              Wallet CSV with private keys (required)
  --min-bnb MIN           Skip if collectible BNB below (default: 0.00001)
  --gas-limit LIMIT       Gas limit (default: 21000)
  --delay-min / --delay-max
  --gas-price-gwei GWEI   BSC gas (default BSC_GAS_PRICE_GWEI)
  --dry-run  --yes
  -h, --help

Collector: COLLECT_ADDRESS in .env, or master wallet address.
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: {
      minBnb: 0.00001,
      gasLimit: DEFAULT_GAS.gasLimitBnbTransfer,
      gasPriceGwei: DEFAULT_GAS.bscGwei,
    },
    onUnknown(arg, argv, i, a) {
      if (arg === "--min-bnb") { a.minBnb = Number(argv[i + 1]); return i + 1; }
      if (arg === "--gas-limit") { a.gasLimit = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  return args;
}

function collectibleBnb(bnbBal, gasCost) {
  return bnbBal > gasCost ? bnbBal - gasCost : 0n;
}

async function main() {
  dotenv.config({ path: join(PROJECT_ROOT, ".env") });

  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`error: ${err.message}`); process.exit(1); }

  let provider;
  let bscRpcUrl;
  try {
    ({ provider, rpcUrl: bscRpcUrl } = await connectBscProvider());
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  const master = loadMasterWallet(provider);
  const collectAddress = getCollectAddress(master);

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

  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const gasCost = gasPrice * BigInt(args.gasLimit);
  const minCollectWei = parseUnits(String(args.minBnb), 18);

  console.log("Collect BNB on BSC");
  console.log(`  collector:  ${collectAddress}`);
  console.log(`  RPC:        ${bscRpcUrl}`);
  console.log(`  CSV:        ${csvPath}`);
  console.log(`  wallets:    ${jobs.length}`);
  console.log(`  gas price:  ${args.gasPriceGwei} gwei`);
  console.log(`  gas/reserve: ~${fmtAmount(gasCost)} BNB per tx`);
  console.log(`  min collect: ${args.minBnb} BNB`);
  console.log(`  mode:       ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  const plans = [];
  for (const job of jobs) {
    const wallet = new Wallet(job.privateKey, provider);
    const bnbBal = await provider.getBalance(wallet.address);
    const sendValue = collectibleBnb(bnbBal, gasCost);
    plans.push({
      label: job.label,
      address: wallet.address,
      job,
      bnb_before: bnbBal,
      send_value: sendValue,
      status: sendValue >= minCollectWei ? "ready" : "skipped",
      reason:
        sendValue === 0n
          ? `BNB insufficient for gas (have ${fmtAmount(bnbBal)}, need ~${fmtAmount(gasCost)})`
          : sendValue < minCollectWei
            ? `collectible below min (${fmtAmount(sendValue)} < ${args.minBnb})`
            : null,
    });
  }

  const ready = plans.filter((p) => p.status === "ready");
  console.log("\nCollection plan:");
  for (const p of plans) {
    if (p.status === "ready") {
      console.log(
        `  ${p.label} (${p.address}) -> ${fmtAmount(p.send_value)} BNB ` +
          `(balance ${fmtAmount(p.bnb_before)})`
      );
    } else {
      console.log(`  ${p.label} (${p.address}): skip — ${p.reason}`);
    }
  }

  const totalCollect = ready.reduce((s, p) => s + p.send_value, 0n);
  console.log(`\nTotal: ${ready.length} wallet(s), ~${fmtAmount(totalCollect)} BNB`);

  if (ready.length === 0) {
    console.log("\nNothing to collect.");
    process.exit(0);
  }

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed("\nProceed with BNB collection? [y/N] ");
    if (!ok) { console.log("aborted"); process.exit(0); }
  }

  const logger = createLogger("collectBNB", { projectRoot: PROJECT_ROOT });
  const results = [];

  for (let idx = 0; idx < plans.length; idx += 1) {
    const plan = plans[idx];
    const wallet = new Wallet(plan.job.privateKey, provider);
    console.log(`\n[${idx + 1}/${plans.length}] ${plan.label} (${plan.address})`);

    const result = {
      label: plan.label,
      address: plan.address,
      collector: collectAddress,
      bnb_before: fmtAmount(plan.bnb_before),
      status: "skipped",
    };

    if (plan.status !== "ready") {
      result.reason = plan.reason;
      console.log(`  skipped: ${plan.reason}`);
      results.push(result);
      logger.append(result);
      continue;
    }

    try {
      const hash = await sendLegacyTx(wallet, {
        to: collectAddress,
        value: plan.send_value,
        gasLimit: args.gasLimit,
        gasPrice,
        chainId: BSC.CHAIN_ID,
        type: 0,
      }, { dryRun: args.dryRun });

      result.status = "ok";
      result.bnb_collected = fmtAmount(plan.send_value);
      result.bnb_tx = hash;
      result.bnb_after = fmtAmount(await provider.getBalance(wallet.address));
      console.log(`  tx: ${hash} (${result.bnb_collected} BNB)`);
    } catch (err) {
      result.status = "failed";
      result.error = err.message;
      console.log(`  FAILED: ${err.message}`);
    }

    results.push(result);
    logger.append(result);
    if (idx < plans.length - 1) await randomDelay(args.delayMin, args.delayMax);
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const summaryPath = logger.writeSummary({
    ok,
    skipped,
    failed,
    collector: collectAddress,
    total_collected: fmtAmount(totalCollect),
  });

  console.log(`\nDone: ok=${ok}, skipped=${skipped}, failed=${failed}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
