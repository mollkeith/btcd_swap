/**
 * CSV read/write for wallet batches.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function escapeCsvField(value) {
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export function writeWalletsCsv(path, rows, { includePrivateKey = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });

  const header = includePrivateKey
    ? "index,address,private_key"
    : "index,address";

  const lines = rows.map((row) => {
    const base = [row.index, row.address];
    if (includePrivateKey) {
      base.push(row.privateKey);
    }
    return base.map(escapeCsvField).join(",");
  });

  writeFileSync(path, `${header}\n${lines.join("\n")}\n`);
}

export function readWalletsCsv(path, { requirePrivateKey = false } = {}) {
  const content = readFileSync(path, "utf8").trim();
  if (!content) {
    throw new Error(`CSV file is empty: ${path}`);
  }

  const lines = content.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());

  const indexCol = header.indexOf("index");
  const addressCol = header.indexOf("address");
  const keyCol = header.indexOf("private_key");

  if (addressCol === -1) {
    throw new Error(`CSV missing 'address' column: ${path}`);
  }
  if (requirePrivateKey && keyCol === -1) {
    throw new Error(`CSV missing 'private_key' column: ${path}`);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const fields = parseCsvLine(lines[i]);
    const address = (fields[addressCol] || "").trim();
    if (!address) continue;

    const privateKey = keyCol >= 0 ? (fields[keyCol] || "").trim() : "";
    if (requirePrivateKey && !privateKey) {
      throw new Error(`Row ${i + 1} missing private_key in ${path}`);
    }

    rows.push({
      index: indexCol >= 0 ? Number(fields[indexCol]) || i : i,
      address,
      private_key: privateKey,
    });
  }

  if (!rows.length) {
    throw new Error(`No wallet rows found in ${path}`);
  }

  return rows;
}
