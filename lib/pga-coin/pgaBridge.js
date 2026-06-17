import { Interface, Wallet, parseUnits } from "ethers";
import { PGP } from "../constants.js";
import { fmtAmount, sendLegacyTx } from "../common.js";
import { PGACOIN_PGP, PGACOIN_GAS } from "./constants.js";

/**
 * Native PGA bridge. PGA is the native coin AND the gas token, so:
 *   - amount is sent as msg.value (no ERC-20 approve)
 *   - we must keep a gas reserve so the BridgeEth tx itself can pay for gas
 *
 * BridgeEth(address recipient, uint256 destChainId) payable, selector 0x94f3aecf.
 */
const BRIDGE_ABI = [
  "function BridgeEth(address recipient, uint256 destChainId) payable returns (bool)",
];

export async function bridgePgaToBsc(provider, job, options) {
  const {
    amountArg = "all",
    minPgaWei = 0n,
    reserveWei, // PGA kept for gas; default = 2x this tx's gas cost
    bridgeContract = PGACOIN_PGP.BRIDGE,
    destChainId = PGACOIN_PGP.BRIDGE_DEST_CHAIN_ID,
    recipient: recipientOverride = "",
    gasPrice,
    gasLimitBridge = PGACOIN_GAS.gasLimitBridgePga,
    dryRun,
  } = options;

  const wallet = new Wallet(job.privateKey, provider);
  const recipient = recipientOverride || wallet.address;
  const balance = await provider.getBalance(wallet.address);

  const gasCost = gasPrice * BigInt(gasLimitBridge);
  const reserve = reserveWei !== undefined ? reserveWei : gasCost * 2n;

  const result = {
    label: job.label,
    address: wallet.address,
    recipient,
    dest_chain_id: destChainId,
    status: "skipped",
    pga_before: fmtAmount(balance),
    pga_reserved: fmtAmount(reserve),
  };

  if (balance <= reserve) {
    result.reason = `PGA balance ${fmtAmount(balance)} <= gas reserve ${fmtAmount(reserve)}`;
    return result;
  }

  const maxBridgeable = balance - reserve;

  let amount;
  if (amountArg === "all") {
    amount = maxBridgeable;
  } else {
    const requested = parseUnits(amountArg, PGACOIN_PGP.PGA_DECIMALS);
    if (requested > maxBridgeable) {
      result.reason = `requested ${fmtAmount(requested)} PGA but only ${fmtAmount(maxBridgeable)} bridgeable after gas reserve`;
      return result;
    }
    amount = requested;
  }

  if (amount < minPgaWei) {
    result.reason = `bridgeable PGA ${fmtAmount(amount)} below min (${fmtAmount(minPgaWei)})`;
    return result;
  }
  if (amount <= 0n) {
    result.reason = "nothing to bridge after gas reserve";
    return result;
  }

  result.pga_to_bridge = fmtAmount(amount);

  const iface = new Interface(BRIDGE_ABI);
  const data = iface.encodeFunctionData("BridgeEth", [recipient, destChainId]);

  const bridgeHash = await sendLegacyTx(
    wallet,
    {
      to: bridgeContract,
      value: amount, // native PGA amount
      data,
      gasLimit: gasLimitBridge,
      gasPrice,
      chainId: PGP.CHAIN_ID,
      type: 0,
    },
    { dryRun }
  );

  const pgaAfter = await provider.getBalance(wallet.address);

  return {
    ...result,
    status: "ok",
    bridge_tx: bridgeHash,
    pga_bridged: fmtAmount(amount),
    pga_after: fmtAmount(pgaAfter),
    explorer: bridgeHash === "dry-run" ? null : `https://pgp.elastos.io/tx/${bridgeHash}`,
  };
}
