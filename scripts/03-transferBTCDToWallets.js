#!/usr/bin/env node
/**
 * Master wallet sends random BTCD amounts to CSV addresses on PGP.
 * Ref: https://pgp.elastos.io/tx/0xabd189ced70c6c6ca786f2d240f3a792d4b92370bc1503cab4afc5c5f092d017
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
import { randomAmount, randomDelay } from "../lib/random.js";

function printHelp() {
  console.log(`usage: node transferBTCDToWallets.js [options]

options:
  --csv PATH              Address CSV (default: data/wallets.csv)
  --min-btcd MIN          Min BTCD per wallet (required)
  --max-btcd MAX          Max BTCD per wallet (required)
  --gas-limit LIMIT       Gas limit (default: 89000)
  --delay-min / --delay-max
  --gas-price-gwei GWEI
  --dry-run  --yes
  -h, --help
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: {
      csv: "data/wallets.csv",
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

async function main() {
  dotenv.config({ path: join(PROJECT_ROOT, ".env") });
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`error: ${err.message}`); process.exit(1); }

  const rows = readWalletsCsv(join(PROJECT_ROOT, args.csv), { requirePrivateKey: false });
  const provider = new JsonRpcProvider(PGP.RPC_URL, PGP.CHAIN_ID);
  await provider.getBlockNumber();

  const master = loadMasterWallet(provider);
  const btcd = new Contract(PGP.BTCD_TOKEN, ERC20_ABI, master);
  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");

  console.log("Transfer BTCD from master to CSV wallets");
  console.log(`  master:   ${master.address}`);
  console.log(`  BTCD:     ${PGP.BTCD_TOKEN}`);
  console.log(`  range:    ${args.minBtcd} - ${args.maxBtcd} BTCD`);
  console.log(`  wallets:  ${rows.length}`);
  console.log(`  mode:     ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed("\nProceed with BTCD transfers? [y/N] ");
    if (!ok) { console.log("aborted"); process.exit(0); }
  }

  const logger = createLogger("transferBTCDToWallets", { projectRoot: PROJECT_ROOT });
  const results = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    const amountWei = randomAmount(args.minBtcd, args.maxBtcd);
    const amountStr = fmtAmount(amountWei);

    console.log(`\n[${idx + 1}/${rows.length}] -> ${row.address} (${amountStr} BTCD)`);

    let result = { index: row.index, address: row.address, btcd_amount: amountStr, status: "pending" };
    try {
      const masterBtcd = await btcd.balanceOf(master.address);
      const masterPga = await provider.getBalance(master.address);
      const gasCost = gasPrice * BigInt(args.gasLimit);

      if (masterBtcd < amountWei) {
        result.status = "skipped";
        result.reason = `master BTCD insufficient (${fmtAmount(masterBtcd)} available)`;
        console.log(`  skipped: ${result.reason}`);
      } else if (masterPga < gasCost) {
        result.status = "skipped";
        result.reason = `master PGA insufficient for gas (need ~${fmtAmount(gasCost)})`;
        console.log(`  skipped: ${result.reason}`);
      } else {
        const tx = await btcd.transfer.populateTransaction(row.address, amountWei);
        const hash = await sendLegacyTx(master, {
          ...tx,
          gasLimit: args.gasLimit,
          gasPrice,
          chainId: PGP.CHAIN_ID,
          type: 0,
        }, { dryRun: args.dryRun });

        const masterBtcdAfter = await btcd.balanceOf(master.address);
        const masterPgaAfter = await provider.getBalance(master.address);
        result = {
          ...result,
          status: "ok",
          tx: hash,
          master_btcd_after: fmtAmount(masterBtcdAfter),
          master_pga_after: fmtAmount(masterPgaAfter),
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
  });

  console.log(`\nLog: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(results.some((r) => r.status === "failed") ? 2 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
