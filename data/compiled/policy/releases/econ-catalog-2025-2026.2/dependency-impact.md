# Dependency impact: econ-catalog-2025-2026.2

Bundle digest: `sha256:eedc9610b75a312809d9fc0aabe794165db5ea2198b73c718281f047a36a27ce`

- Catalog applicability may evaluate this release as authoritative published evidence.
- Conditional use is controlled by `CATALOG-LATEST-FLEXIBLE-MAJOR-FALLBACK`.
- The active Decision Engine bundle and `data/compiled/policy/active.json` are not changed.
- Planning, API, advisor-notice, readiness, and nightly-ledger consumers depend on the catalog applicability contract.
- Profile impact must be reviewed in the CP4b-B catalog/readiness ledger before activation.
- Rollback is the removal of the CP4b-B checkpoint commit; the previous immutable bundle remains available.
