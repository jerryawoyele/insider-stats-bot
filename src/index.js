import { InsiderBot } from "./bot.js";
import { logError } from "./logger.js";

export async function runBot() {
  const bot = new InsiderBot();
  await bot.start();
  await new Promise(() => {});
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runBot().catch((error) => {
    logError("Fatal startup error", error);
    process.exitCode = 1;
  });
}
