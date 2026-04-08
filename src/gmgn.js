import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logWarn } from "./logger.js";

const execFileAsync = promisify(execFile);

function extractHolderCount(tokenInfo) {
  if (typeof tokenInfo?.holder_count === "number") {
    return tokenInfo.holder_count;
  }

  if (typeof tokenInfo?.stat?.holder_count === "number") {
    return tokenInfo.stat.holder_count;
  }

  return null;
}

export async function getGmgnHolderCount(mint) {
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
    return extractHolderCount(parsed);
  } catch (error) {
    logWarn("Failed to fetch holder count from GMGN", {
      mint,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}
