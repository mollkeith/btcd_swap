import { FetchRequest, JsonRpcProvider, Network } from "ethers";
import { BSC, PGP } from "./constants.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * BSC public RPCs, ordered most-reliable first. The binance.org dataseeds are often
 * unreachable from some regions, so defibit/ninicoin mirrors lead; publicnode/llama last
 * (they rate-limit with 503 "no free connections" under load).
 */
export const BSC_RPC_FALLBACKS = [
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-dataseed1.ninicoin.io",
  "https://bsc-dataseed2.defibit.io",
  "https://bsc-dataseed3.defibit.io",
  "https://bsc-dataseed.binance.org",
  "https://bsc.publicnode.com",
  "https://binance.llamarpc.com",
];

export function getBscRpcUrls() {
  const primary = (process.env.BSC_RPC_URL || BSC.RPC_URL || "").trim();
  return [...new Set([primary, ...BSC_RPC_FALLBACKS].filter(Boolean))];
}

function makeFetch(url, timeoutMs) {
  const req = new FetchRequest(url);
  req.timeout = timeoutMs;
  return req;
}

/**
 * JsonRpcProvider with static network (skip eth_chainId detection) and request timeout.
 */
export function createRpcProvider(rpcUrl, chainId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const network = Network.from(chainId);
  const req = makeFetch(rpcUrl, timeoutMs);
  return new JsonRpcProvider(req, network, { staticNetwork: network });
}

/**
 * JsonRpcProvider that rotates across multiple RPC endpoints on network/HTTP failure
 * (503, timeout, connection reset). It sticks to the last endpoint that worked and only
 * rotates when one fails, so a tx broadcast + its receipt polls hit the same node.
 *
 * Safe for sends: `eth_sendRawTransaction` carries an already-signed tx (fixed nonce +
 * hash), so re-broadcasting to another node on retry cannot double-spend — nodes dedupe it.
 * JSON-RPC *error* responses (e.g. "nonce too low") are returned as-is and NOT retried.
 */
export class ResilientJsonRpcProvider extends JsonRpcProvider {
  constructor(urls, chainId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const network = Network.from(chainId);
    const reqs = urls.map((u) => makeFetch(u, timeoutMs));
    super(reqs[0], network, { staticNetwork: network });
    this._reqs = reqs;
    this._rpcUrls = urls;
    this._activeIdx = 0;
  }

  get rpcUrls() {
    return this._rpcUrls;
  }

  async _send(payload) {
    const n = this._reqs.length;
    let lastError;
    for (let attempt = 0; attempt < n; attempt += 1) {
      const idx = (this._activeIdx + attempt) % n;
      const request = this._reqs[idx].clone();
      request.body = JSON.stringify(payload);
      request.setHeader("content-type", "application/json");
      try {
        const response = await request.send();
        response.assertOk();
        let result = response.bodyJson;
        if (!Array.isArray(result)) result = [result];
        this._activeIdx = idx; // stick with the endpoint that just worked
        return result;
      } catch (err) {
        lastError = err;
        // network / HTTP failure (503, timeout, ECONNRESET, ...) -> try next endpoint
      }
    }
    throw lastError;
  }
}

/** Legacy single-endpoint connector: returns the first URL that responds. */
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
  const urls = getBscRpcUrls();
  const provider = new ResilientJsonRpcProvider(urls, BSC.CHAIN_ID, options);
  try {
    await provider.getBlockNumber(); // provider itself rotates until one answers
  } catch (err) {
    throw new Error(
      `cannot connect to any BSC RPC (tried ${urls.length}): ${err?.message || "unknown"}`
    );
  }
  return {
    provider,
    rpcUrl: `${urls[0]} (+${urls.length - 1} fallbacks, auto-rotate)`,
  };
}

export async function connectPgpProvider(options = {}) {
  // PGP_RPC_URL may be a comma-separated list of endpoints
  const raw = (process.env.PGP_RPC_URL || PGP.RPC_URL).trim();
  const urls = [...new Set(raw.split(",").map((u) => u.trim()).filter(Boolean))];
  const provider =
    urls.length > 1
      ? new ResilientJsonRpcProvider(urls, PGP.CHAIN_ID, options)
      : createRpcProvider(urls[0], PGP.CHAIN_ID, options);
  await provider.getBlockNumber();
  return { provider, rpcUrl: urls.join(", ") };
}
