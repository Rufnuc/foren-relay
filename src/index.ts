import { loadConfig } from "./config";
import { buildLogger } from "./util/logger";
import { buildApp } from "./server";

async function main() {
  const cfg = loadConfig();
  const logger = buildLogger(cfg);
  const { app, pinning, dispatcher } = buildApp({ cfg, logger });

  const server = app.listen(cfg.RELAY_PORT, cfg.RELAY_HOST, () => {
    logger.info(
      {
        port: cfg.RELAY_PORT,
        host: cfg.RELAY_HOST,
        pinning: pinning.name,
        channels: dispatcher.channelsReady(),
      },
      "prutet relay listening",
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal startup error:", err);
  process.exit(1);
});
