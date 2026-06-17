/**
 * BTCD -> native PGA -> BSC -> USDT (Pancake) pipeline constants.
 *
 * Swap   : FastSwapTokenToEth on PGARouterV2 (BTCD -> native PGA), selector 0x52a7c262.
 * Bridge : BridgeEth(recipient, destChainId) payable on the bridge (native PGA -> BSC),
 *          selector 0x94f3aecf, amount = msg.value (no approve needed).
 * BSC    : PancakeSwap V2 PGA/USDT.
 *
 * Verified on-chain: swap tx 0xf8b5…3bff, bridge txs selector 0x94f3aecf (destChainId 0x38 = 56).
 */

export const PGACOIN_PGP = {
  BTCD: "0xF9BF836FEd97a9c9Bfe4D4c28316b9400C59Cc6B",
  // Wrapped PGA — only used as the getAmountsOut quote path [BTCD, WPGA]; the swap itself
  // returns native PGA via FastSwapTokenToEth.
  WPGA: "0x1369a5f999618607bB0bb92892Ef69e2233F88f8",
  ROUTER: "0x3F67bDFB5003723e70bf18C7F6239814a2437bA8", // PGARouterV2 (same router as FIST)
  BRIDGE: process.env.BRIDGE_CONTRACT || "0xDBB35259372B2f0cB6b85dD31761C0fB3652Fd11",
  BRIDGE_DEST_CHAIN_ID: Number(process.env.BRIDGE_DEST_CHAIN_ID || "56"),
  BTCD_DECIMALS: 18,
  PGA_DECIMALS: 18, // native coin, 18 decimals
};

export const PGACOIN_BSC = {
  PGA: "0xC3e041Eb4fBCE0f26a7193DEE421E501Dbf68888", // PGA on BSC (ERC-20, 18 decimals)
  USDT: "0x55d398326f99059fF775485246999027B3197955",
  PANCAKE_V2_ROUTER: "0x10ed43c718714eb63d5aa57b78b54704e256024e",
  PGA_DECIMALS: 18,
  USDT_DECIMALS: 18,
};

export const PGACOIN_GAS = {
  gasLimitApproveBtcd: 81_048,
  gasLimitSwapBtcdPga: 320_000, // FastSwapTokenToEth (ref tx gas limit 294,770)
  gasLimitBridgePga: 120_000, // BridgeEth payable; unused gas refunded
  gasLimitApprovePgaBsc: 56_860,
  gasLimitPancakeSwap: 200_000,
};
