import { Contract, Wallet, parseUnits } from "ethers";
import { PGP, ERC20_ABI } from "../constants.js";
import { fmtAmount, sendLegacyTx } from "../common.js";
import {
  encodeSwapData,
  readFeeBps,
  estimateUsdtOut,
  resolveSwapAmount,
} from "../swap.js";
import { ensureErc20Approval } from "../fist/approve.js";
import { PGA_PIPELINE, PGA_GAS } from "./constants.js";

export { readFeeBps, estimateUsdtOut };

export function formatUsdtPerBtcd(amountInWei, usdtOutWei) {
  if (amountInWei === 0n) return "N/A";
  const rate = Number(usdtOutWei) / Number(amountInWei);
  if (!Number.isFinite(rate) || rate === 0) return "N/A";
  return rate.toFixed(6);
}

export async function previewBtcdToUsdtSwap(provider, job, options) {
  const { amountArg = "all", minBtcdWei, feeBps } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(PGA_PIPELINE.BTCD, ERC20_ABI, wallet);

  const btcdBefore = await btcd.balanceOf(wallet.address);
  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    btcd_before: fmtAmount(btcdBefore),
  };

  if (btcdBefore < minBtcdWei) {
    result.reason = `BTCD below min (${fmtAmount(minBtcdWei)})`;
    return result;
  }

  let amountIn;
  try {
    amountIn = await resolveSwapAmount(btcd, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amountIn === 0n) {
    result.reason = "zero BTCD balance";
    return result;
  }

  const expectedOut = estimateUsdtOut(amountIn, feeBps);

  return {
    ...result,
    status: "ready",
    btcd_in: fmtAmount(amountIn),
    btcd_in_wei: amountIn,
    usdt_estimated: fmtAmount(expectedOut),
    usdt_estimated_wei: expectedOut,
    usdt_per_btcd: formatUsdtPerBtcd(amountIn, expectedOut),
    fee_bps: feeBps,
  };
}

export async function approveBtcdForSwap(provider, job, options) {
  const {
    amountArg = "all",
    minBtcdWei,
    swapContract = PGA_PIPELINE.SWAP_CONTRACT,
    gasPrice,
    gasLimit = PGA_GAS.gasLimitApproveBtcd,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(PGA_PIPELINE.BTCD, ERC20_ABI, wallet);
  const balance = await btcd.balanceOf(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    btcd_before: fmtAmount(balance),
  };

  if (balance < minBtcdWei) {
    result.reason = `BTCD below min (${fmtAmount(minBtcdWei)})`;
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

  const { hash, skipped } = await ensureErc20Approval(
    wallet,
    PGA_PIPELINE.BTCD,
    swapContract,
    amount,
    { gasPrice, gasLimit, chainId: PGP.CHAIN_ID, dryRun }
  );

  return {
    ...result,
    status: "ok",
    approve_tx: hash,
    approve_skipped: skipped,
    btcd_approved: fmtAmount(amount),
  };
}

async function swapBtcdToUsdtTx(wallet, swapContract, amount, opts) {
  const data = encodeSwapData(PGA_PIPELINE.BTCD, PGA_PIPELINE.USDT, amount);
  const nonce = await wallet.provider.getTransactionCount(wallet.address);
  return sendLegacyTx(
    wallet,
    {
      to: swapContract,
      value: 0n,
      data,
      nonce,
      gasLimit: opts.gasLimit,
      gasPrice: opts.gasPrice,
      chainId: PGP.CHAIN_ID,
      type: 0,
    },
    { dryRun: opts.dryRun }
  );
}

export async function swapBtcdToUsdt(provider, job, options) {
  const {
    amountArg = "all",
    minBtcdWei,
    feeBps,
    swapContract = PGA_PIPELINE.SWAP_CONTRACT,
    gasPrice,
    gasLimitApprove = PGA_GAS.gasLimitApproveBtcd,
    gasLimitSwap = PGA_GAS.gasLimitSwapBtcdUsdt,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(PGA_PIPELINE.BTCD, ERC20_ABI, wallet);
  const usdt = new Contract(PGA_PIPELINE.USDT, ERC20_ABI, provider);

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
    result.reason = `BTCD below min (${fmtAmount(minBtcdWei)})`;
    return result;
  }

  let amountIn;
  try {
    amountIn = await resolveSwapAmount(btcd, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amountIn === 0n) {
    result.reason = "zero BTCD balance";
    return result;
  }

  const minGas = gasPrice * BigInt(gasLimitApprove + gasLimitSwap);
  if (pgaBefore < minGas) {
    result.reason = `insufficient PGA for gas (need ~${fmtAmount(minGas)})`;
    return result;
  }

  const expectedOut = estimateUsdtOut(amountIn, feeBps);

  const approveRes = await ensureErc20Approval(
    wallet,
    PGA_PIPELINE.BTCD,
    swapContract,
    amountIn,
    { gasPrice, gasLimit: gasLimitApprove, chainId: PGP.CHAIN_ID, dryRun }
  );
  if (approveRes.hash) result.approve_tx = approveRes.hash;

  const swapHash = await swapBtcdToUsdtTx(wallet, swapContract, amountIn, {
    gasPrice,
    gasLimit: gasLimitSwap,
    dryRun,
  });

  const btcdAfter = await btcd.balanceOf(wallet.address);
  const usdtAfter = await usdt.balanceOf(wallet.address);

  return {
    ...result,
    status: "ok",
    swap_tx: swapHash,
    btcd_swapped: fmtAmount(amountIn),
    usdt_estimated: fmtAmount(expectedOut),
    fee_bps: feeBps,
    btcd_after: fmtAmount(btcdAfter),
    usdt_after: fmtAmount(usdtAfter),
    usdt_received: fmtAmount(usdtAfter - usdtBefore),
  };
}
