// Safe regression entry point for the 2026-10-27 security audit.
// Build package/ego-browser first, then run: node docs/security-audit-repro.mjs
// Fixtures use temporary synthetic files, fake CDP, and stubbed installer tools.
// Unlike the original audit probes, success now means the flaws are rejected.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(
  process.execPath,
  [
    "--test",
    "src/install-security.test.mjs",
    "src/learning/learning-security.test.mjs",
    "src/driver/download-security.test.mjs",
    "src/driver/downloads.test.mjs",
  ],
  {
    cwd: fileURLToPath(new URL("../package/ego-browser/", import.meta.url)),
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
