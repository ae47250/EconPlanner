# Owner decision: remove the "many majors" leftovers from the catalog loader — November 27, 2026

Authority: project owner, explicit approval ("Go") of the reviewed plan in the clean-up session dated 2026-11-27, following the earlier decision that the app is Economics-only. Effective from 2026-11-27 with no end date. Code clean-up; no change to any plan or answer.

Removed: data/normalized/catalogs/2025-2026/requirements.json and prerequisites.json (read by lib/catalog/load.js and then replaced by the governed policy versions; no script writes or reads them otherwise); the catalog-folder scan in availableCatalogYears (it returned the same years as the policy list); the stand-in program for a missing program record, the always-true "is this Economics?" branches and the one-item sort in app/api/majors/map/route.js.

Kept: programs.json and program-variants.json (their fields appear in the reply), the reply's `programs` list that the form and the ChatGPT tool read, and the per-program lookups callers use for "economics".

Check: a one-off before/after comparison (not kept in the repo) found byte-identical outputs for 31 test students (screen answer, report data, PDF page) and 37 plan checks.
