#!/usr/bin/env node
/**
 * Master wallet sends PGP USDT to CSV addresses.
 * Each wallet gets a random amount in [min, max]; min === max sends the same to all.
 */

import dotenv from "dotenv";
import { join } from "node:path";
import { PROJECT_ROOT } from "../lib/paths.js";
import { Contract, JsonRpcProvider, parseUnits } from "ethers";
import { PGP, DEFAULT_GAS, ERC20_ABI } from "../lib/constants.js";
import { fmtAmount, confirmProceed, sendLegacyTx } from "../lib/common.js";
import { readWalletsCsv } from "../lib/csv.js";
import { parseCommonFlags } from "../lib/args.js";
import { createLogger } from "../lib/logger.js";
import { loadMasterWallet } from "../lib/wallet.js";
import { randomDelay } from "../lib/random.js";
import { requireCsvPath } from "../lib/walletCsv.js";
import { planUsdtTransfers, minUsdtTotal } from "../lib/usdtDistribute.js";

function printHelp() {
  console.log(`usage: node scripts/08-transferPGChainUSDT.js [options]

options:
  --csv PATH              Wallet CSV (required)
  --min-usdt MIN          Min USDT per wallet (required)
  --max-usdt MAX          Max USDT per wallet (required)
  --gas-limit LIMIT       Gas limit (default: 65000)
  --delay-min / --delay-max
  --gas-price-gwei GWEI
  --dry-run  --yes
  -h, --help

Source wallet: WALLET_PRIVATE_KEY in .env (master).
If min === max, each wallet receives the same USDT amount.
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: {
      minUsdt: NaN,
      maxUsdt: NaN,
      gasLimit: DEFAULT_GAS.gasLimitTransfer,
    },
    onUnknown(arg, argv, i, a) {
      if (arg === "--min-usdt") { a.minUsdt = Number(argv[i + 1]); return i + 1; }
      if (arg === "--max-usdt") { a.maxUsdt = Number(argv[i + 1]); return i + 1; }
      if (arg === "--gas-limit") { a.gasLimit = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  if (Number.isNaN(args.minUsdt) || Number.isNaN(args.maxUsdt)) {
    throw new Error("--min-usdt and --max-usdt are required");
  }
  if (args.minUsdt > args.maxUsdt) {
    throw new Error("--min-usdt must be <= --max-usdt");
  }
  if (args.minUsdt < 0 || args.maxUsdt < 0) {
    throw new Error("--min-usdt and --max-usdt must be >= 0");
  }
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
  const usdt = new Contract(PGP.USDT_TOKEN, ERC20_ABI, master);
  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const gasCostPerTx = gasPrice * BigInt(args.gasLimit);
  const totalGasCost = gasCostPerTx * BigInt(rows.length);

  const masterUsdt = await usdt.balanceOf(master.address);
  const masterPga = await provider.getBalance(master.address);

  let plan;
  try {
    plan = planUsdtTransfers(rows.length, args.minUsdt, args.maxUsdt);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  const minTotal = minUsdtTotal(rows.length, args.minUsdt);

  console.log("Transfer PGP USDT from master to CSV wallets");
  console.log(`  master:        ${master.address}`);
  console.log(`  USDT token:    ${PGP.USDT_TOKEN}`);
  console.log(`  master USDT:   ${fmtAmount(masterUsdt)}`);
  console.log(`  master PGA:    ${fmtAmount(masterPga)}`);
  console.log(
    `  range/wallet:  ${args.minUsdt}` +
      (plan.fixed ? " USDT (fixed)" : ` - ${args.maxUsdt} USDT (random)`)
  );
  console.log(`  planned total: ${fmtAmount(plan.total)} (${rows.length} wallets)`);
  console.log(`  gas estimate:  ~${fmtAmount(totalGasCost)} PGA (${rows.length} txs)`);
  console.log(`  mode:          ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  console.log("\nAllocation plan:");
  for (let i = 0; i < rows.length; i += 1) {
    console.log(`  [${i + 1}] ${rows[i].address} -> ${fmtAmount(plan.amounts[i])} USDT`);
  }

  if (masterUsdt < plan.total) {
    console.error(
      `\nerror: insufficient USDT (need ${fmtAmount(plan.total)}, have ${fmtAmount(masterUsdt)})`
    );
    process.exit(1);
  }
  if (masterUsdt < minTotal) {
    console.error(
      `\nerror: USDT below minimum possible total (need at least ${fmtAmount(minTotal)})`
    );
    process.exit(1);
  }
  if (masterPga < totalGasCost) {
    console.error(
      `\nerror: insufficient PGA for gas (need ~${fmtAmount(totalGasCost)}, ` +
        `have ${fmtAmount(masterPga)})`
    );
    process.exit(1);
  }

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed("\nProceed with USDT transfers? [y/N] ");
    if (!ok) { console.log("aborted"); process.exit(0); }
  }

  const logger = createLogger("transferPGChainUSDT", { projectRoot: PROJECT_ROOT });
  const results = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    const amountWei = plan.amounts[idx];
    const amountStr = fmtAmount(amountWei);

    console.log(`\n[${idx + 1}/${rows.length}] -> ${row.address} (${amountStr} USDT)`);

    let result = {
      index: row.index,
      address: row.address,
      usdt_amount: amountStr,
      status: "pending",
    };

    try {
      const currentUsdt = await usdt.balanceOf(master.address);
      const currentPga = await provider.getBalance(master.address);

      if (currentUsdt < amountWei) {
        result.status = "skipped";
        result.reason = `master USDT insufficient (need ${amountStr}, have ${fmtAmount(currentUsdt)})`;
        console.log(`  skipped: ${result.reason}`);
      } else if (currentPga < gasCostPerTx) {
        result.status = "skipped";
        result.reason = `master PGA insufficient for gas (need ~${fmtAmount(gasCostPerTx)})`;
        console.log(`  skipped: ${result.reason}`);
      } else {
        const tx = await usdt.transfer.populateTransaction(row.address, amountWei);
        const hash = await sendLegacyTx(master, {
          ...tx,
          gasLimit: args.gasLimit,
          gasPrice,
          chainId: PGP.CHAIN_ID,
          type: 0,
        }, { dryRun: args.dryRun });

        result = {
          ...result,
          status: "ok",
          tx: hash,
          master_usdt_after: fmtAmount(await usdt.balanceOf(master.address)),
          master_pga_after: fmtAmount(await provider.getBalance(master.address)),
        };
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
    distributed: fmtAmount(plan.total),
    fixed_amount: plan.fixed,
  });

  console.log(`\nMaster USDT balance: ${fmtAmount(await usdt.balanceOf(master.address))}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(results.some((r) => r.status === "failed") ? 2 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
