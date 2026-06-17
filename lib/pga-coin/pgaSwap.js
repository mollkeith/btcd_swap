import { Contract, Interface, Wallet, parseUnits } from "ethers";
import { PGP, ERC20_ABI } from "../constants.js";
import { fmtAmount, sendLegacyTx } from "../common.js";
import { PGACOIN_PGP, PGACOIN_GAS } from "./constants.js";
import { ensureErc20Approval } from "../fist/approve.js";

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function FastSwapTokenToEth(uint256 amountIn, uint256 amountOutMin, address tokenIn, address to, uint256 deadline) returns (uint256)",
];

export async function resolveBtcdAmount(btcd, address, amountArg) {
  const balance = await btcd.balanceOf(address);
  if (amountArg === "all") return balance;
  const requested = parseUnits(amountArg, PGACOIN_PGP.BTCD_DECIMALS);
  if (requested > balance) {
    throw new Error(`requested ${fmtAmount(requested)} BTCD but balance is ${fmtAmount(balance)}`);
  }
  return requested;
}

/** Estimate native PGA out via the [BTCD, WPGA] pool path. */
export async function estimatePgaOut(provider, amountIn) {
  const router = new Contract(PGACOIN_PGP.ROUTER, ROUTER_ABI, provider);
  const amounts = await router.getAmountsOut(amountIn, [PGACOIN_PGP.BTCD, PGACOIN_PGP.WPGA]);
  return amounts[1];
}

export function applySlippage(amountOut, slippageBps) {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** PGA per 1 BTCD at current pool price. */
export function pgaPerBtcd(amountInWei, pgaOutWei) {
  if (amountInWei === 0n) return 0;
  return Number(pgaOutWei) / Number(amountInWei);
}

export function formatPgaPerBtcd(amountInWei, pgaOutWei) {
  const rate = pgaPerBtcd(amountInWei, pgaOutWei);
  if (!Number.isFinite(rate) || rate === 0) return "N/A";
  return rate.toFixed(6);
}

/** Preview BTCD -> native PGA swap for one wallet (no transactions). */
export async function previewBtcdToPgaSwap(provider, job, options) {
  const { amountArg = "all", minBtcdWei, slippageBps = 100 } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(PGACOIN_PGP.BTCD, ERC20_ABI, wallet);

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
    amountIn = await resolveBtcdAmount(btcd, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amountIn === 0n) {
    result.reason = "zero BTCD balance";
    return result;
  }

  const expectedOut = await estimatePgaOut(provider, amountIn);
  const amountOutMin = applySlippage(expectedOut, slippageBps);

  return {
    ...result,
    status: "ready",
    btcd_in: fmtAmount(amountIn),
    btcd_in_wei: amountIn,
    pga_estimated: fmtAmount(expectedOut),
    pga_min_out: fmtAmount(amountOutMin),
    pga_estimated_wei: expectedOut,
    pga_min_out_wei: amountOutMin,
    pga_per_btcd: formatPgaPerBtcd(amountIn, expectedOut),
    slippage_bps: slippageBps,
  };
}

export async function approveBtcdForRouter(provider, job, options) {
  const {
    amountArg = "all",
    minBtcdWei,
    gasPrice,
    gasLimit = PGACOIN_GAS.gasLimitApproveBtcd,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(PGACOIN_PGP.BTCD, ERC20_ABI, wallet);
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
    amount = await resolveBtcdAmount(btcd, wallet.address, amountArg);
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
    PGACOIN_PGP.BTCD,
    PGACOIN_PGP.ROUTER,
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

export async function swapBtcdToPga(provider, job, options) {
  const {
    amountArg = "all",
    minBtcdWei,
    slippageBps = 100,
    gasPrice,
    gasLimitApprove = PGACOIN_GAS.gasLimitApproveBtcd,
    gasLimitSwap = PGACOIN_GAS.gasLimitSwapBtcdPga,
    dryRun,
    deadlineSec = 1200,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(PGACOIN_PGP.BTCD, ERC20_ABI, wallet);
  const routerIface = new Interface(ROUTER_ABI);

  const btcdBefore = await btcd.balanceOf(wallet.address);
  const pgaBefore = await provider.getBalance(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    btcd_before: fmtAmount(btcdBefore),
    pga_before: fmtAmount(pgaBefore),
  };

  if (btcdBefore < minBtcdWei) {
    result.reason = `BTCD below min (${fmtAmount(minBtcdWei)})`;
    return result;
  }

  let amountIn;
  try {
    amountIn = await resolveBtcdAmount(btcd, wallet.address, amountArg);
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

  const expectedOut = await estimatePgaOut(provider, amountIn);
  const amountOutMin = applySlippage(expectedOut, slippageBps);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);

  const approveRes = await ensureErc20Approval(
    wallet,
    PGACOIN_PGP.BTCD,
    PGACOIN_PGP.ROUTER,
    amountIn,
    { gasPrice, gasLimit: gasLimitApprove, chainId: PGP.CHAIN_ID, dryRun }
  );
  if (approveRes.hash) result.approve_tx = approveRes.hash;

  // FastSwapTokenToEth(amountIn, amountOutMin, tokenIn, to, deadline) -> native PGA to `to`
  const data = routerIface.encodeFunctionData("FastSwapTokenToEth", [
    amountIn,
    amountOutMin,
    PGACOIN_PGP.BTCD,
    wallet.address,
    deadline,
  ]);

  const swapHash = await sendLegacyTx(
    wallet,
    {
      to: PGACOIN_PGP.ROUTER,
      value: 0n,
      data,
      gasLimit: gasLimitSwap,
      gasPrice,
      chainId: PGP.CHAIN_ID,
      type: 0,
    },
    { dryRun }
  );

  const btcdAfter = await btcd.balanceOf(wallet.address);
  const pgaAfter = await provider.getBalance(wallet.address);

  return {
    ...result,
    status: "ok",
    swap_tx: swapHash,
    btcd_swapped: fmtAmount(amountIn),
    pga_estimated: fmtAmount(expectedOut),
    pga_min_out: fmtAmount(amountOutMin),
    btcd_after: fmtAmount(btcdAfter),
    pga_after: fmtAmount(pgaAfter),
    // native balance delta = PGA received minus gas spent on approve+swap
    pga_balance_delta: fmtAmount(pgaAfter - pgaBefore),
  };
}
