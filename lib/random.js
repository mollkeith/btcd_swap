import { parseUnits } from "ethers";
import { setTimeout as sleep } from "node:timers/promises";

export function randomBetween(min, max) {
  if (min > max) {
    throw new Error(`randomBetween: min (${min}) > max (${max})`);
  }
  return min + Math.random() * (max - min);
}

export function randomAmount(min, max, decimals = 18) {
  const lo = typeof min === "bigint" ? Number(min) : Number(min);
  const hi = typeof max === "bigint" ? Number(max) : Number(max);
  const value = randomBetween(lo, hi);
  const fixed = value.toFixed(Math.min(8, decimals));
  return parseUnits(fixed, decimals);
}

export async function randomDelay(delayMin, delayMax) {
  const min = Number(delayMin) || 0;
  const max = Number(delayMax) || 0;
  if (min <= 0 && max <= 0) {
    return 0;
  }
  const seconds = max > min ? randomBetween(min, max) : min;
  if (seconds > 0) {
    await sleep(seconds * 1000);
  }
  return seconds;
}
