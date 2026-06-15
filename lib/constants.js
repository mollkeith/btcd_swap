/**
 * Chain and contract constants.
 */

export const PGP = {
  RPC_URL: process.env.PGP_RPC_URL || "https://api.elastos.io/pg",
  CHAIN_ID: 860621,
  SWAP_CONTRACT: "0xFF60725F03531DCeE7f91d731cd002Fc78aB497F",
  BTCD_TOKEN: "0xF9BF836FEd97a9c9Bfe4D4c28316b9400C59Cc6B",
  USDT_TOKEN: "0xdF72788af68E7902F61377D246Dd502b0b383385",
  BRIDGE_CONTRACT: process.env.BRIDGE_CONTRACT || "0xDBB35259372B2f0cB6b85dD31761C0fB3652Fd11",
  FEE_BPS_SELECTOR: "0x09f80dd9",
  SWAP_SELECTOR: "0xb740e96e",
  BRIDGE_SELECTOR: "0xcb722992",
  BRIDGE_DEST_CHAIN_ID: Number(process.env.BRIDGE_DEST_CHAIN_ID || "56"),
};

export const BSC = {
  RPC_URL: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
  CHAIN_ID: 56,
  USDT_TOKEN: "0x55d398326f99059fF775485246999027B3197955",
};

export const DEFAULT_GAS = {
  pgpGwei: Number(process.env.GAS_PRICE_GWEI || "25"),
  bscGwei: Number(process.env.BSC_GAS_PRICE_GWEI || "3"),
  gasLimitPgaTransfer: 31_500,
  gasLimitBtcdTransfer: 89_000,
  gasLimitApprove: 80_000,
  gasLimitSwap: 150_000,
  gasLimitBridge: 77_000,
  gasLimitTransfer: 65_000,
  gasLimitBnbTransfer: 21_000,
};

export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
