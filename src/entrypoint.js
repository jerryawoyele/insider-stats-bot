import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logError, logInfo } from "./logger.js";

async function configureGmgn() {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    return;
  }

  const configDir = join(homedir(), ".config", "gmgn");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, ".env"), `GMGN_API_KEY=${apiKey}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startHealthServer() {
  const port = Number(process.env.PORT || 8080);
  const host = "0.0.0.0";

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("bot running");
  });

  server.listen(port, host, () => {
    logInfo("Health server listening", {
      host,
      port
    });
  });
}

await configureGmgn();
startHealthServer();
const { runBot } = await import("./index.js");

let restartCount = 0;

while (true) {
  try {
    if (restartCount > 0) {
      logInfo("Restarting bot after previous failure", {
        restartCount
      });
    }

    await runBot();
    logError("Bot main loop exited unexpectedly; restarting", {
      restartCount
    });
  } catch (error) {
    restartCount += 1;
    logError("Bot crashed; restarting after backoff", {
      restartCount,
      error: error instanceof Error ? error.stack || error.message : String(error)
    });
  }

  await sleep(5000);
}
