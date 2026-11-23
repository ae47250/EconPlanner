# EconPlanner Repository Instructions

## Before Editing

- Work from the Git root. Confirm the repository and remote, current branch and upstream, `origin/main`, and both staged and unstaged status before editing. Useful checks are `git remote -v`, `git status --short --branch`, `git rev-parse --show-toplevel`, and `git rev-parse '@{upstream}'`.
- Preserve unrelated user changes. Make the smallest change that solves the requested problem; do not reset, overwrite, reformat, or reorganize unrelated work.

## Academic Authority and Architecture

- `policy/` is the canonical policy hub and maintenance source for academic rules, schedules, provenance, schemas, messages, and unresolved questions. Authority depends on the recorded source, boundary, effective dates, and supersession in `policy/provenance/`; file order is not authority.
- Exact schedule releases in `policy/schedules/` and their linked verified evidence control only the documented academic years, terms, courses, sections, and facts. An exact verified schedule supersedes projections only within that scope. Never extend an exact record beyond its evidence.
- Never invent academic rules, offerings, prerequisites, equivalencies, waivers, approvals, availability states, effective dates, or missing evidence. Preserve uncertainty as unresolved, review-required, or projected when the canonical sources require it.
- `scripts/compile-policy.mjs` and `scripts/compile-catalog-policies.mjs` compile canonical policy sources into `data/compiled/policy/`. Regenerate compiled artifacts with `pnpm run compile:policy` or `pnpm run compile:catalog-policy`; never hand-edit generated policy output.
- `lib/decision-engine/` is the production Decision Engine. The active API, planner, and validators must consume the pinned compiled bundle through the established policy-loading path. UI and report wording must not create or alter academic policy.
- `tests/oracle/` and its fixtures form the Independent Oracle. They verify production independently but are not academic-policy sources. Follow `tests/oracle/README.md` when evidence requires an Oracle update.
- Oracle independence means independent implementation, not independent interpretation of academic policy. Canonical policy and its provenance are the sole authority for rule meaning; production and the Oracle must implement that meaning separately and neither may silently resolve ambiguous policy prose.
- If production and the Oracle disagree and the controlling policy plus provenance do not unambiguously identify the correct meaning, stop with `SPECIFICATION / AUTHORITY CONFLICT — inspect controlling policy and provenance before changing either implementation.` This is an engineering validation failure, not a student-facing plan status.
- Never change the Oracle merely to agree with production or silence a failure. Never change production merely to satisfy an obsolete or fictional fixture. Resolve disagreements from independently verified authoritative evidence, then correct the stale side and preserve regression coverage.

## Consistency, Verification, and Repair

- Keep academic decisions deterministic and consistent across `policy/`, the compiled bundle, `lib/decision-engine/`, `lib/planning/`, validators, `app/api/majors/map/route.js`, `app/page.js`, `lib/reports/`, `app/api/reports/economics/route.js`, and `templates/econplannertemplate.html`. The validated plan, API, interface, HTML, and PDF must describe the same plan and evidence.
- Run focused checks for every affected behavior and layer, for example `node --test <affected-test-files>` and `pnpm exec playwright test <affected-specs>`. For report projection changes, run `pnpm run verify:pdf:economics -- --dry-run`. Run `pnpm run lint` and `pnpm run build` when the change can reasonably affect those broader surfaces. Run the test-suite commands in `.github/workflows/econplanner-pr-tests.yml`, not plain `pnpm test`, because the latter includes the full move matrix that CI skips.
- Do not treat an unrelated system, external service, credential, deployment, or live PDF service as a release gate. A passing build, isolated test, deployment, or fixture/registry edit alone does not prove the affected behavior is correct.
- During an authorized implementation, diagnose and make the smallest correct repair for a small, reproducible, clearly in-scope failure; add or update narrow regression coverage when appropriate, rerun relevant checks, and continue. Do not stop merely to report each small fixture, regex, lint, build, test, or parity failure.
- Stop and request direction when resolution requires a new academic-policy interpretation, conflicting authoritative evidence, a material architecture or public-contract change, a security or privacy decision, unavailable access, destructive action, unrelated scope expansion, or an unauthorized external or Production action.

## Authorization and Sensitive Data

- Obtain explicit user authorization before committing, pushing, opening or modifying a pull request, merging, deploying, changing environment variables, modifying Production, activating or configuring an external service, or performing a destructive action.
- Protect student information, credentials, authentication material, environment secrets, sensitive logs, and generated artifacts. Use fictional student data for tests; do not print, download, copy into source control, or expose real secrets or student-sensitive data. `.env.local.example` contains placeholders only; real values remain outside source control.

## Code Review Rules

- Flag academic policy added outside `policy/` or manual edits under `data/compiled/policy/`. Safe correction: update the canonical source with provenance, regenerate, and verify source-to-bundle parity.
- Flag Oracle or fixture changes that only silence a disagreement. Safe correction: verify independent authoritative evidence, correct the stale side, and keep the Oracle independent of production imports.
- Flag production changes made only to satisfy a stale or fictional fixture. Safe correction: repair the fixture when evidence proves it unsupported; otherwise correct production against the authoritative source.
- Flag missing authority, provenance, effective dates, supersession, or waiver/equivalency scope. Safe correction: document the governing source and exact boundary in the canonical hub before activating behavior.
- Flag registry-only coverage changes without proof of production behavior and a targeted test. Safe correction: exercise the real affected path and add a narrow regression assertion.
- Flag material disagreement among the validated plan, API, interface, HTML, and PDF. Safe correction: repair the incorrect projection from the same validated canonical plan rather than duplicating policy.
- Flag unrelated verification systems or external infrastructure imposed as release gates. Safe correction: keep gates proportional to the changed behavior unless the integration itself changed or the user explicitly authorized live verification.

## Student panel

- When you remove or replace a feature, delete its code and its tests. Do not just redirect to it. Git keeps the history.
- Before reporting that a new or modified test or check passes, show that it fails on a deliberately planted error, then remove that error and verify the passing result.
- Do not delete, weaken, or edit existing tests, banned-term entries, panel students, or `scripts/panel/` checks merely to make a check pass. Make only explicitly requested changes to those files. If a check seems wrong, stop and report it.
- Every change that can affect student-facing text must pass `pnpm panel:check` and `pnpm panel:lint`; PRs must list changed sentences grouped by panel student.
- Before changing a rule, message, or wording, check `tests/panel/trace.md` and list affected panel students in the PR.
- Do not regenerate panel snapshots in bulk to make checks pass without listing each changed sentence and its reason.
- Commit schedule data changes separately from code changes.
- New student-facing sentences belong in `policy/messages/en-US.json`; application code should refer to message IDs rather than define sentence text.
