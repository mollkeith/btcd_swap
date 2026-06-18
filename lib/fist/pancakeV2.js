import { Contract, Interface, Wallet, parseUnits } from "ethers";
import { BSC, ERC20_ABI } from "../constants.js";
import { fmtAmount, sendLegacyTx } from "../common.js";
import { FIST_BSC, FIST_GAS } from "./constants.js";
import { ensureErc20Approval } from "./approve.js";

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
];

export async function resolveFistAmountBsc(fist, address, amountArg) {
  const balance = await fist.balanceOf(address);
  if (amountArg === "all") return balance;
  const requested = parseUnits(amountArg, FIST_BSC.FIST_DECIMALS);
  if (requested > balance) {
    throw new Error(`requested ${fmtAmount(requested, FIST_BSC.FIST_DECIMALS)} FIST but balance is ${fmtAmount(balance, FIST_BSC.FIST_DECIMALS)}`);
  }
  return requested;
}

export async function estimateUsdtOut(provider, amountIn) {
  const router = new Contract(FIST_BSC.PANCAKE_V2_ROUTER, ROUTER_ABI, provider);
  const amounts = await router.getAmountsOut(amountIn, [FIST_BSC.FIST, FIST_BSC.USDT]);
  return amounts[1];
}

export function applySlippage(amountOut, slippageBps) {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** USDT per 1 FIST (human-readable). */
export function formatUsdtPerFist(fistInWei, usdtOutWei) {
  if (fistInWei === 0n) return "N/A";
  const fistHuman = Number(fistInWei) / 10 ** FIST_BSC.FIST_DECIMALS;
  const usdtHuman = Number(usdtOutWei) / 10 ** FIST_BSC.USDT_DECIMALS;
  if (fistHuman === 0) return "N/A";
  return (usdtHuman / fistHuman).toFixed(6);
}

/**
 * Preview FIST -> USDT swap for one wallet (no transactions).
 */
export async function previewFistToUsdtSwap(provider, job, options) {
  const { amountArg = "all", minFistWei, slippageBps = 100 } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const fist = new Contract(FIST_BSC.FIST, ERC20_ABI, wallet);

  const fistBefore = await fist.balanceOf(wallet.address);
  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    fist_before: fmtAmount(fistBefore, FIST_BSC.FIST_DECIMALS),
  };

  if (fistBefore < minFistWei) {
    result.reason = `FIST below min (${fmtAmount(minFistWei, FIST_BSC.FIST_DECIMALS)})`;
    return result;
  }

  let amountIn;
  try {
    amountIn = await resolveFistAmountBsc(fist, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amountIn === 0n) {
    result.reason = "zero FIST balance";
    return result;
  }

  const expectedOut = await estimateUsdtOut(provider, amountIn);
  const amountOutMin = applySlippage(expectedOut, slippageBps);

  return {
    ...result,
    status: "ready",
    fist_in: fmtAmount(amountIn, FIST_BSC.FIST_DECIMALS),
    fist_in_wei: amountIn,
    usdt_estimated: fmtAmount(expectedOut),
    usdt_min_out: fmtAmount(amountOutMin),
    usdt_estimated_wei: expectedOut,
    usdt_min_out_wei: amountOutMin,
    usdt_per_fist: formatUsdtPerFist(amountIn, expectedOut),
    slippage_bps: slippageBps,
  };
}

export async function approveFistForPancake(provider, job, options) {
  const {
    amountArg = "all",
    minFistWei,
    gasPrice,
    gasLimit = FIST_GAS.gasLimitApproveFistBsc,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const fist = new Contract(FIST_BSC.FIST, ERC20_ABI, wallet);
  const balance = await fist.balanceOf(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    fist_before: fmtAmount(balance, FIST_BSC.FIST_DECIMALS),
  };

  if (balance < minFistWei) {
    result.reason = `FIST below min (${fmtAmount(minFistWei, FIST_BSC.FIST_DECIMALS)})`;
    return result;
  }

  let amount;
  try {
    amount = await resolveFistAmountBsc(fist, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amount === 0n) {
    result.reason = "zero FIST balance";
    return result;
  }

  const { hash, skipped } = await ensureErc20Approval(
    wallet,
    FIST_BSC.FIST,
    FIST_BSC.PANCAKE_V2_ROUTER,
    amount,
    { gasPrice, gasLimit, chainId: BSC.CHAIN_ID, dryRun }
  );

  return {
    ...result,
    status: "ok",
    approve_tx: hash,
    approve_skipped: skipped,
    fist_approved: fmtAmount(amount, FIST_BSC.FIST_DECIMALS),
  };
}

export async function swapFistToUsdt(provider, job, options) {
  const {
    amountArg = "all",
    minFistWei,
    slippageBps = 100,
    gasPrice,
    gasLimitApprove = FIST_GAS.gasLimitApproveFistBsc,
    gasLimitSwap = FIST_GAS.gasLimitPancakeSwap,
    dryRun,
    deadlineSec = 1200,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const fist = new Contract(FIST_BSC.FIST, ERC20_ABI, wallet);
  const usdt = new Contract(FIST_BSC.USDT, ERC20_ABI, provider);
  const routerIface = new Interface(ROUTER_ABI);

  const fistBefore = await fist.balanceOf(wallet.address);
  const usdtBefore = await usdt.balanceOf(wallet.address);
  const bnbBefore = await provider.getBalance(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    fist_before: fmtAmount(fistBefore, FIST_BSC.FIST_DECIMALS),
    usdt_before: fmtAmount(usdtBefore),
  };

  if (fistBefore < minFistWei) {
    result.reason = `FIST below min (${fmtAmount(minFistWei, FIST_BSC.FIST_DECIMALS)})`;
    return result;
  }

  let amountIn;
  try {
    amountIn = await resolveFistAmountBsc(fist, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amountIn === 0n) {
    result.reason = "zero FIST balance";
    return result;
  }

  const minGas = gasPrice * BigInt(gasLimitApprove + gasLimitSwap);
  if (bnbBefore < minGas) {
    const gwei = Number(gasPrice) / 1e9;
    result.reason =
      `insufficient BNB for gas (have ${fmtAmount(bnbBefore)}, need ~${fmtAmount(minGas)} ` +
      `at ${gwei} gwei, approve ${gasLimitApprove} + swap ${gasLimitSwap} gas)`;
    return result;
  }

  const expectedOut = await estimateUsdtOut(provider, amountIn);
  const amountOutMin = applySlippage(expectedOut, slippageBps);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);
  const path = [FIST_BSC.FIST, FIST_BSC.USDT];

  const approveRes = await ensureErc20Approval(
    wallet,
    FIST_BSC.FIST,
    FIST_BSC.PANCAKE_V2_ROUTER,
    amountIn,
    { gasPrice, gasLimit: gasLimitApprove, chainId: BSC.CHAIN_ID, dryRun }
  );
  if (approveRes.hash) result.approve_tx = approveRes.hash;

  const data = routerIface.encodeFunctionData("swapExactTokensForTokens", [
    amountIn,
    amountOutMin,
    path,
    wallet.address,
    deadline,
  ]);

  const swapHash = await sendLegacyTx(
    wallet,
    {
      to: FIST_BSC.PANCAKE_V2_ROUTER,
      value: 0n,
      data,
      gasLimit: gasLimitSwap,
      gasPrice,
      chainId: BSC.CHAIN_ID,
      type: 0,
    },
    { dryRun }
  );

  const fistAfter = await fist.balanceOf(wallet.address);
  const usdtAfter = await usdt.balanceOf(wallet.address);

  return {
    ...result,
    status: "ok",
    swap_tx: swapHash,
    fist_swapped: fmtAmount(amountIn, FIST_BSC.FIST_DECIMALS),
    usdt_estimated: fmtAmount(expectedOut),
    usdt_min_out: fmtAmount(amountOutMin),
    fist_after: fmtAmount(fistAfter, FIST_BSC.FIST_DECIMALS),
    usdt_after: fmtAmount(usdtAfter),
    usdt_received: fmtAmount(usdtAfter - usdtBefore),
  };
}
