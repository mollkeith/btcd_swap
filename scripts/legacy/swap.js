#!/usr/bin/env node
/**
 * Batch swap BTCD -> USDT on Elastos PGP chain.
 *
 * Mirrors on-chain tx:
 * https://pgp.elastos.io/tx/0x1940908b2f65dc8e13de95f74149d394f5ce3f16458b3a07863c1b174fa81e8e
 *
 * Swap contract charges ~0.5% fee (50 bps): 992 BTCD -> 987.04 USDT.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import dotenv from "dotenv";
import { Contract, JsonRpcProvider, Wallet, parseUnits, formatUnits } from "ethers";

import { PROJECT_ROOT } from "../../lib/paths.js";
const __dirname = PROJECT_ROOT;

// --- PGP mainnet defaults (from reference tx) ---
const RPC_URL = "https://api.elastos.io/pg";
const CHAIN_ID = 860621;
const SWAP_CONTRACT = "0xFF60725F03531DCeE7f91d731cd002Fc78aB497F";
const BTCD_TOKEN = "0xF9BF836FEd97a9c9Bfe4D4c28316b9400C59Cc6B";
const USDT_TOKEN = "0xdF72788af68E7902F61377D246Dd502b0b383385";
const FEE_BPS_SELECTOR = "0x09f80dd9";
const SWAP_SELECTOR = "0xb740e96e";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const DEFAULTS = {
  amount: "all",
  minBtcd: 0.01,
  rpc: process.env.PGP_RPC_URL || RPC_URL,
  gasPriceGwei: Number(process.env.GAS_PRICE_GWEI || "25"),
  gasLimitApprove: 80_000,
  gasLimitSwap: 150_000,
  delay: 2,
  dryRun: false,
  yes: false,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--amount":
        args.amount = argv[++i];
        break;
      case "--min-btcd":
        args.minBtcd = Number(argv[++i]);
        break;
      case "--rpc":
        args.rpc = argv[++i];
        break;
      case "--gas-price-gwei":
        args.gasPriceGwei = Number(argv[++i]);
        break;
      case "--gas-limit-approve":
        args.gasLimitApprove = Number(argv[++i]);
        break;
      case "--gas-limit-swap":
        args.gasLimitSwap = Number(argv[++i]);
        break;
      case "--delay":
        args.delay = Number(argv[++i]);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`usage: node swap.js [options]

Batch swap BTCD to USDT on Elastos PGP chain

options:
  --amount AMOUNT             BTCD per wallet, e.g. "100" or "all" (default: all)
  --min-btcd MIN_BTCD         Skip wallets below this BTCD balance (default: 0.01)
  --rpc RPC                   PGP RPC endpoint
  --gas-price-gwei GWEI       Legacy gas price in gwei (default: 25)
  --gas-limit-approve LIMIT   Gas limit for approve tx (default: 80000)
  --gas-limit-swap LIMIT      Gas limit for swap tx (default: 150000)
  --delay SECONDS             Delay between wallets (default: 2)
  --dry-run                   Simulate only; do not broadcast
  --yes                       Skip confirmation prompt
  -h, --help                  Show this help
`);
}

function loadWalletsFromEnv() {
  const jobs = [];

  if (process.env.WALLET_PRIVATE_KEY_1) {
    for (let i = 1; ; i += 1) {
      const key = (process.env[`WALLET_PRIVATE_KEY_${i}`] || "").trim();
      if (!key) break;
      jobs.push({ privateKey: key, label: `wallet-${i}` });
    }
    return jobs;
  }

  const multi = (process.env.WALLET_PRIVATE_KEYS || "").trim();
  if (multi) {
    multi.split(",").forEach((part, i) => {
      const key = part.trim();
      if (key) jobs.push({ privateKey: key, label: `wallet-${i + 1}` });
    });
    if (jobs.length) return jobs;
  }

  const single = (process.env.WALLET_PRIVATE_KEY || "").trim();
  if (single) {
    return [{ privateKey: single, label: "wallet-1" }];
  }

  throw new Error(
    "No wallet private keys found in .env. " +
    "Set WALLET_PRIVATE_KEY, WALLET_PRIVATE_KEYS, or WALLET_PRIVATE_KEY_1 ..."
  );
}

function fmtAmount(value, decimals = 18) {
  return formatUnits(value, decimals).replace(/\.?0+$/, "");
}

function encodeSwapData(tokenIn, tokenOut, amount) {
  const tokenInHex = tokenIn.toLowerCase().replace("0x", "").padStart(64, "0");
  const tokenOutHex = tokenOut.toLowerCase().replace("0x", "").padStart(64, "0");
  const amountHex = amount.toString(16).padStart(64, "0");
  return SWAP_SELECTOR + tokenInHex + tokenOutHex + amountHex;
}

async function readFeeBps(provider, swapContract) {
  const result = await provider.call({ to: swapContract, data: FEE_BPS_SELECTOR });
  return Number(BigInt(result));
}

function estimateUsdtOut(amountIn, feeBps) {
  return (amountIn * BigInt(10_000 - feeBps)) / 10_000n;
}

async function sendLegacyTx(wallet, tx, { dryRun }) {
  if (dryRun) {
    return "dry-run";
  }

  const response = await wallet.sendTransaction(tx);
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`transaction reverted: ${response.hash}`);
  }
  return response.hash;
}

async function ensureApproval(
  wallet,
  btcd,
  swapContract,
  amount,
  { gasPrice, gasLimit, dryRun }
) {
  const allowance = await btcd.allowance(wallet.address, swapContract);
  if (allowance >= amount) {
    return null;
  }

  const tx = await btcd.approve.populateTransaction(swapContract, amount);
  const hash = await sendLegacyTx(wallet, {
    ...tx,
    gasLimit,
    gasPrice,
    chainId: CHAIN_ID,
    type: 0,
  }, { dryRun });

  console.log(`    approve tx: ${hash}`);
  return hash;
}

async function swapBtcdToUsdt(
  wallet,
  swapContract,
  amount,
  { gasPrice, gasLimit, dryRun }
) {
  const data = encodeSwapData(BTCD_TOKEN, USDT_TOKEN, amount);
  const nonce = await wallet.provider.getTransactionCount(wallet.address);

  return sendLegacyTx(
    wallet,
    {
      to: swapContract,
      value: 0n,
      data,
      nonce,
      gasLimit,
      gasPrice,
      chainId: CHAIN_ID,
      type: 0,
    },
    { dryRun }
  );
}

async function resolveSwapAmount(btcd, address, amountArg) {
  const balance = await btcd.balanceOf(address);
  if (amountArg === "all") {
    return balance;
  }

  const requested = parseUnits(amountArg, 18);
  if (requested > balance) {
    throw new Error(
      `requested ${fmtAmount(requested)} BTCD but balance is ${fmtAmount(balance)}`
    );
  }
  return requested;
}

async function processWallet(
  provider,
  job,
  {
    amountArg,
    minBtcdWei,
    swapContract,
    feeBps,
    gasPrice,
    gasLimitApprove,
    gasLimitSwap,
    dryRun,
  }
) {
  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(BTCD_TOKEN, ERC20_ABI, wallet);
  const usdt = new Contract(USDT_TOKEN, ERC20_ABI, provider);

  const btcdBefore = await btcd.balanceOf(wallet.address);
  const usdtBefore = await usdt.balanceOf(wallet.address);
  const pgaBefore = await provider.getBalance(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    btcd_before: fmtAmount(btcdBefore),
    usdt_before: fmtAmount(usdtBefore),
  };

  if (btcdBefore < minBtcdWei) {
    result.reason = `BTCD balance below min (${fmtAmount(minBtcdWei)})`;
    return result;
  }

  let amount;
  try {
    amount = await resolveSwapAmount(btcd, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }

  if (amount === 0n) {
    result.reason = "zero BTCD balance";
    return result;
  }

  const estUsdt = estimateUsdtOut(amount, feeBps);
  const minGasCost = gasPrice * BigInt(gasLimitApprove + gasLimitSwap);
  if (pgaBefore < minGasCost) {
    result.reason = `insufficient PGA for gas (need ~${fmtAmount(minGasCost)} PGA)`;
    return result;
  }

  console.log(
    `  swap ${fmtAmount(amount)} BTCD -> ~${fmtAmount(estUsdt)} USDT ` +
    `(fee ${(feeBps / 100).toFixed(2)}%)`
  );

  await ensureApproval(wallet, btcd, swapContract, amount, {
    gasPrice,
    gasLimit: gasLimitApprove,
    dryRun,
  });

  const swapHash = await swapBtcdToUsdt(wallet, swapContract, amount, {
    gasPrice,
    gasLimit: gasLimitSwap,
    dryRun,
  });
  console.log(`    swap tx: ${swapHash}`);

  const btcdAfter = await btcd.balanceOf(wallet.address);
  const usdtAfter = await usdt.balanceOf(wallet.address);

  Object.assign(result, {
    status: "ok",
    swap_tx: swapHash,
    btcd_swapped: fmtAmount(amount),
    usdt_estimated: fmtAmount(estUsdt),
    btcd_after: fmtAmount(btcdAfter),
    usdt_after: fmtAmount(usdtAfter),
    usdt_received: fmtAmount(usdtAfter - usdtBefore),
  });

  return result;
}

async function confirmProceed() {
  const rl = createInterface({ input, output });
  const answer = await rl.question("\nProceed with live swaps? [y/N] ");
  rl.close();
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

async function main() {
  dotenv.config({ path: join(__dirname, ".env") });

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  let jobs;
  try {
    jobs = loadWalletsFromEnv();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  const provider = new JsonRpcProvider(args.rpc, CHAIN_ID);
  try {
    await provider.getBlockNumber();
  } catch {
    console.error(`error: cannot connect to RPC ${args.rpc}`);
    process.exit(1);
  }

  const swapContract = SWAP_CONTRACT;
  const feeBps = await readFeeBps(provider, swapContract);
  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");
  const minBtcdWei = parseUnits(String(args.minBtcd), 18);

  console.log("PGP BTCD -> USDT batch swap");
  console.log(`  RPC:           ${args.rpc}`);
  console.log(`  chainId:       ${CHAIN_ID}`);
  console.log(`  swap contract: ${swapContract}`);
  console.log(`  BTCD:          ${BTCD_TOKEN}`);
  console.log(`  USDT:          ${USDT_TOKEN}`);
  console.log(`  fee:           ${feeBps} bps (${(feeBps / 100).toFixed(2)}%)`);
  console.log(`  wallets:       ${jobs.length}`);
  console.log(`  amount:        ${args.amount}`);
  console.log(`  mode:          ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  if (!args.yes && !args.dryRun) {
    const proceed = await confirmProceed();
    if (!proceed) {
      console.log("aborted");
      process.exit(0);
    }
  }

  const results = [];
  for (let idx = 0; idx < jobs.length; idx += 1) {
    const job = jobs[idx];
    const wallet = new Wallet(job.privateKey);
    console.log(`\n[${idx + 1}/${jobs.length}] ${job.label} (${wallet.address})`);

    try {
      const result = await processWallet(provider, job, {
        amountArg: args.amount,
        minBtcdWei,
        swapContract,
        feeBps,
        gasPrice,
        gasLimitApprove: args.gasLimitApprove,
        gasLimitSwap: args.gasLimitSwap,
        dryRun: args.dryRun,
      });
      results.push(result);
    } catch (err) {
      console.log(`    FAILED: ${err.message}`);
      results.push({
        label: job.label,
        address: wallet.address,
        status: "failed",
        error: err.message,
      });
    }

    if (idx < jobs.length - 1 && args.delay > 0) {
      await sleep(args.delay * 1000);
    }
  }

  const summaryPath = join(__dirname, "swap-results.json");
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);

  const ok = results.filter((r) => r.status === "ok").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  console.log(`\nDone: ok=${ok}, skipped=${skipped}, failed=${failed}`);
  console.log(`Results saved to ${summaryPath}`);

  process.exit(failed === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
