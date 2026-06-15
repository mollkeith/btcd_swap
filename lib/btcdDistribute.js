import { parseUnits, formatUnits } from "ethers";

/**
 * Split totalWei across wallets. Always distributes the full total (zero remainder).
 *
 * Modes:
 * - normal:   total >= count×min and total <= count×max
 * - exceed:   total > count×max — first N-1 get max, last absorbs remainder
 * - topup:    total < count×min and some wallets already hold BTCD — fund only those
 * - fallback: total < count×min and no wallet holds BTCD — relax min to 0
 */
export function allocateBtcdAmounts(totalWei, count, minBtcd, maxBtcd, options = {}) {
  const { fundedMask = null } = options;

  if (count <= 0) {
    throw new Error("wallet count must be > 0");
  }
  if (totalWei <= 0n) {
    throw new Error("BTCD balance is zero");
  }

  const minWei = parseUnits(String(minBtcd), 18);
  const maxWei = parseUnits(String(maxBtcd), 18);
  const minTotal = minWei * BigInt(count);
  const maxTotal = maxWei * BigInt(count);

  const amounts = Array(count).fill(0n);
  let mode;

  if (totalWei > maxTotal) {
    mode = "exceed";
    let remaining = totalWei;
    for (let i = 0; i < count; i += 1) {
      if (i === count - 1) {
        amounts[i] = remaining;
      } else {
        amounts[i] = maxWei;
        remaining -= maxWei;
      }
    }
  } else if (totalWei >= minTotal) {
    mode = "normal";
    const split = splitWithMinMax(totalWei, count, minWei, maxWei);
    for (let i = 0; i < count; i += 1) {
      amounts[i] = split[i];
    }
  } else {
    const mask = fundedMask ?? Array(count).fill(false);
    const fundedIndices = mask.map((funded, i) => (funded ? i : -1)).filter((i) => i >= 0);

    if (fundedIndices.length > 0) {
      mode = "topup";
      const split = splitWithMinMax(totalWei, fundedIndices.length, 0n, totalWei);
      for (let j = 0; j < fundedIndices.length; j += 1) {
        amounts[fundedIndices[j]] = split[j];
      }
    } else {
      mode = "fallback";
      const split = splitWithMinMax(totalWei, count, 0n, maxWei);
      for (let i = 0; i < count; i += 1) {
        amounts[i] = split[i];
      }
    }
  }

  return { amounts, distributeTotal: totalWei, mode };
}

export function describeAllocationMode(mode) {
  switch (mode) {
    case "normal":
      return "normal: random within [min, max], last wallet gets remainder";
    case "exceed":
      return "exceed: first N-1 at max, last wallet absorbs all remaining BTCD";
    case "topup":
      return "topup: insufficient for all mins, sending only to already-funded wallets";
    case "fallback":
      return "fallback: insufficient for all mins, relaxing min to split across all wallets";
    default:
      return mode;
  }
}

function splitWithMinMax(totalWei, count, minWei, maxWei) {
  const amounts = [];
  let remaining = totalWei;

  for (let i = 0; i < count; i += 1) {
    const slotsLeft = count - i;

    if (slotsLeft === 1) {
      amounts.push(remaining);
      break;
    }

    const minForRest = minWei * BigInt(slotsLeft - 1);
    const maxForThis = remaining - minForRest;
    const upper = maxForThis < maxWei ? maxForThis : maxWei;

    if (upper < minWei) {
      throw new Error("cannot allocate BTCD within min/max constraints");
    }

    const amount = randomWeiBetween(minWei, upper);
    amounts.push(amount);
    remaining -= amount;
  }

  return amounts;
}

function randomWeiBetween(minWei, maxWei) {
  if (minWei >= maxWei) {
    return minWei;
  }

  const min = Number(formatUnits(minWei, 18));
  const max = Number(formatUnits(maxWei, 18));
  const value = min + Math.random() * (max - min);
  return parseUnits(value.toFixed(8), 18);
}
