# Architecture repairs: local verification

Verified locally 2026-09-23 before the merge-preparation commit. These results
apply to the repair changes on `codex/architecture-remediation`, based on HEAD
`00c3b5e37e3f2557aeee312b3beadd05373215fb`.

Repository: `/Users/agust/Developer/Projects/EconPlanner`.
Remote: `https://github.com/ae47250/EconPlanner.git`.
At verification, there was no branch upstream. Local `main` and `origin/main`
were `63fe78fd376a40da753cca639b4335a5f04b324a`. The starting tree was
clean; no commits were rewritten. The earlier committed cleanup is preserved.
A later fetch for merge preparation confirmed `origin/main` remained at that
commit. The test results below are local results, not hosted-preview results.

## Repairs and authority

- `lib/decision-engine/placement.js` and the independently implemented
  `tests/oracle/load-canonical-policy.js` now check course, term, evidence type,
  effective scope and supersession for named offering projections. The source
  string alone does not grant permission. `policy/offering-patterns/economics.json`
  gives `CATALOG-ECO-222-SPRING` May projection scope, effective 2025-08-01,
  through the linked official catalog provenance. It does not verify a Winter
  offering. The existing 2026-09-22 preliminary-schedule authority allows labeled
  future workload projections. Exact published sections still take precedence.
  Where exact term dates are unavailable, partial-year evidence remains unknown.
- `tests/oracle/README.md` explains the two independent checks: the external
  complete-plan audit covers structure, requirements, prerequisites, schedule,
  capacity and horizon; the raw-canonical-policy evaluator checks individual
  policy decisions and their combined result. Neither imports production decisions.
  No canonical policy, provenance, independent schedule snapshot or compiled bundle
  was edited.
- `lib/decision-engine/shadow.js` checks hard validity differences before known
  review notices. `lib/nightly/econplannerMetrics.js` makes an unexpected
  engine-only disagreement fail the aggregate gate. Tests retain mixed review/hard
  cases and the existing metadata/producer-assertion protections.
- `selectedPlanContext` in `lib/planning/horizon.js` supplies the selected context
  to editing and report validation. `applyEconomicsPlanEdit` in
  `lib/planning/termSolver.js` rebuilds a moved placement from destination evidence.
  The server freshly validates the original and final plan with the current
  student, selected context and pinned bundle. Old section, availability and
  evidence fields are not copied into the destination. The legacy candidate API
  still goes through strict validation.
- `app/page.js` uses the selected target in review, distinguishes comparison
  targets, explains required courses instead of offering unsavable removals,
  retains offered elective moves/replacements, and labels readiness as
  “Ready to plan” with a prominent future-offering notice. In-app Back navigation
  preserves React state; browser answer storage is unchanged.
- `lib/planning/noPlanResult.js` derives the senior explanation from available
  planning slots and the pinned statistics-before-capstone and Winter capstone
  rules. It is displayed for proven infeasibility, once, instead of repeated
  generic search diagnostics. Earlier-date and statistics-completed cases are
  negative regressions against overclaiming this blocker.
- `lib/reports/economics.js` and the HTML template use the selected plan's full
  dated horizon and pace. JSON now uses `Cache-Control: no-store`, as HTML/PDF do.
- The PDF route explicitly sends `storeResult:true`, `retentionDays:30`; the client
  sends `storeHtml:false`. Manual retries reuse an operation identifier and the
  same request in memory; a service content conflict offers a new attempt. Plan
  or answer changes cancel stale downloads and clear stale status. Success says
  the download started, without claiming the browser saved it.

## Student clicks verified

The four new journeys in `tests/e2e/architecture-repairs.spec.js` use ordinary
controls against the real local planner. They select the planning date
2026-09-23 through More details. They do not inject student profiles or successful
planner responses.

1. Freshman → One Year Early → Continue → Generate returns Balanced, Explore and
   One Year Early. Selecting Early displays Spring/May 2029; refresh and the
   in-app Back/return preserve it. Selecting Balanced displays Spring/May 2030.
