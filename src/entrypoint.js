import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

async function configureGmgn() {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    return;
  }

  const configDir = join(homedir(), ".config", "gmgn");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, ".env"), `GMGN_API_KEY=${apiKey}\n`, "utf8");
}

await configureGmgn();
await import("./index.js");
