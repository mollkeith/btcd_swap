/**
 * Shared helpers for btcd-swap scripts.
 */

import { formatUnits } from "ethers";

export function loadWalletsFromEnv() {
  const jobs = [];

  if (process.env.WALLET_PRIVATE_KEY_1) {
    for (let i = 1; ; i += 1) {
      const key = (process.env[`WALLET_PRIVATE_KEY_${i}`] || "").trim();
      if (!key) break;
      jobs.push({ privateKey: key, label: `wallet-${i}` });
    }
    return jobs;
  }

  const multi = (process.env.WALLET_PRIVATE_KEYS || "").trim();
  if (multi) {
    multi.split(",").forEach((part, i) => {
      const key = part.trim();
      if (key) jobs.push({ privateKey: key, label: `wallet-${i + 1}` });
    });
    if (jobs.length) return jobs;
  }

  const single = (process.env.WALLET_PRIVATE_KEY || "").trim();
  if (single) {
    return [{ privateKey: single, label: "wallet-1" }];
  }

  throw new Error(
    "No wallet private keys found in .env. " +
      "Set WALLET_PRIVATE_KEY, WALLET_PRIVATE_KEYS, or WALLET_PRIVATE_KEY_1 ..."
  );
}

export function fmtAmount(value, decimals = 18) {
  return formatUnits(value, decimals).replace(/\.?0+$/, "");
}

export async function confirmProceed(message = "\nProceed with live transactions? [y/N] ") {
  const { createInterface } = await import("node:readline/promises");
  const { stdin: input, stdout: output } = await import("node:process");
  const rl = createInterface({ input, output });
  const answer = await rl.question(message);
  rl.close();
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

export async function sendLegacyTx(wallet, tx, { dryRun }) {
  if (dryRun) {
    return "dry-run";
  }

  const response = await wallet.sendTransaction(tx);
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`transaction reverted: ${response.hash}`);
  }
  return response.hash;
}

export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
