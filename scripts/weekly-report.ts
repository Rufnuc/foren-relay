/**
 * Finalize a weekly usage report and commit its hash on-chain.
 *
 *   npm run usage:report              # finalize the PREVIOUS complete week
 *   npm run usage:report -- 2026-W39  # finalize a specific ISO week
 *
 * Steps: aggregate the week → build the deterministic report → SHA-256 → anchor
 * ONLY that hash on Solana via the existing anchor service → store the report +
 * the transaction reference. Re-running an already-published week creates a
 * clearly versioned correction (version++), never a silent edit.
 */
import { loadConfig } from "../src/config";
import { buildLogger } from "../src/util/logger";
import { buildUsageService, finalizeWeeklyReport } from "../src/services/usage";
import { buildAnchorService } from "../src/services/anchor";
import { isoWeek } from "../src/services/usage/canonical";

async function main() {
  const cfg = loadConfig();
  const logger = buildLogger(cfg);

  const week = process.argv[2] ?? isoWeek(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const usage = buildUsageService(
    {
      dbPath: cfg.USAGE_DB_PATH,
      maxSkewMs: cfg.USAGE_MAX_SKEW_MS,
      nonceRetentionMs: cfg.USAGE_NONCE_RETENTION_MS,
      libsqlUrl: cfg.USAGE_LIBSQL_URL || undefined,
      libsqlAuthToken: cfg.USAGE_LIBSQL_AUTH_TOKEN || undefined,
    },
    logger,
  );
  const anchor = buildAnchorService(cfg, logger);

  // Same code path as the admin endpoint: build → anchor → store (versioned).
  const result = await finalizeWeeklyReport(usage, anchor, week, logger);
  const m = result.metrics;

  process.stdout.write(
    [
      "",
      "FOREN WEEKLY USAGE",
      "",
      `Period:`,
      `${week}, report v${result.version}`,
      "",
      `Anonymous identities with qualifying activity:  ${m.anonymous_identities}`,
      `New anonymous identities:                        ${m.new_anonymous_identities}`,
      `Returning anonymous identities:                  ${m.returning_anonymous_identities}`,
      `Records created:                                 ${m.records_created}`,
      `Records updated:                                 ${m.records_updated}`,
      `Evidence items added:                            ${m.evidence_added}`,
      `Verification operations:                         ${m.verification_operations}`,
      `Exports:                                         ${m.exports}`,
      "",
      `SHA-256:  ${result.sha256}`,
      `Chain tx: ${result.chainTx ?? "(not anchored)"}`,
      "",
    ].join("\n"),
  );

  await usage.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("weekly-report failed:", err);
  process.exit(1);
});
