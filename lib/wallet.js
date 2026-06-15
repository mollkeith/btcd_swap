import { Wallet } from "ethers";
import { readWalletsCsv } from "./csv.js";

export function loadMasterPrivateKeyFromEnv() {
  const key = (
    process.env.WALLET_PRIVATE_KEY ||
    process.env.MASTER_PRIVATE_KEY ||
    ""
  ).trim();
  if (!key) {
    throw new Error(
      "WALLET_PRIVATE_KEY not set in .env (master wallet for fund/collect)"
    );
  }
  return key;
}

export function loadMasterWallet(provider) {
  return new Wallet(loadMasterPrivateKeyFromEnv(), provider);
}

export function getCollectAddress(masterWallet) {
  const address = (process.env.COLLECT_ADDRESS || "").trim();
  return address || masterWallet.address;
}

export function loadWalletsFromCsv(path, { requirePrivateKey = true } = {}) {
  const rows = readWalletsCsv(path, { requirePrivateKey });
  return rows.map((row) => ({
    index: row.index,
    address: row.address,
    privateKey: row.private_key,
    label: `wallet-${row.index}`,
  }));
}