2. In Early, move MAT 217 from May 2027 to Winter 2027: accepted, with a verified
   Winter section (J in the observed run). Move it to Winter 2029: rejected for
   statistics/prerequisite timing, without the unrelated Fall 2028 standing
   error. The prior placement remains and keyboard focus returns to its menu.
   Move ECO 222 to Winter 2028: accepted as a generic future projection, without
   a claimed section, seat availability or stale preliminary evidence.
3. At 390px mobile width, keyboard Generate and Review focus the result heading.
   Required-course Remove buttons are absent and explanations are visible.
   Moving a generic ECO elective from May 2030 to Fall 2029 succeeds. This
   profile does not offer an elective replacement menu; the test does not invent
   one. No horizontal overflow or axe violations were found.
4. Senior: mark ECO 113, ECO 114, MAT 113, MAT 217, ECO 213, ECO 214, BUSN 323,
   ECO 161, ECO 221, ECO 222 and ECO 234 completed. A plan is available. Return,
   clear MAT 217 and generate: No complete plan. Expanding the explanation names
   Winter 2027 and statistics required before ECO 461. Revisit answers: the other
   selections remain. Junior: ECO 213 Taking now initially focuses its missing
   prerequisite correction; completing ECO 113 and MAT 113 through those controls
   preserves the correction. Requesting next-year graduation reports Not possible
   and offers the standard May 2028 plan with appropriate heading focus.

## Export and transport boundaries

The actual Download PDF click supplies the request used for JSON/HTML parity.
Those JSON/HTML replays are internal export diagnostics, not independent proof
of UI reachability. The returned HTML is rendered by local Chromium to Letter PDF
with the service's 0.42-inch margins, then delivered through the browser download
event. Three saved files cover Early, edited Early and Balanced after early
intake. Text checks cover every course code, selected target and full horizon;
visual inspection covers every page, without clipped content. These are real
local PDFs, not hosted service results.

A simulated timeout checks the displayed PDF error, focus, enabled retry control,
unchanged retry request and eventual download status. Client tests separately
exercise service-busy admission retries, five-attempt/15-second limits,
115-second request timeout, stored-download integrity and redacted errors.
These transport failures are simulated; no hosted credentials or student records
were used. Roles, live regions, keyboard focus and axe checks passed.

**Spoken screen-reader check: NOT RUN.** VoiceOver works on this Mac. In this
session, macOS Accessibility Settings successfully switched VoiceOver on, and its
Utility showed the caption panel enabled. On the local planner, focusing Freshman
exposed its selected state and updated target to the accessibility tree. The
automation did not expose caption text or audio, so it could not confirm what
VoiceOver spoke. The setting was restored to its original off state. NVDA is
unavailable on this macOS host. Keyboard, role, live-region and axe checks are
separate completed checks; they do not establish spoken output or WCAG certification.

## Commands and results

Run from the repository root. This machine's pnpm wrapper otherwise attempts
dependency revalidation/install; the process-only prefix below uses the existing
installed dependencies without changing project configuration.

```sh
pnpm_config_verify_deps_before_run=false pnpm test
# 556 tests: 555 passed, 1 explicitly nightly-only skip, 0 failures.

ECONOMICS_PREREQUISITE_MATRIX_NIGHTLY=1 node --test tests/economics-prerequisite-edge-matrix.test.js
# 5 passed, no skips; includes the 293-case nightly subset.

pnpm_config_verify_deps_before_run=false pnpm exec playwright test tests/e2e/architecture-repairs.spec.js tests/e2e/econ-planner.spec.js tests/e2e/econ-planner-parity.spec.js tests/e2e/econ-planner-accessibility.spec.js
# 39 passed. Final PDF/visual assertion refinements: new four journeys rerun, all pass.

node scripts/verify-economics-pdf.mjs --dry-run
# All 5 fictional profiles pass JSON/HTML parity; invalid selected plan rejected.
# Hosted delivery was skipped, not counted as a successful hosted check.

pnpm_config_verify_deps_before_run=false pnpm run lint
# 0 errors; existing unused-variable warning at normalize-hanover-catalog.mjs:125.
pnpm_config_verify_deps_before_run=false pnpm run build
# Passed, including both API routes.
node --test tests/decision-engine-oracle-differential.test.js
# Final evidence-boundary assertions: 8 passed.
node --test tests/decision-engine-shadow.test.js
# Final classifier cleanup: all passed.
git diff --check
# Passed.
```

