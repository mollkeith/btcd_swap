/**
 * BTCD -> FIST -> BSC -> USDT (Pancake) pipeline constants.
 * Reference txs on PGP / BSC block explorers.
 */

export const FIST_PGP = {
  BTCD: "0xF9BF836FEd97a9c9Bfe4D4c28316b9400C59Cc6B",
  FIST: "0x800E5c441b84a3E809E2ec922BeEE9f32f954B11",
  ROUTER: "0x3F67bDFB5003723e70bf18C7F6239814a2437bA8",
  BRIDGE: process.env.BRIDGE_CONTRACT || "0xDBB35259372B2f0cB6b85dD31761C0fB3652Fd11",
  BRIDGE_DEST_CHAIN_ID: Number(process.env.BRIDGE_DEST_CHAIN_ID || "56"),
  FIST_DECIMALS: 18,
  BTCD_DECIMALS: 18,
};

export const FIST_BSC = {
  FIST: "0xc9882def23bc42d53895b8361d0b1edc7570bc6a",
  USDT: "0x55d398326f99059fF775485246999027B3197955",
  /** PancakeSwap V2 router (same FIST/USDT pair as reference smart-router tx) */
  PANCAKE_V2_ROUTER: "0x10ed43c718714eb63d5aa57b78b54704e256024e",
  FIST_DECIMALS: 6,
  USDT_DECIMALS: 18,
};

export const FIST_GAS = {
  gasLimitApprovePg: 81_048,
  gasLimitSwapBtcdFist: 282_665,
  gasLimitApproveFistPg: 69_452,
  gasLimitBridgeFist: 76_016,
  gasLimitApproveFistBsc: 56_860,
  gasLimitPancakeSwap: 200_000,
};
