import { parseUnits } from "ethers";
import { randomAmount } from "./random.js";

/**
 * Plan independent USDT amounts per wallet in [minUsdt, maxUsdt].
 * When min === max, every wallet gets the same amount.
 */
export function planUsdtTransfers(count, minUsdt, maxUsdt) {
  if (count <= 0) {
    throw new Error("wallet count must be > 0");
  }
  if (minUsdt > maxUsdt) {
    throw new Error("min must be <= max");
  }

  const amounts = [];
  for (let i = 0; i < count; i += 1) {
    amounts.push(randomAmount(minUsdt, maxUsdt, 18));
  }

  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  return {
    amounts,
    total,
    fixed: minUsdt === maxUsdt,
  };
}

export function minUsdtTotal(count, minUsdt) {
  return parseUnits(String(minUsdt), 18) * BigInt(count);
}
