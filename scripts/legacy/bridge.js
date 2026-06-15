#!/usr/bin/env node
/**
 * Batch bridge USDT from PGP chain to BSC.
 *
 * Reference tx:
 * https://pgp.elastos.io/tx/0x487d643dd6c238261c9fc595d1c9102e30215f389f313db65fb872636d506329
 *
 * Calldata: bridge(token, recipient, amount, destChainId=56)
 * Selector: 0xcb722992
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import dotenv from "dotenv";
import { Contract, JsonRpcProvider, Wallet, parseUnits, AbiCoder } from "ethers";
import {
  ERC20_ABI,
  fmtAmount,
  loadWalletsFromEnv,
  confirmProceed,
  sendLegacyTx,
} from "../../lib/common.js";

import { PROJECT_ROOT } from "../../lib/paths.js";
const __dirname = PROJECT_ROOT;

const PGP_RPC_URL = "https://api.elastos.io/pg";
const PGP_CHAIN_ID = 860621;
const BSC_CHAIN_ID = 56;
const BRIDGE_CONTRACT = "0xDBB35259372B2f0cB6b85dD31761C0fB3652Fd11";
const PGP_USDT = "0xdF72788af68E7902F61377D246Dd502b0b383385";
const BRIDGE_SELECTOR = "0xcb722992";

const DEFAULTS = {
  amount: "all",
  minUsdt: 0.01,
  rpc: process.env.PGP_RPC_URL || PGP_RPC_URL,
  destChainId: Number(process.env.BRIDGE_DEST_CHAIN_ID || BSC_CHAIN_ID),
  recipient: "",
  gasPriceGwei: Number(process.env.GAS_PRICE_GWEI || "25"),
  gasLimitApprove: 80_000,
  gasLimitBridge: 77_000,
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
      case "--min-usdt":
        args.minUsdt = Number(argv[++i]);
        break;
      case "--rpc":
        args.rpc = argv[++i];
        break;
      case "--dest-chain":
        args.destChainId = Number(argv[++i]);
        break;
      case "--recipient":
        args.recipient = argv[++i];
        break;
      case "--gas-price-gwei":
        args.gasPriceGwei = Number(argv[++i]);
        break;
      case "--gas-limit-approve":
        args.gasLimitApprove = Number(argv[++i]);
        break;
      case "--gas-limit-bridge":
        args.gasLimitBridge = Number(argv[++i]);
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
  console.log(`usage: node bridge.js [options]

Bridge USDT from PGP chain to BSC (or another supported chain)

options:
  --amount AMOUNT             USDT per wallet, e.g. "100" or "all" (default: all)
  --min-usdt MIN_USDT         Skip wallets below this USDT balance (default: 0.01)
  --dest-chain CHAIN_ID       Destination chain id (default: 56 = BSC)
  --recipient ADDRESS         BSC recipient; default: same wallet address
  --rpc RPC                   PGP RPC endpoint
  --gas-price-gwei GWEI       Legacy gas price in gwei (default: 25)
  --gas-limit-approve LIMIT   Gas limit for approve tx (default: 80000)
  --gas-limit-bridge LIMIT    Gas limit for bridge tx (default: 77000)
  --delay SECONDS             Delay between wallets (default: 2)
  --dry-run                   Simulate only; do not broadcast
  --yes                       Skip confirmation prompt
  -h, --help                  Show this help
`);
}

function encodeBridgeData(token, recipient, amount, destChainId) {
  const coder = AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    ["address", "address", "uint256", "uint256"],
    [token, recipient, amount, destChainId]
  );
  return BRIDGE_SELECTOR + encoded.slice(2);
}

async function ensureApproval(wallet, usdt, bridgeContract, amount, opts) {
  const allowance = await usdt.allowance(wallet.address, bridgeContract);
  if (allowance >= amount) {
    return null;
  }

  const tx = await usdt.approve.populateTransaction(bridgeContract, amount);
  const hash = await sendLegacyTx(
    wallet,
    {
      ...tx,
      gasLimit: opts.gasLimit,
      gasPrice: opts.gasPrice,
      chainId: PGP_CHAIN_ID,
      type: 0,
    },
    { dryRun: opts.dryRun }
  );

  console.log(`    approve tx: ${hash}`);
  return hash;
}

async function bridgeUsdt(wallet, bridgeContract, token, recipient, amount, destChainId, opts) {
  const data = encodeBridgeData(token, recipient, amount, destChainId);
  const nonce = await wallet.provider.getTransactionCount(wallet.address);

  return sendLegacyTx(
    wallet,
    {
      to: bridgeContract,
      value: 0n,
      data,
      nonce,
      gasLimit: opts.gasLimit,
      gasPrice: opts.gasPrice,
      chainId: PGP_CHAIN_ID,
      type: 0,
    },
    { dryRun: opts.dryRun }
  );
}

async function resolveBridgeAmount(usdt, address, amountArg) {
  const balance = await usdt.balanceOf(address);
  if (amountArg === "all") {
    return balance;
  }

  const requested = parseUnits(amountArg, 18);
  if (requested > balance) {
    throw new Error(
      `requested ${fmtAmount(requested)} USDT but balance is ${fmtAmount(balance)}`
    );
  }
  return requested;
}

async function processWallet(provider, job, args) {
  const wallet = new Wallet(job.privateKey, provider);
  const usdt = new Contract(PGP_USDT, ERC20_ABI, wallet);
  const bridgeContract = process.env.BRIDGE_CONTRACT || BRIDGE_CONTRACT;
  const recipient = args.recipient || wallet.address;

  const usdtBefore = await usdt.balanceOf(wallet.address);
  const pgaBefore = await provider.getBalance(wallet.address);
  const minUsdtWei = parseUnits(String(args.minUsdt), 18);
  const gasPrice = parseUnits(String(args.gasPriceGwei), "gwei");

  const result = {
    label: job.label,
    address: wallet.address,
    recipient,
    dest_chain_id: args.destChainId,
    status: "skipped",
    usdt_before: fmtAmount(usdtBefore),
  };

  if (usdtBefore < minUsdtWei) {
    result.reason = `USDT balance below min (${fmtAmount(minUsdtWei)})`;
    return result;
  }

  let amount;
  try {
    amount = await resolveBridgeAmount(usdt, wallet.address, args.amount);
  } catch (err) {
    result.reason = err.message;
    return result;
  }

  if (amount === 0n) {
    result.reason = "zero USDT balance";
    return result;
  }

  const minGasCost = gasPrice * BigInt(args.gasLimitApprove + args.gasLimitBridge);
  if (pgaBefore < minGasCost) {
    result.reason = `insufficient PGA for gas (need ~${fmtAmount(minGasCost)} PGA)`;
    return result;
  }

  console.log(
    `  bridge ${fmtAmount(amount)} USDT -> chain ${args.destChainId}, recipient ${recipient}`
  );

  await ensureApproval(wallet, usdt, bridgeContract, amount, {
    gasPrice,
    gasLimit: args.gasLimitApprove,
    dryRun: args.dryRun,
  });

  const bridgeHash = await bridgeUsdt(
    wallet,
    bridgeContract,
    PGP_USDT,
    recipient,
    amount,
    args.destChainId,
    {
      gasPrice,
      gasLimit: args.gasLimitBridge,
      dryRun: args.dryRun,
    }
  );
  console.log(`    bridge tx: ${bridgeHash}`);

  const usdtAfter = await usdt.balanceOf(wallet.address);
  Object.assign(result, {
    status: "ok",
    bridge_tx: bridgeHash,
    usdt_bridged: fmtAmount(amount),
    usdt_after: fmtAmount(usdtAfter),
    explorer: `https://pgp.elastos.io/tx/${bridgeHash}`,
  });

  return result;
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

  const provider = new JsonRpcProvider(args.rpc, PGP_CHAIN_ID);
  try {
    await provider.getBlockNumber();
  } catch {
    console.error(`error: cannot connect to RPC ${args.rpc}`);
    process.exit(1);
  }

  const bridgeContract = process.env.BRIDGE_CONTRACT || BRIDGE_CONTRACT;

  console.log("PGP USDT -> BSC bridge");
  console.log(`  RPC:           ${args.rpc}`);
  console.log(`  chainId:       ${PGP_CHAIN_ID}`);
  console.log(`  bridge:        ${bridgeContract}`);
  console.log(`  PGP USDT:      ${PGP_USDT}`);
  console.log(`  dest chain:    ${args.destChainId}`);
  console.log(`  wallets:       ${jobs.length}`);
  console.log(`  amount:        ${args.amount}`);
  console.log(`  mode:          ${args.dryRun ? "DRY RUN" : "LIVE"}`);

  if (!args.yes && !args.dryRun) {
    const proceed = await confirmProceed("\nProceed with live bridge transactions? [y/N] ");
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
      const result = await processWallet(provider, job, args);
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

  const summaryPath = join(__dirname, "bridge-results.json");
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);

  const ok = results.filter((r) => r.status === "ok").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  console.log(`\nDone: ok=${ok}, skipped=${skipped}, failed=${failed}`);
  console.log(`Results saved to ${summaryPath}`);
  console.log("Note: BSC arrival may take several minutes after PGP tx confirms.");

  process.exit(failed === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
