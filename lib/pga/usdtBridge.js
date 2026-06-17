import { Contract, Wallet } from "ethers";
import { PGP, ERC20_ABI } from "../constants.js";
import { fmtAmount } from "../common.js";
import { bridgeUsdt, resolveBridgeAmount } from "../bridge.js";
import { ensureErc20Approval } from "../fist/approve.js";
import { PGA_PIPELINE, PGA_GAS } from "./constants.js";

export async function approveUsdtForBridge(provider, job, options) {
  const {
    amountArg = "all",
    minUsdtWei,
    bridgeContract = PGA_PIPELINE.BRIDGE,
    gasPrice,
    gasLimit = PGA_GAS.gasLimitApproveUsdt,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const usdt = new Contract(PGA_PIPELINE.USDT, ERC20_ABI, wallet);
  const balance = await usdt.balanceOf(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    usdt_before: fmtAmount(balance),
  };

  if (balance < minUsdtWei) {
    result.reason = `USDT below min (${fmtAmount(minUsdtWei)})`;
    return result;
  }

  let amount;
  try {
    amount = await resolveBridgeAmount(usdt, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amount === 0n) {
    result.reason = "zero USDT balance";
    return result;
  }

  const { hash, skipped } = await ensureErc20Approval(
    wallet,
    PGA_PIPELINE.USDT,
    bridgeContract,
    amount,
    { gasPrice, gasLimit, chainId: PGP.CHAIN_ID, dryRun }
  );

  return {
    ...result,
    status: "ok",
    approve_tx: hash,
    approve_skipped: skipped,
    usdt_approved: fmtAmount(amount),
  };
}

export async function bridgeUsdtToBsc(provider, job, options) {
  const {
    amountArg = "all",
    minUsdtWei,
    bridgeContract = PGA_PIPELINE.BRIDGE,
    destChainId = PGA_PIPELINE.BRIDGE_DEST_CHAIN_ID,
    recipient: recipientOverride = "",
    gasPrice,
    gasLimitApprove = PGA_GAS.gasLimitApproveUsdt,
    gasLimitBridge = PGA_GAS.gasLimitBridgeUsdt,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const usdt = new Contract(PGA_PIPELINE.USDT, ERC20_ABI, wallet);
  const recipient = recipientOverride || wallet.address;

  const usdtBefore = await usdt.balanceOf(wallet.address);
  const pgaBefore = await provider.getBalance(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    recipient,
    dest_chain_id: destChainId,
    status: "skipped",
    usdt_before: fmtAmount(usdtBefore),
  };

  if (usdtBefore < minUsdtWei) {
    result.reason = `USDT below min (${fmtAmount(minUsdtWei)})`;
    return result;
  }

  let amount;
  try {
    amount = await resolveBridgeAmount(usdt, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amount === 0n) {
    result.reason = "zero USDT balance";
    return result;
  }

  const minGas = gasPrice * BigInt(gasLimitApprove + gasLimitBridge);
  if (pgaBefore < minGas) {
    result.reason = `insufficient PGA for gas (need ~${fmtAmount(minGas)})`;
    return result;
  }

  const approveRes = await ensureErc20Approval(
    wallet,
    PGA_PIPELINE.USDT,
    bridgeContract,
    amount,
    { gasPrice, gasLimit: gasLimitApprove, chainId: PGP.CHAIN_ID, dryRun }
  );
  if (approveRes.hash) result.approve_tx = approveRes.hash;

  const bridgeHash = await bridgeUsdt(
    wallet,
    bridgeContract,
    PGA_PIPELINE.USDT,
    recipient,
    amount,
    destChainId,
    { gasPrice, gasLimit: gasLimitBridge, dryRun }
  );

  const usdtAfter = await usdt.balanceOf(wallet.address);

  return {
    ...result,
    status: "ok",
    bridge_tx: bridgeHash,
    usdt_bridged: fmtAmount(amount),
    usdt_after: fmtAmount(usdtAfter),
  };
}