Browser tests require installed Chrome and Poppler's `pdftotext`. Locally the
`PDFTOTEXT` environment variable selected the bundled binary; CI installs
`poppler-utils`. CI includes the new acceptance spec. The local server used
`PDF_CREATION_ENABLED=false`. Browser artifacts are ignored under `test-results/`;
they include fictional JSON/HTML/text/PDF files and desktop/mobile screenshots.

## Thirty-day retention: implemented contract, unverified deployment

The owner decision is retained. The service-boundary test in
`tests/economics-report.test.js` invokes the report API handler with a fictional
student and an injected `fetchImpl`. That fake transport captures the JSON body
the client would POST to `/api/v1/pdfs`: `storeResult:true`, `retentionDays:30`,
`storeHtml:false`, and the retry idempotency key. It asserts these values even
when the caller submits `storeResult:false` and `retentionDays:1`. The fake
transport then returns a stored-report response and PDF bytes for the client's
download and integrity check. **No request reached the hosted PDF service, and
this test did not store or delete an object.** Separate client tests simulate
busy responses, timeout and retry behavior. Local browser tests render real PDFs
with Chromium but intercept PDF delivery before the hosted service.

`storeHtml:false` prevents a separate stored HTML artifact under the specified
service contract; HTML still travels to the renderer, and its student content
is in the retained PDF.
The in-memory retry identifier adds no durable browser data. Sensitive HTML,
answers, credentials and report contents are excluded from the client error log.

Read-only provider evidence in `pdf-creator/docs/OPERATIONS.md`, “Private R2”,
describes an unguessable bearer link expiring at the manifest's exact 30-day
deadline, with physical cleanup by a 31-day R2 lifecycle rule, including a separate
idempotency prefix. This is a one-day cleanup grace period, followed by asynchronous
provider processing. Cloudflare states removal is typically within 24 hours of
lifecycle expiration; that is not proof of this deployment's deletion.
[Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

The provider's 2026-08-06 hardening report records a broad 31-day reports rule and
missing more specific/caller rules. That historical record cannot establish
today's deployed configuration. Hosted creation, bearer-link access, actual
30-day expiry, physical deletion, backups and provider log retention were not
verified here. Separately authorized infrastructure follow-up should inspect
current lifecycle rules and the idempotency cleanup prefix, then verify expiry
and deletion with fictional canaries in the approved test bucket. No infrastructure
change was made or assumed necessary from the stale report alone.

No new academic-policy decision was required. Existing catalog-applicability and
approval notices remain visible; the app does not infer a waiver. Institutional
privacy obligations and provider contractual coverage cannot be established from
this code or these tests; no FERPA compliance claim is made.

## Reference scope

The text identifying correction targets follows WCAG 2.2
[3.3.1 Error Identification](https://www.w3.org/TR/WCAG22/#error-identification)
and [3.3.3 Error Suggestion](https://www.w3.org/TR/WCAG22/#error-suggestion).
Programmatic status checks address
[4.1.3 Status Messages](https://www.w3.org/TR/WCAG22/#status-messages).
These criteria support the UI checks; they do not establish academic correctness,
PDF deletion, or a particular retention duration. The 30-day duration comes from
the owner, and academic meaning comes from canonical policy and provenance.
