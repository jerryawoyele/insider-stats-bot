import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { logError } from "./logger.js";

const REPORTS_DIR = path.resolve(process.cwd(), "reports");
const POOL_ANALYSIS_REPORTS_PATH = path.join(REPORTS_DIR, "pool-analysis.ndjson");

export async function appendPoolAnalysisReport(report) {
  try {
    await mkdir(REPORTS_DIR, { recursive: true });
    await appendFile(POOL_ANALYSIS_REPORTS_PATH, `${JSON.stringify(report)}\n`, "utf8");
  } catch (error) {
    logError("Failed writing pool analysis report", {
      reportPath: POOL_ANALYSIS_REPORTS_PATH,
      error: error instanceof Error ? error.stack || error.message : String(error)
    });
  }
}

export function shouldPersistPoolAnalysisReport(completionReason) {
  return Boolean(completionReason);
}

export { POOL_ANALYSIS_REPORTS_PATH };
