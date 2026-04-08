import "dotenv/config";

const requiredKeys = ["HELIUS_API_KEY", "LEADER_WALLET", "CONFIG_ADDRESS"];

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number in environment variable ${name}: ${raw}`);
  }

  return parsed;
}

for (const key of requiredKeys) {
  getRequiredEnv(key);
}

const heliusApiKey = getRequiredEnv("HELIUS_API_KEY");
const rpcUrl =
  process.env.HELIUS_RPC_URL?.trim() ||
  `https://api-mainnet.helius-rpc.com`;
const wssUrl =
  process.env.HELIUS_WSS_URL?.trim() ||
  `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;

export const config = {
  heliusApiKey,
  heliusRpcUrl: rpcUrl,
  heliusWssUrl: wssUrl,
  leaderWallet: getRequiredEnv("LEADER_WALLET"),
  configAddress: getRequiredEnv("CONFIG_ADDRESS"),
  poolTxLimit: getNumberEnv("POOL_TX_LIMIT", 50),
  poolTxTarget: getNumberEnv("POOL_TX_TARGET", 250),
  insiderHistoryLimit: getNumberEnv("INSIDER_HISTORY_LIMIT", 200),
  insiderHistoryMaxPages: getNumberEnv("INSIDER_HISTORY_MAX_PAGES", 10),
  signatureBatchWindowMs: getNumberEnv("SIGNATURE_BATCH_WINDOW_MS", 500),
  holderCheckEveryTxs: getNumberEnv("HOLDER_CHECK_EVERY_TXS", 25),
  holderCheckMinIntervalMs: getNumberEnv("HOLDER_CHECK_MIN_INTERVAL_MS", 2000)
};
