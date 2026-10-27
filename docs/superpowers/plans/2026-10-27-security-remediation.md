# Security audit remediation

Goal: implement SEC-01 through SEC-06 in `security_best_practices_report.md` without changing the closed-source browser or executing untrusted packages.

Architecture: preserve page-scoped CDP download behavior; make learning validation static and file access confined; authenticate macOS installations; isolate third-party CI code from publishing credentials. Stack: TypeScript/Node, Acorn, shell, GitHub Actions.

The user's instruction to execute the audit recommendations authorizes this plan. Work stays in the current shared checkout. Independent domains use disjoint file ownership; only the coordinator runs full builds.

1. SEC-01: harden `skills/ego-browser/scripts/install.sh`, its installation reference and behavioral tests. Verify vendor identity and Gatekeeper before installation/launch; preserve quarantine; reject unverified packages and redirects.
2. SEC-02/03: change `src/learning/` validation and loading, adding focused regression tests. Never execute a module during validation. Reject symlinks, escapes, non-regular and oversized learning files.
3. SEC-04/05: change `src/driver/downloads.ts`, Page options/schema, tests and download documentation. Reject ambiguous downloads; bound start, transfer, inactivity and bytes; make cancellation settle and clean up reliably.
4. SEC-06: pin external actions and separate untrusted rendering from privileged publication in `.github/`. Verify pinned commits and preserve scheduled chart generation.
5. Integrate: run focused regression tests, formatting, full tests, learning validation and real-browser E2E when the local runtime is available. Update the original reproduction script and audit report to distinguish repaired harness behavior from native-browser limitations.

Review focus: no privileged installer path bypasses verification; no validator import; no symlink reads; no download promise hangs or file identity confusion; no third-party action receives a write token. Tests use synthetic data, not user profiles or credentials. No install, push, release or CI dispatch is part of this work.

## Completion and verification

All six repository findings are implemented. No changes have been committed or published.

- `npm test` in `package/ego-browser`: build, translation check, TypeScript check and **566/566 tests passed** after the final runtime changes.
- Plugin `npm test`: **37/37 passed**. Chart adapter/staging suites: **8/8 passed**.
- `npm run style:check`, plugin formatting, installer `sh -n`, all-workflow Actionlint and `git diff --check`: passed.
- Existing site learning validation passed against the built runtime. No package dependency changes were needed.
- Security regression coverage includes installer identity/Gatekeeper failure, no validator execution, file confinement and bounds, download identity/size/deadlines, stalled setup/cancellation, restoration failure, and downloads arriving during cleanup.
- Independent read-only review found one cleanup race (a late third GUID escaped cancellation), reproduced it, and confirmed the fix with a repeated three-GUID probe. Final review has no unresolved code findings.
- Real-browser E2E was attempted for download lifecycle, resource limits and concurrent TaskSpace downloads using the checkout SDK. All three failed before any browser assertion because `ego-browser` is absent; no real-browser validation is claimed. The new local stalled-transfer fixture is ready for a runtime-equipped environment.
- Official ARM64 app 0.6.1.13 was inspected read-only. Its identity and Gatekeeper assessment pass, but strict deep signature verification fails on nested FinderInfo metadata, including after normal staging. The installer intentionally refuses it; the publisher must correct the release. No app was installed or launched.
- No hosted Actions workflow or full third-party rendering was executed. Fixed Action SHAs, aggregate API behavior, patch applicability, permissions and publication boundaries were checked locally; source details are in `.github/star-history/README.md`.

Remaining trust boundaries and sample hash are recorded in `security_best_practices_report.md`. The original proof script now runs the repaired behavioral regression suites, with only synthetic data and temporary fixtures.
