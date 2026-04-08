import { config } from "./config.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logWarn } from "./logger.js";

const execFileAsync = promisify(execFile);
let gmgnUnavailable = false;
const tokenInfoCache = new Map();

function extractPrice(tokenInfo) {
  if (typeof tokenInfo?.price === "number") {
    return tokenInfo.price;
  }

  if (typeof tokenInfo?.price === "string" && tokenInfo.price.trim() !== "") {
    const parsed = Number(tokenInfo.price);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function extractHolderCount(tokenInfo) {
  if (typeof tokenInfo?.holder_count === "number") {
    return tokenInfo.holder_count;
  }

  if (typeof tokenInfo?.stat?.holder_count === "number") {
    return tokenInfo.stat.holder_count;
  }

  return null;
}

async function getGmgnTokenInfo(mint) {
  if (gmgnUnavailable) {
    return null;
  }

  const now = Date.now();
  const cached = tokenInfoCache.get(mint);
  if (
    cached &&
    cached.value &&
    now - cached.fetchedAt < config.gmgnTokenInfoMinIntervalMs
  ) {
    return cached.value;
  }

  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const requestPromise = (async () => {
    try {
      const { stdout } = await execFileAsync(
        "gmgn-cli",
        ["token", "info", "--chain", "sol", "--address", mint, "--raw"],
        {
          windowsHide: true,
          timeout: 15000
        }
      );

      const trimmed = stdout.trim();
      if (!trimmed) {
        return null;
      }

      const parsed = JSON.parse(trimmed);
      tokenInfoCache.set(mint, {
        value: parsed,
        fetchedAt: Date.now(),
        inFlight: null
      });
      return parsed;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("spawn gmgn-cli ENOENT") || error.message.includes("not recognized"))
      ) {
        gmgnUnavailable = true;
        logWarn("GMGN CLI is unavailable; disabling holder count checks", {
          mint,
          error: error.message
        });
        return null;
      }

      logWarn("Failed to fetch token info from GMGN", {
        mint,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    } finally {
      const latest = tokenInfoCache.get(mint);
      if (latest) {
        latest.inFlight = null;
      }
    }
  })();

  tokenInfoCache.set(mint, {
    value: cached?.value || null,
    fetchedAt: cached?.fetchedAt || 0,
    inFlight: requestPromise
  });

  try {
    return await requestPromise;
  } catch {
    return null;
  }
}

export async function getGmgnHolderCount(mint) {
  const tokenInfo = await getGmgnTokenInfo(mint);
  if (!tokenInfo) {
    return null;
  }

  return extractHolderCount(tokenInfo);
}

export async function getGmgnTokenPrice(mint) {
  const tokenInfo = await getGmgnTokenInfo(mint);
  if (!tokenInfo) {
    return null;
  }

  return extractPrice(tokenInfo);
}
