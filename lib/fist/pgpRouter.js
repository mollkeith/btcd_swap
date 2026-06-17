import { Contract, Interface, Wallet, parseUnits } from "ethers";
import { PGP, ERC20_ABI } from "../constants.js";
import { fmtAmount, sendLegacyTx } from "../common.js";
import { FIST_PGP, FIST_GAS } from "./constants.js";
import { ensureErc20Approval } from "./approve.js";

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function FastSwapTokenToToken(uint256 amountIn, uint256 amountOutMin, address tokena, address tokenb, address to, uint256 deadline)",
];

export async function resolveBtcdAmount(btcd, address, amountArg) {
  const balance = await btcd.balanceOf(address);
  if (amountArg === "all") return balance;
  const requested = parseUnits(amountArg, FIST_PGP.BTCD_DECIMALS);
  if (requested > balance) {
    throw new Error(`requested ${fmtAmount(requested)} BTCD but balance is ${fmtAmount(balance)}`);
  }
  return requested;
}

export async function estimateFistOut(provider, amountIn) {
  const router = new Contract(FIST_PGP.ROUTER, ROUTER_ABI, provider);
  const amounts = await router.getAmountsOut(amountIn, [FIST_PGP.BTCD, FIST_PGP.FIST]);
  return amounts[1];
}

export function applySlippage(amountOut, slippageBps) {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** FIST per 1 BTCD at current pool price. */
export function fistPerBtcd(amountInWei, fistOutWei) {
  if (amountInWei === 0n) return 0;
  return Number(fistOutWei) / Number(amountInWei);
}

export function formatFistPerBtcd(amountInWei, fistOutWei) {
  const rate = fistPerBtcd(amountInWei, fistOutWei);
  if (!Number.isFinite(rate) || rate === 0) return "N/A";
  return rate.toFixed(6);
}

/**
 * Preview swap for one wallet (no transactions).
 */
export async function previewBtcdToFistSwap(provider, job, options) {
  const { amountArg = "all", minBtcdWei, slippageBps = 100 } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(FIST_PGP.BTCD, ERC20_ABI, wallet);

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

  const expectedOut = await estimateFistOut(provider, amountIn);
  const amountOutMin = applySlippage(expectedOut, slippageBps);

  return {
    ...result,
    status: "ready",
    btcd_in: fmtAmount(amountIn),
    btcd_in_wei: amountIn,
    fist_estimated: fmtAmount(expectedOut),
    fist_min_out: fmtAmount(amountOutMin),
    fist_estimated_wei: expectedOut,
    fist_min_out_wei: amountOutMin,
    fist_per_btcd: formatFistPerBtcd(amountIn, expectedOut),
    slippage_bps: slippageBps,
  };
}

export async function approveBtcdForRouter(provider, job, options) {
  const {
    amountArg = "all",
    minBtcdWei,
    gasPrice,
    gasLimit = FIST_GAS.gasLimitApprovePg,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(FIST_PGP.BTCD, ERC20_ABI, wallet);
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
    FIST_PGP.BTCD,
    FIST_PGP.ROUTER,
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

export async function swapBtcdToFist(provider, job, options) {
  const {
    amountArg = "all",
    minBtcdWei,
    slippageBps = 100,
    gasPrice,
    gasLimitApprove = FIST_GAS.gasLimitApprovePg,
    gasLimitSwap = FIST_GAS.gasLimitSwapBtcdFist,
    dryRun,
    deadlineSec = 1200,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const btcd = new Contract(FIST_PGP.BTCD, ERC20_ABI, wallet);
  const fist = new Contract(FIST_PGP.FIST, ERC20_ABI, provider);
  const routerIface = new Interface(ROUTER_ABI);

  const btcdBefore = await btcd.balanceOf(wallet.address);
  const fistBefore = await fist.balanceOf(wallet.address);
  const pgaBefore = await provider.getBalance(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    btcd_before: fmtAmount(btcdBefore),
    fist_before: fmtAmount(fistBefore),
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

  const expectedOut = await estimateFistOut(provider, amountIn);
  const amountOutMin = applySlippage(expectedOut, slippageBps);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);

  const approveRes = await ensureErc20Approval(
    wallet,
    FIST_PGP.BTCD,
    FIST_PGP.ROUTER,
    amountIn,
    { gasPrice, gasLimit: gasLimitApprove, chainId: PGP.CHAIN_ID, dryRun }
  );
  if (approveRes.hash) result.approve_tx = approveRes.hash;

  const data = routerIface.encodeFunctionData("FastSwapTokenToToken", [
    amountIn,
    amountOutMin,
    FIST_PGP.BTCD,
    FIST_PGP.FIST,
    wallet.address,
    deadline,
  ]);

  const swapHash = await sendLegacyTx(
    wallet,
    {
      to: FIST_PGP.ROUTER,
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
  const fistAfter = await fist.balanceOf(wallet.address);

  return {
    ...result,
    status: "ok",
    swap_tx: swapHash,
    btcd_swapped: fmtAmount(amountIn),
    fist_estimated: fmtAmount(expectedOut),
    fist_min_out: fmtAmount(amountOutMin),
    btcd_after: fmtAmount(btcdAfter),
    fist_after: fmtAmount(fistAfter),
    fist_received: fmtAmount(fistAfter - fistBefore),
  };
}
