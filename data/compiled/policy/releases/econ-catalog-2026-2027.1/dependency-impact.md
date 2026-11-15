# Dependency impact: econ-catalog-2026-2027.1

Bundle digest: `sha256:1e24364ff64a4c7b04b9412553ed4b9603a863aa502488dc1fb8e39d4ccad9aa`

- Catalog applicability may evaluate this release as authoritative published evidence.
- Conditional use is controlled by `CATALOG-LATEST-FLEXIBLE-MAJOR-FALLBACK`.
- The active Decision Engine bundle and `data/compiled/policy/active.json` are not changed.
- Planning, API, advisor-notice, readiness, and nightly-ledger consumers depend on the catalog applicability contract.
- Profile impact must be reviewed in the CP4b-B catalog/readiness ledger before activation.
- Rollback is the removal of the CP4b-B checkpoint commit; the previous immutable bundle remains available.
