import { Contract } from "ethers";
import { ERC20_ABI } from "../constants.js";
import { sendLegacyTx } from "../common.js";

export async function ensureErc20Approval(
  wallet,
  tokenAddress,
  spender,
  amount,
  { gasPrice, gasLimit, chainId, dryRun }
) {
  const token = new Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await token.allowance(wallet.address, spender);
  if (allowance >= amount) {
    return { hash: null, skipped: true };
  }

  const tx = await token.approve.populateTransaction(spender, amount);
  const hash = await sendLegacyTx(
    wallet,
    { ...tx, gasLimit, gasPrice, chainId, type: 0 },
    { dryRun }
  );
  return { hash, skipped: false };
}
