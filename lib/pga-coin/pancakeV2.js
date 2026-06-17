import { Contract, Interface, Wallet, parseUnits } from "ethers";
import { BSC, ERC20_ABI } from "../constants.js";
import { fmtAmount, sendLegacyTx } from "../common.js";
import { PGACOIN_BSC, PGACOIN_GAS } from "./constants.js";
import { ensureErc20Approval } from "../fist/approve.js";

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  // PGA on BSC is a fee-on-transfer (taxed/deflationary) token — ~3.5% sell tax measured
  // on-chain. The plain swapExactTokensForTokens reverts with "Pancake: K" because the pair
  // receives less than amountIn; the fee-supporting variant swaps on the amount actually
  // received, so it must be used here. (getAmountsOut is the *pre-tax* quote — set slippage
  // above the tax, see scripts/pga-coin/09.)
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
];

export async function resolvePgaAmountBsc(pga, address, amountArg) {
  const balance = await pga.balanceOf(address);
  if (amountArg === "all") return balance;
  const requested = parseUnits(amountArg, PGACOIN_BSC.PGA_DECIMALS);
  if (requested > balance) {
    throw new Error(
      `requested ${fmtAmount(requested, PGACOIN_BSC.PGA_DECIMALS)} PGA but balance is ${fmtAmount(balance, PGACOIN_BSC.PGA_DECIMALS)}`
    );
  }
  return requested;
}

export async function estimateUsdtOut(provider, amountIn) {
  const router = new Contract(PGACOIN_BSC.PANCAKE_V2_ROUTER, ROUTER_ABI, provider);
  const amounts = await router.getAmountsOut(amountIn, [PGACOIN_BSC.PGA, PGACOIN_BSC.USDT]);
  return amounts[1];
}

