import { loadConfig } from "./config.js";

function main(): void {
  const config = loadConfig(process.env);

  console.info("Ledger Bot configuration loaded", {
    ownerId: config.ownerId,
    databasePath: config.databasePath,
    timezone: config.timezone,
    currency: config.currency,
  });
}

main();
