import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./paths.js";

const INDEX_RE = /^(\d+)-wallets\.csv$/;

export function formatWalletIndex(n) {
  return String(n).padStart(2, "0");
}

/** Next available index in data/ -> 01, 02, ... */
export function nextWalletIndex(outDir = "data") {
  const dir = join(PROJECT_ROOT, outDir);
  if (!existsSync(dir)) {
    return "01";
  }

  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = INDEX_RE.exec(name);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return formatWalletIndex(max + 1);
}

export function walletCsvPaths(index, outDir = "data") {
  const id = formatWalletIndex(Number(index));
  const base = join(outDir, `${id}-wallets`);
  return {
    index: id,
    publicCsv: `${base}.csv`,
    privateCsv: `${base}-private.csv`,
  };
}

export function ensureWalletCsvNotExists(index, outDir = "data") {
  const paths = walletCsvPaths(index, outDir);
  const pubAbs = join(PROJECT_ROOT, paths.publicCsv);
  const privAbs = join(PROJECT_ROOT, paths.privateCsv);

  if (existsSync(pubAbs) || existsSync(privAbs)) {
    throw new Error(
      `Wallet CSV already exists for index ${paths.index}. ` +
        `Use the next index or remove existing files.`
    );
  }

  mkdirSync(join(PROJECT_ROOT, outDir), { recursive: true });
  return { ...paths, pubAbs, privAbs };
}

export function requireCsvPath(args) {
  const csv = (args.csv || "").trim();
  if (!csv) {
    throw new Error(
      `Missing --csv PATH.\n` +
        `  Example: --csv data/01-wallets.csv\n` +
        `  Run step 01 first; it prints the CSV paths to use.`
    );
  }
  return csv;
}
