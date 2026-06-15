#!/usr/bin/env node
/**
 * Bridge all USDT from PGP wallets (CSV) to BSC.
 * --check-bridge polls BSC USDT balance after each bridge tx.
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
import { processBridgeWallet, checkBridgeArrival } from "../lib/bridge.js";
import { connectBscProvider } from "../lib/provider.js";

function printHelp() {
  console.log(`usage: node bridgeUSDTToBSC.js [options]

options:
  --csv PATH              Wallet CSV (required)
  --amount AMOUNT         USDT per wallet or "all" (default: all)
  --min-usdt MIN          Skip below this USDT (default: 0.01)
  --recipient ADDRESS     BSC recipient (default: same wallet)
  --check-bridge          Poll BSC USDT after bridge
  --check-timeout SEC     Poll timeout (default: 600)
  --delay-min / --delay-max
  --gas-price-gwei GWEI
  --dry-run  --yes
  -h, --help
`);
}

function parseArgs(argv) {
  const args = parseCommonFlags(argv, {
    defaults: {
      amount: "all",
      minUsdt: 0.01,
      recipient: "",
      checkBridge: false,
      checkTimeout: 600,
    },
    onUnknown(arg, argv, i, argsObj) {
      if (arg === "--amount") {
        argsObj.amount = argv[i + 1];
        return i + 1;
      }
      if (arg === "--min-usdt") {
        argsObj.minUsdt = Number(argv[i + 1]);
        return i + 1;
      }
      if (arg === "--recipient") {
        argsObj.recipient = argv[i + 1];
        return i + 1;
      }
      if (arg === "--check-bridge") {
        argsObj.checkBridge = true;
        return true;
      }
      if (arg === "--check-timeout") {
        argsObj.checkTimeout = Number(argv[i + 1]);
        return i + 1;
      }
      return false;
    },
  });
  if (args.help) {
    printHelp();
    process.exit(0);
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

  const minUsdtWei = parseUnits(String(args.minUsdt), 18);
  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const bridgeContract = PGP.BRIDGE_CONTRACT;

  console.log("PGP USDT -> BSC bridge (CSV batch)");
  console.log(`  CSV:          ${csvPath}`);
  console.log(`  bridge:       ${bridgeContract}`);
  console.log(`  dest chain:   ${PGP.BRIDGE_DEST_CHAIN_ID}`);
  console.log(`  wallets:      ${jobs.length}`);
  console.log(`  check bridge: ${args.checkBridge}`);
  console.log(`  mode:         ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  if (args.checkBridge && !args.dryRun) {
    try {
      const { rpcUrl } = await connectBscProvider();
      console.log(`  BSC RPC:      ${rpcUrl}`);
    } catch (err) {
      console.warn(`  warning: BSC RPC unreachable (${err.message}); check-bridge may fail`);
    }
  }

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed("\nProceed with live bridge transactions? [y/N] ");
    if (!ok) {
      console.log("aborted");
      process.exit(0);
    }
  }

  const logger = createLogger("bridgeUSDTToBSC", { projectRoot: PROJECT_ROOT });
  const results = [];

  for (let idx = 0; idx < jobs.length; idx += 1) {
    const job = jobs[idx];
    const w = new Wallet(job.privateKey);
    const recipient = args.recipient || w.address;

    console.log(`\n[${idx + 1}/${jobs.length}] ${job.label} (${w.address})`);

    let result;
    try {
      result = await processBridgeWallet(provider, job, {
        amountArg: args.amount,
        minUsdtWei,
        bridgeContract,
        destChainId: PGP.BRIDGE_DEST_CHAIN_ID,
        recipient,
        gasPrice,
        dryRun: args.dryRun,
      });

      if (result.status === "ok") {
        console.log(`  bridge tx: ${result.bridge_tx}`);
        if (args.checkBridge && !args.dryRun) {
          console.log(`  polling BSC USDT for ${recipient} (timeout ${args.checkTimeout}s)...`);
          try {
            const arrival = await checkBridgeArrival(recipient, {
              expectedMinWei: parseUnits(result.usdt_bridged || "0", 18) * 99n / 100n,
              timeoutSec: args.checkTimeout,
            });
            result.bsc_arrival = arrival;
            if (arrival.arrived) {
              console.log(`  BSC arrival: yes balance=${arrival.balance_fmt}`);
            } else {
              result.bsc_check = "timeout";
              console.log(
                `  BSC arrival: pending (balance=${arrival.balance_fmt}, ` +
                  `expected +${result.usdt_bridged})`
              );
              if (arrival.rpc_error) {
                console.log(`  BSC RPC note: ${arrival.rpc_error}`);
              }
            }
          } catch (err) {
            result.bsc_check = "error";
            result.bsc_check_error = err.message;
            console.log(`  BSC check failed (bridge tx ok): ${err.message}`);
          }
        }
      } else {
        console.log(`  ${result.status}: ${result.reason || ""}`);
      }
    } catch (err) {
      result = {
        label: job.label,
        address: w.address,
        status: "failed",
        error: err.message,
      };
      console.log(`  FAILED: ${err.message}`);
    }

    results.push(result);
    logger.append(result);

    if (idx < jobs.length - 1) {
      await randomDelay(args.delayMin, args.delayMax);
    }
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const bscPending = results.filter((r) => r.bsc_check === "timeout" || r.bsc_check === "error").length;

  const summaryPath = logger.writeSummary({ ok, skipped, failed, bsc_pending: bscPending });

  console.log(`\nDone: ok=${ok}, skipped=${skipped}, failed=${failed}, bsc_pending=${bscPending}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);

  process.exit(failed > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
