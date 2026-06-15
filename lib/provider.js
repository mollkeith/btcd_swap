import { FetchRequest, JsonRpcProvider, Network } from "ethers";
import { BSC, PGP } from "./constants.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export const BSC_RPC_FALLBACKS = [
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc-dataseed3.binance.org",
  "https://bsc-dataseed4.binance.org",
  "https://bsc.publicnode.com",
  "https://binance.llamarpc.com",
];

export function getBscRpcUrls() {
  const primary = (process.env.BSC_RPC_URL || BSC.RPC_URL || "").trim();
  return [...new Set([primary, ...BSC_RPC_FALLBACKS].filter(Boolean))];
}

/**
 * JsonRpcProvider with static network (skip eth_chainId detection) and request timeout.
 */
export function createRpcProvider(rpcUrl, chainId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const network = Network.from(chainId);
  const req = new FetchRequest(rpcUrl);
  req.timeout = timeoutMs;
  return new JsonRpcProvider(req, network, { staticNetwork: network });
}

export async function connectRpcProvider(urls, chainId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let lastErr;
  for (const url of urls) {
    try {
      const provider = createRpcProvider(url, chainId, { timeoutMs });
      await provider.getBlockNumber();
      return { provider, rpcUrl: url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `cannot connect to RPC (tried ${urls.length} endpoints): ${lastErr?.message || "unknown"}`
  );
}

export async function connectBscProvider(options = {}) {
  return connectRpcProvider(getBscRpcUrls(), BSC.CHAIN_ID, options);
}

export async function connectPgpProvider(options = {}) {
  const url = (process.env.PGP_RPC_URL || PGP.RPC_URL).trim();
  return connectRpcProvider([url], PGP.CHAIN_ID, options);
}
