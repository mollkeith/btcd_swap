/**
 * Plan a native BNB sweep: balance - gas, with estimateGas for contract recipients.
 */

export async function planBnbSweep(
  provider,
  { from, to, gasPrice, gasLimitFloor = 21_000, gasBuffer = 500 }
) {
  const balance = await provider.getBalance(from);
  let gasLimit = BigInt(gasLimitFloor);

  const code = await provider.getCode(to);
  if (code !== "0x" && gasLimit < 23_000n) {
    gasLimit = 23_000n;
  }

  for (let i = 0; i < 4; i += 1) {
    const gasCost = gasPrice * gasLimit;
    const sendValue = balance > gasCost ? balance - gasCost : 0n;
    if (sendValue === 0n) {
      return { balance, sendValue: 0n, gasLimit, gasCost };
    }

    try {
      const estimated = await provider.estimateGas({ from, to, value: sendValue });
      const buffered = estimated + BigInt(gasBuffer);
      if (buffered <= gasLimit) {
        return { balance, sendValue, gasLimit, gasCost };
      }
      gasLimit = buffered;
    } catch {
      return { balance, sendValue, gasLimit, gasCost };
    }
  }

  const gasCost = gasPrice * gasLimit;
  const sendValue = balance > gasCost ? balance - gasCost : 0n;
  return { balance, sendValue, gasLimit, gasCost };
}
