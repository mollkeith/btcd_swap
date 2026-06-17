import { Contract, Wallet, parseUnits } from "ethers";
import { PGP, ERC20_ABI } from "../constants.js";
import { fmtAmount } from "../common.js";
import { bridgeUsdt as bridgeToken } from "../bridge.js";
import { FIST_PGP, FIST_GAS } from "./constants.js";
import { ensureErc20Approval } from "./approve.js";

export async function resolveFistAmount(fist, address, amountArg) {
  const balance = await fist.balanceOf(address);
  if (amountArg === "all") return balance;
  const requested = parseUnits(amountArg, FIST_PGP.FIST_DECIMALS);
  if (requested > balance) {
    throw new Error(`requested ${fmtAmount(requested)} FIST but balance is ${fmtAmount(balance)}`);
  }
  return requested;
}

export async function approveFistForBridge(provider, job, options) {
  const {
    amountArg = "all",
    minFistWei,
    bridgeContract = FIST_PGP.BRIDGE,
    gasPrice,
    gasLimit = FIST_GAS.gasLimitApproveFistPg,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const fist = new Contract(FIST_PGP.FIST, ERC20_ABI, wallet);
  const balance = await fist.balanceOf(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    status: "skipped",
    fist_before: fmtAmount(balance),
  };

  if (balance < minFistWei) {
    result.reason = `FIST below min (${fmtAmount(minFistWei)})`;
    return result;
  }

  let amount;
  try {
    amount = await resolveFistAmount(fist, wallet.address, amountArg);
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
    FIST_PGP.FIST,
    bridgeContract,
    amount,
    { gasPrice, gasLimit, chainId: PGP.CHAIN_ID, dryRun }
  );

  return {
    ...result,
    status: "ok",
    approve_tx: hash,
    approve_skipped: skipped,
    fist_approved: fmtAmount(amount),
  };
}

export async function bridgeFistToBsc(provider, job, options) {
  const {
    amountArg = "all",
    minFistWei,
    bridgeContract = FIST_PGP.BRIDGE,
    destChainId = FIST_PGP.BRIDGE_DEST_CHAIN_ID,
    recipient: recipientOverride = "",
    gasPrice,
    gasLimitApprove = FIST_GAS.gasLimitApproveFistPg,
    gasLimitBridge = FIST_GAS.gasLimitBridgeFist,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const fist = new Contract(FIST_PGP.FIST, ERC20_ABI, wallet);
  const recipient = recipientOverride || wallet.address;

  const fistBefore = await fist.balanceOf(wallet.address);
  const pgaBefore = await provider.getBalance(wallet.address);

  const result = {
    label: job.label,
    address: wallet.address,
    recipient,
    status: "skipped",
    fist_before: fmtAmount(fistBefore),
  };

  if (fistBefore < minFistWei) {
    result.reason = `FIST below min (${fmtAmount(minFistWei)})`;
    return result;
  }

  let amount;
  try {
    amount = await resolveFistAmount(fist, wallet.address, amountArg);
  } catch (err) {
    result.reason = err.message;
    return result;
  }
  if (amount === 0n) {
    result.reason = "zero FIST balance";
    return result;
  }

  const minGas = gasPrice * BigInt(gasLimitApprove + gasLimitBridge);
  if (pgaBefore < minGas) {
    result.reason = `insufficient PGA for gas (need ~${fmtAmount(minGas)})`;
    return result;
  }

  const approveRes = await ensureErc20Approval(
    wallet,
    FIST_PGP.FIST,
    bridgeContract,
    amount,
    { gasPrice, gasLimit: gasLimitApprove, chainId: PGP.CHAIN_ID, dryRun }
  );
  if (approveRes.hash) result.approve_tx = approveRes.hash;

  const bridgeHash = await bridgeToken(
    wallet,
    bridgeContract,
    FIST_PGP.FIST,
    recipient,
    amount,
    destChainId,
    { gasPrice, gasLimit: gasLimitBridge, dryRun }
  );

  const fistAfter = await fist.balanceOf(wallet.address);
  return {
    ...result,
    status: "ok",
    bridge_tx: bridgeHash,
    fist_bridged: fmtAmount(amount),
    fist_after: fmtAmount(fistAfter),
    explorer: bridgeHash === "dry-run" ? null : `https://pgp.elastos.io/tx/${bridgeHash}`,
  };
}
