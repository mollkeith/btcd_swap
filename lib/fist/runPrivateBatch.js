import dotenv from "dotenv";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, parseUnits } from "ethers";
import { PROJECT_ROOT } from "../paths.js";
import { PGP, BSC, DEFAULT_GAS } from "../constants.js";
import { confirmProceed } from "../common.js";
import { parseCommonFlags } from "../args.js";
import { createLogger } from "../logger.js";
import { loadWalletsFromCsv } from "../wallet.js";
import { randomDelay } from "../random.js";
import { requireCsvPath } from "../walletCsv.js";
import { connectBscProvider } from "../provider.js";

/**
 * Shared batch runner for FIST pipeline scripts (private CSV).
 */
export async function runPrivateBatch({
  scriptName,
  chain = "pgp",
  confirmMessage = "\nProceed with live transactions? [y/N] ",
  extraParseArgs,
  printHeader,
  processWallet,
}) {
  dotenv.config({ path: join(PROJECT_ROOT, ".env") });

  let args;
  try {
    args = extraParseArgs
      ? extraParseArgs(process.argv.slice(2))
      : parseCommonFlags(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  if (args.help) {
    process.exit(0);
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
  if (chain === "bsc") {
    try {
      ({ provider } = await connectBscProvider());
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exit(1);
    }
  } else {
    provider = new JsonRpcProvider(PGP.RPC_URL, PGP.CHAIN_ID);
    try {
      await provider.getBlockNumber();
    } catch {
      console.error(`error: cannot connect to RPC ${PGP.RPC_URL}`);
      process.exit(1);
    }
  }

  args.gasPrice = parseUnits(
    String(args.gasPriceGwei ?? (chain === "bsc" ? DEFAULT_GAS.bscGwei : DEFAULT_GAS.pgpGwei)),
    "gwei"
  );

  printHeader({ args, csvPath, jobs, chain });

  if (!args.yes && !args.dryRun) {
    const ok = await confirmProceed(confirmMessage);
    if (!ok) {
      console.log("aborted");
      process.exit(0);
    }
  }

  const logger = createLogger(scriptName, { projectRoot: PROJECT_ROOT });
  const results = [];

  for (let idx = 0; idx < jobs.length; idx += 1) {
    const job = jobs[idx];
    const w = new Wallet(job.privateKey);
    console.log(`\n[${idx + 1}/${jobs.length}] ${job.label} (${w.address})`);

    let result;
    try {
      result = await processWallet(provider, job, args);
      if (result.status !== "ok") {
        console.log(`  ${result.status}: ${result.reason || result.error || ""}`);
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
  const summaryPath = logger.writeSummary({ ok, skipped, failed });

  console.log(`\nDone: ok=${ok}, skipped=${skipped}, failed=${failed}`);
  console.log(`Log: ${logger.logPath}`);
  console.log(`Summary: ${summaryPath}`);
  process.exit(failed > 0 ? 2 : 0);
}
