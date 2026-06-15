import { Contract, Wallet, parseUnits } from "ethers";
import { PGP, DEFAULT_GAS, ERC20_ABI } from "./constants.js";
import { fmtAmount, sendLegacyTx } from "./common.js";

export function encodeSwapData(tokenIn, tokenOut, amount) {
  const tokenInHex = tokenIn.toLowerCase().replace("0x", "").padStart(64, "0");
  const tokenOutHex = tokenOut.toLowerCase().replace("0x", "").padStart(64, "0");
  const amountHex = amount.toString(16).padStart(64, "0");
  return PGP.SWAP_SELECTOR + tokenInHex + tokenOutHex + amountHex;
}

export async function readFeeBps(provider, swapContract = PGP.SWAP_CONTRACT) {
  const result = await provider.call({ to: swapContract, data: PGP.FEE_BPS_SELECTOR });
  return Number(BigInt(result));
}

export function estimateUsdtOut(amountIn, feeBps) {
  return (amountIn * BigInt(10_000 - feeBps)) / 10_000n;
}

async function ensureApproval(wallet, btcd, swapContract, amount, opts) {
  const allowance = await btcd.allowance(wallet.address, swapContract);
  if (allowance >= amount) return null;

  const tx = await btcd.approve.populateTransaction(swapContract, amount);
  return sendLegacyTx(wallet, {
    ...tx,
    gasLimit: opts.gasLimit,
    gasPrice: opts.gasPrice,
    chainId: PGP.CHAIN_ID,
    type: 0,
  }, { dryRun: opts.dryRun });
}

async function swapBtcdToUsdt(wallet, swapContract, amount, opts) {
  const data = encodeSwapData(PGP.BTCD_TOKEN, PGP.USDT_TOKEN, amount);
  const nonce = await wallet.provider.getTransactionCount(wallet.address);
  return sendLegacyTx(wallet, {
    to: swapContract,
    value: 0n,
    data,
    nonce,
    gasLimit: opts.gasLimit,
    gasPrice: opts.gasPrice,
    chainId: PGP.CHAIN_ID,
    type: 0,
  }, { dryRun: opts.dryRun });
}

export async function resolveSwapAmount(btcd, address, amountArg) {
  const balance = await btcd.balanceOf(address);
  if (amountArg === "all") return balance;
  const requested = parseUnits(amountArg, 18);
  if (requested > balance) {
    throw new Error(`requested ${fmtAmount(requested)} BTCD but balance is ${fmtAmount(balance)}`);
  }
  return requested;
}

export async function previewWalletBalances(provider, job) {
  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(PGP.BTCD_TOKEN, ERC20_ABI, provider);
  const usdt = new Contract(PGP.USDT_TOKEN, ERC20_ABI, provider);
  const btcdBal = await btcd.balanceOf(wallet.address);
  const usdtBal = await usdt.balanceOf(wallet.address);
  const pgaBal = await provider.getBalance(wallet.address);
  return {
    label: job.label,
    address: wallet.address,
    status: "preview",
    btcd: fmtAmount(btcdBal),
    usdt: fmtAmount(usdtBal),
    pga: fmtAmount(pgaBal),
  };
}

export async function processSwapWallet(provider, job, options) {
  const {
    amountArg = "all",
    minBtcdWei,
    swapContract = PGP.SWAP_CONTRACT,
    feeBps,
    gasPrice,
    gasLimitApprove = DEFAULT_GAS.gasLimitApprove,
    gasLimitSwap = DEFAULT_GAS.gasLimitSwap,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(PGP.BTCD_TOKEN, ERC20_ABI, wallet);
  const usdt = new Contract(PGP.USDT_TOKEN, ERC20_ABI, provider);

  const btcdBefore = await btcd.balanceOf(wallet.address);
  const usdtBefore = await usdt.balanceOf(wallet.address);
  const pgaBefore = await provider.getBalance(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    btcd_before: fmtAmount(btcdBefore),
    usdt_before: fmtAmount(usdtBefore),
    pga_before: fmtAmount(pgaBefore),
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

  const approveHash = await ensureApproval(wallet, btcd, swapContract, amount, {
    gasPrice, gasLimit: gasLimitApprove, dryRun,
  });
  if (approveHash) result.approve_tx = approveHash;

  const swapHash = await swapBtcdToUsdt(wallet, swapContract, amount, {
    gasPrice, gasLimit: gasLimitSwap, dryRun,
  });

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
