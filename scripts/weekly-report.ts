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
import { buildUsageService } from "../src/services/usage";
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

  const existing = await usage.store.getReport(week);
  const version = existing ? existing.version + 1 : 1;
  const built = await usage.buildReportForWeek(week, version);

  logger.info({ week, version, sha256: built.sha256, metrics: built.report.metrics }, "built weekly report");

  // Anchor ONLY the SHA-256 (a 32-byte hash). No IDs, keys, or events on-chain.
  let chain: {
    tx: string | null;
    cluster: string | null;
    explorer: string | null;
    programId: string | null;
    recordPda: string | null;
  } = { tx: null, cluster: null, explorer: null, programId: null, recordPda: null };
  try {
    const anchor = buildAnchorService(cfg, logger);
    const res = await anchor.anchorRoot(built.sha256);
    chain = {
      tx: res.signature,
      cluster: res.cluster,
      explorer: res.explorer,
      programId: res.programId,
      recordPda: res.recordPda,
    };
    logger.info({ tx: res.signature, recordPda: res.recordPda }, "anchored report hash on-chain");
  } catch (err) {
    logger.error({ err }, "on-chain anchoring failed — storing report WITHOUT commitment (re-run to anchor)");
  }

  await usage.store.putReport({
    week,
    version,
    json: built.json,
    sha256: built.sha256,
    chainTx: chain.tx,
    chainCluster: chain.cluster,
    chainExplorer: chain.explorer,
    chainProgram: chain.programId,
    chainRecordPda: chain.recordPda,
    createdAt: Date.now(),
  });

  // Human-readable summary to stdout.
  const m = built.report.metrics;
  const period = built.report.period;
  process.stdout.write(
    [
      "",
      "FOREN WEEKLY USAGE",
      "",
      `Period:`,
      `${period.start} – ${period.end}  (${week}, report v${version})`,
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
      `SHA-256:  ${built.sha256}`,
      `Chain tx: ${chain.tx ?? "(not anchored)"}`,
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
