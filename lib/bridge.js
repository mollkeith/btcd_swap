import { Contract, Wallet, parseUnits, AbiCoder, JsonRpcProvider } from "ethers";
import { setTimeout as sleep } from "node:timers/promises";
import { PGP, BSC, DEFAULT_GAS, ERC20_ABI } from "./constants.js";
import { fmtAmount, sendLegacyTx } from "./common.js";

export function encodeBridgeData(token, recipient, amount, destChainId) {
  const coder = AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    ["address", "address", "uint256", "uint256"],
    [token, recipient, amount, destChainId]
  );
  return PGP.BRIDGE_SELECTOR + encoded.slice(2);
}

export async function ensureApproval(
  wallet,
  usdt,
  bridgeContract,
  amount,
  { gasPrice, gasLimit = DEFAULT_GAS.gasLimitApprove, dryRun, chainId = PGP.CHAIN_ID }
) {
  const allowance = await usdt.allowance(wallet.address, bridgeContract);
  if (allowance >= amount) {
    return null;
  }

  const tx = await usdt.approve.populateTransaction(bridgeContract, amount);
  const hash = await sendLegacyTx(
    wallet,
    {
      ...tx,
      gasLimit,
      gasPrice,
      chainId,
      type: 0,
    },
    { dryRun }
  );

  return hash;
}

export async function bridgeUsdt(
  wallet,
  bridgeContract,
  token,
  recipient,
  amount,
  destChainId,
  { gasPrice, gasLimit = DEFAULT_GAS.gasLimitBridge, dryRun, chainId = PGP.CHAIN_ID }
) {
  const data = encodeBridgeData(token, recipient, amount, destChainId);
  const nonce = await wallet.provider.getTransactionCount(wallet.address);

  return sendLegacyTx(
    wallet,
    {
      to: bridgeContract,
      value: 0n,
      data,
      nonce,
      gasLimit,
      gasPrice,
      chainId,
      type: 0,
    },
    { dryRun }
  );
}

export async function resolveBridgeAmount(usdt, address, amountArg) {
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

export async function processBridgeWallet(provider, job, options) {
  const {
    amountArg = "all",
    minUsdtWei,
    bridgeContract = PGP.BRIDGE_CONTRACT,
    destChainId = PGP.BRIDGE_DEST_CHAIN_ID,
    recipient: recipientOverride = "",
    gasPrice,
    gasLimitApprove = DEFAULT_GAS.gasLimitApprove,
    gasLimitBridge = DEFAULT_GAS.gasLimitBridge,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const usdt = new Contract(PGP.USDT_TOKEN, ERC20_ABI, wallet);
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
    result.reason = `USDT balance below min (${fmtAmount(minUsdtWei)})`;
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

  const minGasCost = gasPrice * BigInt(gasLimitApprove + gasLimitBridge);
  if (pgaBefore < minGasCost) {
    result.reason = `insufficient PGA for gas (need ~${fmtAmount(minGasCost)} PGA)`;
    return result;
  }

  result.usdt_to_bridge = fmtAmount(amount);

  const approveHash = await ensureApproval(wallet, usdt, bridgeContract, amount, {
    gasPrice,
    gasLimit: gasLimitApprove,
    dryRun,
  });
  if (approveHash) {
    result.approve_tx = approveHash;
  }

  const bridgeHash = await bridgeUsdt(
    wallet,
    bridgeContract,
    PGP.USDT_TOKEN,
    recipient,
    amount,
    destChainId,
    {
      gasPrice,
      gasLimit: gasLimitBridge,
      dryRun,
    }
  );

  const usdtAfter = await usdt.balanceOf(wallet.address);
  Object.assign(result, {
    status: "ok",
    bridge_tx: bridgeHash,
    usdt_bridged: fmtAmount(amount),
    usdt_after: fmtAmount(usdtAfter),
    explorer: bridgeHash === "dry-run" ? null : `https://pgp.elastos.io/tx/${bridgeHash}`,
  });

  return result;
}

/**
 * Poll BSC USDT balance until it reaches expected minimum or timeout.
 */
export async function checkBridgeArrival(
  bscAddress,
  {
    expectedMinWei,
    rpcUrl = BSC.RPC_URL,
    timeoutSec = 600,
    pollSec = 15,
    baselineWei = 0n,
  } = {}
) {
  const provider = new JsonRpcProvider(rpcUrl, BSC.CHAIN_ID);
  const usdt = new Contract(BSC.USDT_TOKEN, ERC20_ABI, provider);
  const target = baselineWei + (expectedMinWei || 0n);
  const deadline = Date.now() + timeoutSec * 1000;
  let last = baselineWei;

  while (Date.now() < deadline) {
    last = await usdt.balanceOf(bscAddress);
    if (last >= target) {
      return { arrived: true, balance: last, balance_fmt: fmtAmount(last) };
    }
    await sleep(pollSec * 1000);
  }

  return {
    arrived: false,
    balance: last,
    balance_fmt: fmtAmount(last),
    expected_min: fmtAmount(target),
  };
}