export function applySlippage(amountOut, slippageBps) {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** USDT per 1 PGA (human-readable). */
export function formatUsdtPerPga(pgaInWei, usdtOutWei) {
  if (pgaInWei === 0n) return "N/A";
  const pgaHuman = Number(pgaInWei) / 10 ** PGACOIN_BSC.PGA_DECIMALS;
  const usdtHuman = Number(usdtOutWei) / 10 ** PGACOIN_BSC.USDT_DECIMALS;
  if (pgaHuman === 0) return "N/A";
  return (usdtHuman / pgaHuman).toFixed(6);
}

/** Preview PGA -> USDT swap for one wallet (no transactions). */
export async function previewPgaToUsdtSwap(provider, job, options) {
  const { amountArg = "all", minPgaWei, slippageBps = 100 } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const pga = new Contract(PGACOIN_BSC.PGA, ERC20_ABI, wallet);

  const pgaBefore = await pga.balanceOf(wallet.address);
  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    pga_before: fmtAmount(pgaBefore, PGACOIN_BSC.PGA_DECIMALS),
  };

  if (pgaBefore < minPgaWei) {
    result.reason = `PGA below min (${fmtAmount(minPgaWei, PGACOIN_BSC.PGA_DECIMALS)})`;
    return result;
  }

  let amountIn;
  try {
    amountIn = await resolvePgaAmountBsc(pga, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amountIn === 0n) {
    result.reason = "zero PGA balance";
    return result;
  }

  const expectedOut = await estimateUsdtOut(provider, amountIn);
  const amountOutMin = applySlippage(expectedOut, slippageBps);

  return {
    ...result,
    status: "ready",
    pga_in: fmtAmount(amountIn, PGACOIN_BSC.PGA_DECIMALS),
    pga_in_wei: amountIn,
    usdt_estimated: fmtAmount(expectedOut),
    usdt_min_out: fmtAmount(amountOutMin),
    usdt_estimated_wei: expectedOut,
    usdt_min_out_wei: amountOutMin,
    usdt_per_pga: formatUsdtPerPga(amountIn, expectedOut),
    slippage_bps: slippageBps,
  };
}

export async function approvePgaForPancake(provider, job, options) {
  const {
    amountArg = "all",
    minPgaWei,
    gasPrice,
    gasLimit = PGACOIN_GAS.gasLimitApprovePgaBsc,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const pga = new Contract(PGACOIN_BSC.PGA, ERC20_ABI, wallet);
  const balance = await pga.balanceOf(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    pga_before: fmtAmount(balance, PGACOIN_BSC.PGA_DECIMALS),
  };

  if (balance < minPgaWei) {
    result.reason = `PGA below min (${fmtAmount(minPgaWei, PGACOIN_BSC.PGA_DECIMALS)})`;
    return result;
  }

  let amount;
  try {
    amount = await resolvePgaAmountBsc(pga, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amount === 0n) {
    result.reason = "zero PGA balance";
    return result;
  }

  const { hash, skipped } = await ensureErc20Approval(
    wallet,
    PGACOIN_BSC.PGA,
    PGACOIN_BSC.PANCAKE_V2_ROUTER,
    amount,
    { gasPrice, gasLimit, chainId: BSC.CHAIN_ID, dryRun }
  );

  return {
    ...result,
    status: "ok",
    approve_tx: hash,
    approve_skipped: skipped,
    pga_approved: fmtAmount(amount, PGACOIN_BSC.PGA_DECIMALS),
  };
}

export async function swapPgaToUsdt(provider, job, options) {
  const {
    amountArg = "all",
    minPgaWei,
    slippageBps = 100,
    gasPrice,
    gasLimitApprove = PGACOIN_GAS.gasLimitApprovePgaBsc,
    gasLimitSwap = PGACOIN_GAS.gasLimitPancakeSwap,
    dryRun,
    deadlineSec = 1200,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const pga = new Contract(PGACOIN_BSC.PGA, ERC20_ABI, wallet);
  const usdt = new Contract(PGACOIN_BSC.USDT, ERC20_ABI, provider);
  const routerIface = new Interface(ROUTER_ABI);

  const pgaBefore = await pga.balanceOf(wallet.address);
  const usdtBefore = await usdt.balanceOf(wallet.address);
  const bnbBefore = await provider.getBalance(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    pga_before: fmtAmount(pgaBefore, PGACOIN_BSC.PGA_DECIMALS),
    usdt_before: fmtAmount(usdtBefore),
  };

  if (pgaBefore < minPgaWei) {
    result.reason = `PGA below min (${fmtAmount(minPgaWei, PGACOIN_BSC.PGA_DECIMALS)})`;
    return result;
  }

  let amountIn;
  try {
    amountIn = await resolvePgaAmountBsc(pga, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amountIn === 0n) {
    result.reason = "zero PGA balance";
    return result;
  }

  // Only count approve gas if an approve is actually still needed (allowance not yet set).
  const allowance = await pga.allowance(wallet.address, PGACOIN_BSC.PANCAKE_V2_ROUTER);
  const approveGas = allowance >= amountIn ? 0 : gasLimitApprove;
  const minGas = gasPrice * BigInt(approveGas + gasLimitSwap);
  if (bnbBefore < minGas) {
    result.reason = `insufficient BNB for gas (need ~${fmtAmount(minGas)})`;
    return result;
  }

  const expectedOut = await estimateUsdtOut(provider, amountIn);
  const amountOutMin = applySlippage(expectedOut, slippageBps);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);
  const path = [PGACOIN_BSC.PGA, PGACOIN_BSC.USDT];

  const approveRes = await ensureErc20Approval(
    wallet,
    PGACOIN_BSC.PGA,
    PGACOIN_BSC.PANCAKE_V2_ROUTER,
    amountIn,
    { gasPrice, gasLimit: gasLimitApprove, chainId: BSC.CHAIN_ID, dryRun }
  );
  if (approveRes.hash) result.approve_tx = approveRes.hash;

  const data = routerIface.encodeFunctionData(
    "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    [amountIn, amountOutMin, path, wallet.address, deadline]
  );

  const swapHash = await sendLegacyTx(
    wallet,
    {
      to: PGACOIN_BSC.PANCAKE_V2_ROUTER,
      value: 0n,
      data,
      gasLimit: gasLimitSwap,
      gasPrice,
      chainId: BSC.CHAIN_ID,
      type: 0,
    },
    { dryRun }
  );

  const pgaAfter = await pga.balanceOf(wallet.address);
  const usdtAfter = await usdt.balanceOf(wallet.address);

  return {
    ...result,
    status: "ok",
    swap_tx: swapHash,
    pga_swapped: fmtAmount(amountIn, PGACOIN_BSC.PGA_DECIMALS),
    usdt_estimated: fmtAmount(expectedOut),
    usdt_min_out: fmtAmount(amountOutMin),
    pga_after: fmtAmount(pgaAfter, PGACOIN_BSC.PGA_DECIMALS),
    usdt_after: fmtAmount(usdtAfter),
    usdt_received: fmtAmount(usdtAfter - usdtBefore),
  };
}
