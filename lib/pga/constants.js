/**
 * BTCD -> USDT (PGP swap contract) -> BSC USDT pipeline constants.
 */

export const PGA_PIPELINE = {
  SWAP_CONTRACT: process.env.SWAP_CONTRACT || "0xFF60725F03531DCeE7f91d731cd002Fc78aB497F",
  BTCD: "0xF9BF836FEd97a9c9Bfe4D4c28316b9400C59Cc6B",
  USDT: "0xdF72788af68E7902F61377D246Dd502b0b383385",
  BRIDGE: process.env.BRIDGE_CONTRACT || "0xDBB35259372B2f0cB6b85dD31761C0fB3652Fd11",
  BRIDGE_DEST_CHAIN_ID: Number(process.env.BRIDGE_DEST_CHAIN_ID || "56"),
  BTCD_DECIMALS: 18,
  USDT_DECIMALS: 18,
};

export const PGA_GAS = {
  gasLimitApproveBtcd: 80_000,
  gasLimitSwapBtcdUsdt: 150_000,
  gasLimitApproveUsdt: 80_000,
  gasLimitBridgeUsdt: 77_000,
};
