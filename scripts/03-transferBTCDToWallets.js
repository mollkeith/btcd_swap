#!/usr/bin/env node
/**
 * Master wallet sends BTCD to CSV addresses on PGP.
 * Pre-checks balance and allocates all BTCD (zero remainder).
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
import { allocateBtcdAmounts, describeAllocationMode } from "../lib/btcdDistribute.js";

function printHelp() {
  console.log(`usage: node scripts/03-transferBTCDToWallets.js [options]

options:
  --csv PATH              Wallet CSV (required)
  --min-btcd MIN          Min BTCD per wallet (required)
  --max-btcd MAX          Max BTCD per wallet (required)
  --gas-limit LIMIT       Gas limit (default: 89000)
  --delay-min / --delay-max
  --gas-price-gwei GWEI
  --dry-run  --yes
  -h, --help

Checks master BTCD balance first, then splits all BTCD across wallets.
Modes: normal / exceed / topup (already-funded) / fallback.
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: {
      minBtcd: NaN,
      maxBtcd: NaN,
      gasLimit: DEFAULT_GAS.gasLimitBtcdTransfer,
    },
    onUnknown(arg, argv, i, a) {
      if (arg === "--min-btcd") { a.minBtcd = Number(argv[i + 1]); return i + 1; }
      if (arg === "--max-btcd") { a.maxBtcd = Number(argv[i + 1]); return i + 1; }
      if (arg === "--gas-limit") { a.gasLimit = Number(argv[i + 1]); return i + 1; }
      return false;
    },
  });
  if (args.help) { printHelp(); process.exit(0); }
  if (Number.isNaN(args.minBtcd) || Number.isNaN(args.maxBtcd)) {
    throw new Error("--min-btcd and --max-btcd are required");
  }
  if (args.minBtcd > args.maxBtcd) {
    throw new Error("--min-btcd must be <= --max-btcd");
  }
  return args;
}

async function fetchWalletBtcdBalances(btcd, rows) {
  const balances = await Promise.all(rows.map((row) => btcd.balanceOf(row.address)));
  return balances.map((wei) => wei > 0n);
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
  const btcd = new Contract(PGP.BTCD_TOKEN, ERC20_ABI, master);
  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const gasCostPerTx = gasPrice * BigInt(args.gasLimit);

  const masterBtcd = await btcd.balanceOf(master.address);
  const masterPga = await provider.getBalance(master.address);

  if (masterBtcd <= 0n) {
    console.error("error: master BTCD balance is zero");
    process.exit(1);
  }

  const fundedMask = await fetchWalletBtcdBalances(btcd, rows);

  let plan;
  try {
    plan = allocateBtcdAmounts(masterBtcd, rows.length, args.minBtcd, args.maxBtcd, {
      fundedMask,
    });
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  const txCount = plan.amounts.filter((a) => a > 0n).length;
  const totalGasCost = gasCostPerTx * BigInt(txCount);

  console.log("Transfer BTCD from master to CSV wallets");
  console.log(`  master:        ${master.address}`);
  console.log(`  master BTCD:   ${fmtAmount(masterBtcd)}`);
  console.log(`  master PGA:    ${fmtAmount(masterPga)}`);
  console.log(`  range/wallet:  ${args.minBtcd} - ${args.maxBtcd} BTCD`);
  console.log(`  to distribute: ${fmtAmount(plan.distributeTotal)} (${txCount} txs)`);
  console.log(`  allocation:    ${describeAllocationMode(plan.mode)}`);
  console.log(`  gas estimate:  ~${fmtAmount(totalGasCost)} PGA (${txCount} txs)`);
  console.log(`  mode:          ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  console.log("\nAllocation plan:");
  for (let i = 0; i < rows.length; i += 1) {
    const onChain = fundedMask[i] ? "funded" : "empty";
    const amount = plan.amounts[i];
    const label = amount > 0n ? fmtAmount(amount) : "skip";
    console.log(`  [${i + 1}] ${rows[i].address} (${onChain}) -> ${label} BTCD`);
  }

  if (masterPga < totalGasCost) {
    console.error(
      `\nerror: insufficient PGA for gas (need ~${fmtAmount(totalGasCost)}, ` +
        `have ${fmtAmount(masterPga)})`
    );
    process.exit(1);
  }

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed("\nProceed with BTCD transfers? [y/N] ");
    if (!ok) { console.log("aborted"); process.exit(0); }
  }

  const logger = createLogger("transferBTCDToWallets", { projectRoot: PROJECT_ROOT });
  const results = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    const amountWei = plan.amounts[idx];
    const amountStr = fmtAmount(amountWei);

    console.log(`\n[${idx + 1}/${rows.length}] -> ${row.address}`);

    if (amountWei === 0n) {
      const result = {
        index: row.index,
        address: row.address,
        btcd_amount: "0",
        status: "skipped",
        reason: "no allocation",
      };
      console.log("  skipped: no allocation");
      results.push(result);
      logger.append(result);
      continue;
    }

    console.log(`  amount: ${amountStr} BTCD`);

    let result = { index: row.index, address: row.address, btcd_amount: amountStr, status: "pending" };
    try {
      const tx = await btcd.transfer.populateTransaction(row.address, amountWei);
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
        allocation_mode: plan.mode,
        master_btcd_after: fmtAmount(await btcd.balanceOf(master.address)),
        master_pga_after: fmtAmount(await provider.getBalance(master.address)),
      };
      console.log(`  tx: ${hash}`);
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
    distributed: fmtAmount(plan.distributeTotal),
    allocation_mode: plan.mode,
  });

  console.log(`\nLog: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(results.some((r) => r.status === "failed") ? 2 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
