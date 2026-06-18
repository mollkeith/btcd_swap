#!/usr/bin/env node
/**
 * Collect USDT (and optionally BNB) from BSC wallets to COLLECT_ADDRESS or master wallet.
 */

import dotenv from "dotenv";
import { join } from "node:path";
import { PROJECT_ROOT } from "../lib/paths.js";
import { Contract, Wallet, parseUnits } from "ethers";
import { BSC, DEFAULT_GAS, ERC20_ABI } from "../lib/constants.js";
import { connectBscProvider } from "../lib/provider.js";
import { fmtAmount, confirmProceed, sendLegacyTx } from "../lib/common.js";
import { parseCommonFlags } from "../lib/args.js";
import { createLogger } from "../lib/logger.js";
import { loadWalletsFromCsv, loadMasterWallet, getCollectAddress } from "../lib/wallet.js";
import { randomDelay } from "../lib/random.js";
import { requireCsvPath } from "../lib/walletCsv.js";
import { planBnbSweep } from "../lib/bnbCollect.js";

function printHelp() {
  console.log(`usage: node collectUSDT.js [options]

options:
  --csv PATH              Wallet CSV (required)
  --collect-bnb           Also sweep remaining BNB to collector (optional; normally leave BNB as gas)
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

function gasCost(gasPrice, gasLimit) {
  return gasPrice * BigInt(gasLimit);
}

/** Minimum BNB (wei) required before attempting collection txs. */
function requiredBnbWei({ gasPrice, gasLimitTransfer, gasLimitBnb, collectUsdt, collectBnb }) {
  let need = 0n;
  if (collectUsdt) {
    need += gasCost(gasPrice, gasLimitTransfer);
  }
  if (collectBnb) {
    need += gasCost(gasPrice, gasLimitBnb);
  }
  return need;
}

function bnbShortfallMessage(bnbBal, need, gasPriceGwei) {
  return (
    `insufficient BNB for gas (have ${fmtAmount(bnbBal)}, need ~${fmtAmount(need)} ` +
    `at ${gasPriceGwei} gwei)`
  );
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

  const minUsdtWei = parseUnits(String(args.minUsdt), 18);
  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const gasLimitTransfer = DEFAULT_GAS.gasLimitTransfer;
  const collectorCode = await provider.getCode(collectAddress);
  const collectorIsContract = collectorCode !== "0x";
  const gasLimitBnbFloor = collectorIsContract ? 23_000 : DEFAULT_GAS.gasLimitBnbTransfer;
  const usdtGasCost = gasCost(gasPrice, gasLimitTransfer);
  const bnbGasCost = gasCost(gasPrice, gasLimitBnbFloor);

  console.log("Collect USDT on BSC");
  console.log(`  collector: ${collectAddress}${collectorIsContract ? " (contract)" : ""}`);
  console.log(`  CSV:       ${csvPath}`);
  console.log(`  wallets:   ${jobs.length}`);
  console.log(`  collect BNB: ${args.collectBnb}`);
  console.log(`  gas price: ${args.gasPriceGwei} gwei`);
  console.log(
    `  gas need:  USDT tx ~${fmtAmount(usdtGasCost)} BNB` +
      (args.collectBnb ? `, BNB tx ~${fmtAmount(bnbGasCost)} BNB` : "")
  );
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
      const bnbBal = await provider.getBalance(wallet.address);
      result.usdt_before = fmtAmount(usdtBal);
      result.bnb_before = fmtAmount(bnbBal);
      console.log(`  balance: ${result.usdt_before} USDT, ${result.bnb_before} BNB`);

      const willCollectUsdt = usdtBal >= minUsdtWei;
      const bnbNeed = requiredBnbWei({
        gasPrice,
        gasLimitTransfer,
        gasLimitBnb: gasLimitBnbFloor,
        collectUsdt: willCollectUsdt,
        collectBnb: args.collectBnb,
      });

      if (willCollectUsdt && bnbBal < bnbNeed) {
        result.reason = bnbShortfallMessage(bnbBal, bnbNeed, args.gasPriceGwei);
        console.log(`  skipped: ${result.reason}`);
      } else if (!willCollectUsdt) {
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
        const sweep = await planBnbSweep(provider, {
          from: wallet.address,
          to: collectAddress,
          gasPrice,
          gasLimitFloor: gasLimitBnbFloor,
        });
        result.bnb_after_usdt = fmtAmount(sweep.balance);

        if (sweep.sendValue > 0n) {
          const bnbHash = await sendLegacyTx(wallet, {
            to: collectAddress,
            value: sweep.sendValue,
            gasLimit: Number(sweep.gasLimit),
            gasPrice,
            chainId: BSC.CHAIN_ID,
            type: 0,
          }, { dryRun: args.dryRun });
          result.bnb_collected = fmtAmount(sweep.sendValue);
          result.bnb_tx = bnbHash;
          if (result.status === "skipped") {
            result.status = "ok";
          }
          console.log(`  BNB tx: ${bnbHash} (${result.bnb_collected} BNB)`);
        } else if (sweep.balance > 0n && sweep.balance < sweep.gasCost) {
          result.bnb_skipped = bnbShortfallMessage(sweep.balance, sweep.gasCost, args.gasPriceGwei);
          console.log(`  BNB skipped: ${result.bnb_skipped}`);
        } else {
          result.bnb_skipped = "no BNB to collect";
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
