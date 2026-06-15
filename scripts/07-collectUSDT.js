#!/usr/bin/env node
/**
 * Collect USDT (and optionally BNB) from BSC wallets to COLLECT_ADDRESS or master wallet.
 */

import dotenv from "dotenv";
import { join } from "node:path";
import { PROJECT_ROOT } from "../lib/paths.js";
import { Contract, JsonRpcProvider, Wallet, parseUnits } from "ethers";
import { BSC, DEFAULT_GAS, ERC20_ABI } from "../lib/constants.js";
import { fmtAmount, confirmProceed, sendLegacyTx } from "../lib/common.js";
import { parseCommonFlags } from "../lib/args.js";
import { createLogger } from "../lib/logger.js";
import { loadWalletsFromCsv, loadMasterWallet, getCollectAddress } from "../lib/wallet.js";
import { randomDelay } from "../lib/random.js";

function printHelp() {
  console.log(`usage: node collectUSDT.js [options]

options:
  --csv PATH              Private key CSV (default: data/wallets-private.csv)
  --collect-bnb           Also send remaining BNB (minus gas) to collector
  --min-usdt MIN          Skip if USDT below (default: 0.01)
  --delay-min / --delay-max
  --gas-price-gwei GWEI   BSC gas (default BSC_GAS_PRICE_GWEI)
  --dry-run  --yes
  -h, --help
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: {
      collectBnb: false,
      minUsdt: 0.01,
      gasPriceGwei: DEFAULT_GAS.bscGwei,
    },
    onUnknown(arg, argv, i, a) {
      if (arg === "--collect-bnb") { a.collectBnb = true; return true; }
      if (arg === "--min-usdt") { a.minUsdt = Number(argv[i + 1]); return i + 1; }
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

  const provider = new JsonRpcProvider(BSC.RPC_URL, BSC.CHAIN_ID);
  await provider.getBlockNumber();

  const master = loadMasterWallet(provider);
  const collectAddress = getCollectAddress(master);

  const csvPath = join(PROJECT_ROOT, args.csv);
  let jobs;
  try { jobs = loadWalletsFromCsv(csvPath); }
  catch (err) { console.error(`error: ${err.message}`); process.exit(1); }

  const minUsdtWei = parseUnits(String(args.minUsdt), 18);
  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const gasLimitTransfer = DEFAULT_GAS.gasLimitTransfer;
  const gasLimitBnb = DEFAULT_GAS.gasLimitBnbTransfer;

  console.log("Collect USDT on BSC");
  console.log(`  collector: ${collectAddress}`);
  console.log(`  CSV:       ${csvPath}`);
  console.log(`  wallets:   ${jobs.length}`);
  console.log(`  collect BNB: ${args.collectBnb}`);
  console.log(`  mode:      ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed("\nProceed with collection transfers? [y/N] ");
    if (!ok) { console.log("aborted"); process.exit(0); }
  }

  const logger = createLogger("collectUSDT", { projectRoot: PROJECT_ROOT });
  const results = [];

  for (let idx = 0; idx < jobs.length; idx += 1) {
    const job = jobs[idx];
    const wallet = new Wallet(job.privateKey, provider);
    const usdt = new Contract(BSC.USDT_TOKEN, ERC20_ABI, wallet);

    console.log(`\n[${idx + 1}/${jobs.length}] ${job.label} (${wallet.address})`);

    const result = {
      label: job.label,
      address: wallet.address,
      status: "skipped",
      collector: collectAddress,
    };

    try {
      const usdtBal = await usdt.balanceOf(wallet.address);
      result.usdt_before = fmtAmount(usdtBal);

      if (usdtBal < minUsdtWei) {
        result.reason = `USDT below min (${fmtAmount(minUsdtWei)})`;
        console.log(`  skipped: ${result.reason}`);
      } else {
        const tx = await usdt.transfer.populateTransaction(collectAddress, usdtBal);
        const hash = await sendLegacyTx(wallet, {
          ...tx,
          gasLimit: gasLimitTransfer,
          gasPrice,
          chainId: BSC.CHAIN_ID,
          type: 0,
        }, { dryRun: args.dryRun });
        result.usdt_collected = fmtAmount(usdtBal);
        result.usdt_tx = hash;
        result.status = "ok";
        console.log(`  USDT tx: ${hash} (${result.usdt_collected} USDT)`);
      }

      if (args.collectBnb) {
        const bnbBal = await provider.getBalance(wallet.address);
        const gasCost = gasPrice * BigInt(gasLimitBnb);
        const sendValue = bnbBal > gasCost ? bnbBal - gasCost : 0n;
        result.bnb_before = fmtAmount(bnbBal);

        if (sendValue > 0n) {
          const bnbHash = await sendLegacyTx(wallet, {
            to: collectAddress,
            value: sendValue,
            gasLimit: gasLimitBnb,
            gasPrice,
            chainId: BSC.CHAIN_ID,
            type: 0,
          }, { dryRun: args.dryRun });
          result.bnb_collected = fmtAmount(sendValue);
          result.bnb_tx = bnbHash;
          console.log(`  BNB tx: ${bnbHash} (${result.bnb_collected} BNB)`);
        } else {
          result.bnb_skipped = "insufficient BNB after gas reserve";
        }
      }
    } catch (err) {
      result.status = "failed";
      result.error = err.message;
      console.log(`  FAILED: ${err.message}`);
    }

    results.push(result);
    logger.append(result);
    if (idx < jobs.length - 1) await randomDelay(args.delayMin, args.delayMax);
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const summaryPath = logger.writeSummary({ ok, skipped, failed, collector: collectAddress });

  console.log(`\nDone: ok=${ok}, skipped=${skipped}, failed=${failed}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
