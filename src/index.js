import { InsiderBot } from "./bot.js";
import { logError } from "./logger.js";

async function main() {
  const bot = new InsiderBot();
  await bot.start();
  await new Promise(() => {});
}

main().catch((error) => {
  logError("Fatal startup error", error);
  process.exitCode = 1;
});
