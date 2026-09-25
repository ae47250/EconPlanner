# Course move campaign: history, findings, and verification

Branch: `codex/course-move-feedback-patterns`. The matrix uses fictional students and reviewed 2026/2027 schedule evidence. Review: PR #25; no merge authorized.

## History replay

Both findings occurred on merged main (`fd77c6c`, PR #24 merge) and predate that merge (`63fe78f`, PR #23 merge). Isolated worktrees at those commits ran the same API requests. On pre-PR #24, the One Year Early MAT 217 move was rejected by an unrelated projected-standing validation problem, but a Balanced plan MAT 217 move from Spring/May 2027 to Winter 2027 was accepted and retained the stale warning. The ECO 461 approval reference was present in both the original and edited plans at both commits. Neither finding began on this feature branch.

## Stale MAT 217 section warning — repaired

Replay: `./node_modules/.bin/playwright test tests/e2e/course-moves.spec.js --grep "move selectors"`

With a fictional freshman planning one year early on 2026-09-23, choose One Year Early and move MAT 217 from Spring/May 2027 to Winter 2027. Before repair, the validated plan retained `Seat availability for MAT 217-S was last checked on 2026-08-08; confirm it before registration.` after the placement and section changed. Report generation recalculated warnings and omitted it. The move endpoint now assigns the current validation warnings to the edited plan, matching the JSON and HTML report and visible UI. A narrow API assertion and the browser journey preserve the regression.

Governing schedule evidence: `policy/schedules/2026-2027.json` and `tests/oracle/verified-schedule-2026-2027.json`.

## ECO 461 approval source reference — provenance resolved

Replay: `ECONOMICS_MOVE_MATRIX_MODE=full ECONOMICS_MOVE_MATRIX_PROFILE=corpus-sophomore-W4 node --test tests/economics-move-matrix.test.js`

The three competing strings were:

| Location | `sourceRef` |
| --- | --- |
| Canonical `policy/rules/permissions-exceptions.json` | `DEPARTMENT-POLICIES#Confirmed-policy-4` |
| Previous Oracle specification | `DEPARTMENT-POLICIES#Confirmed policy 4` |
| Planner compatibility projection | `data/raw/economics/Department_Confirmed_Planning_Policies.md#policy-4` |

`policy/provenance/sources.json` maps `DEPARTMENT-POLICIES` to that raw file, whose confirmed policy 4 states the one-intermediate concurrent ECO 461 exception. The compiled compatibility projection maps the canonical fragment to `#policy-4`. This disagreement affected **evidence attribution in the Independent Oracle**, not the production approval requirement or the plan's academic validity. The Oracle specification and handwritten fixtures now use the exact canonical reference. The independent checker accepts its provenance-resolved raw-file form, while rejecting a wrong policy anchor or a missing approval. Canonical academic policy and compiled output were not changed.

## Stale ECO 461 approval after a different move — repaired

The full sweep then found a distinct edit error in fictional junior W3: moving ECO 214 from Winter 2028 to Winter 2027 left an ECO 461 concurrent-approval notice attached to Winter 2028. The courses were no longer concurrent, so the exception and its approval were no longer required under confirmed department policy 4. The edit path now rebuilds approval notices from the edited placements. The focused API test verifies that the outdated notice disappears while the original plan remains intact; the complete Independent Oracle accepts the result.

## PR #25 course-move regression correction

Latest fetched main: `fd77c6cf94eb760dc95379f944e71484306b4bed`.
Original PR #25 tip: `cd7d9daf1ba37876d0f3c6027b5eaec601ec3551`.
Replayed ordinary generated plans in isolated archives of both revisions, using identical API requests and no production edits:

| Profile (planning date 2026-09-23) | Move | Main | Original PR #25 |
| --- | --- | --- | --- |
| Freshman, custom five-year target 2031, Balanced | ECO 461 Winter 2030 → Winter 2031 | 200, unconfirmed projection | 422, blanket capstone lock |
| Freshman, One Year Early | ECO 222 Spring/May 2028 → Winter 2028 | 200, unconfirmed projection | 422, May-only restriction |
| Freshman, custom five-year target 2031, Balanced | ECO 461 Winter 2030 → Winter 2029 | 422, invalid senior Winter | 422, blanket capstone lock |

Cause: the PR treated generator offering domains as mandatory edit destinations and separately prohibited every ECO 461 move. Its matrix encoded the same erroneous blanket capstone assumption and did not require independently valid moves to succeed. It also replaced main's existing positive ECO 222 regression with a rejection expectation. The earlier green campaign therefore did not establish compatibility with main.

Correction: restore main's complete term dropdown and original server edit path, while retaining nearby rejection feedback, current validation warnings, rebuilt approval notices, and provenance-resolved Oracle references. Future ECO 222 moves remain `projected-offering`, with no section, meeting, availability, or preliminary schedule claim. Canonical `policy/rules/planning-flexibility.json` allows academically valid unpublished-schedule projections; recurring preferences do not establish confirmed sections or seats. The separately approved standing repair enforces `CAPSTONE-SENIOR-STANDING` in the Decision Engine using the authoritative timeline, including the existing accelerated-final-year exception. Rebuilt prerequisite approval notices cannot override that placement decision.

Browser regressions generate both ordinary plans, select the actual dropdown options, save, reload, and compare JSON/HTML report projections. The five-year test also attempts the invalid junior-Winter move before the valid senior-Winter move. HTML's empty calendar cells are excluded only when comparing occupied course placements.

The matrix now builds counterfactual placements independently from canonical rules and the independent verified schedule, checks them with the Independent Oracle before submitting each request, and asserts both acceptance and rejection. It includes an extended profile, counts accepted and rejected ECO 461 moves separately, and reports every discrepancy. Taking-now requirement credit remains projected; a separate current-term chronology check prevents treating it as already completed for a same-term prerequisite.

## Existing main standing-validation gap — repaired with owner approval

An ordinary freshman **standard Balanced** plan generated for 2026-09-23 permits ECO 461 to move from Winter 2030 to **Winter 2029 (junior year)** when its prerequisites are already completed in earlier planned terms. An isolated replay at `fd77c6cf94eb760dc95379f944e71484306b4bed` returned 200. The independent expectation is rejection under `policy/rules/terms-load-graduation.json`, `CAPSTONE-SENIOR-STANDING`, sourced to `DEPARTMENT-POLICIES#Confirmed-policy-6`.

This is distinct from moving between Winter 2030 and Winter 2031, which are both eligible senior Winters. The legacy validator records a standing error, but the authoritative Decision Engine can accept the plan without enforcing this capstone standing condition. After the owner explicitly authorized this additional repair, the Decision Engine now enforces the canonical standing requirement for ECO 461 itself. Both senior Winters remain eligible; a forged senior label cannot authorize a junior Winter; an accelerated assumption applies only to the final academic year. The matrix and ordinary-plan browser test preserve the previously failing senior-standing assertions. No Oracle rule was weakened and no failure was marked skipped or expected-to-fail.

Reproduce the bounded cases with `node --test tests/economics-move-matrix.test.js`; isolate the smallest with `ECONOMICS_MOVE_MATRIX_PROFILE=freshman node --test tests/economics-move-matrix.test.js`.

## Verification for the correction

- Bounded matrix: 1,574 pairs, 10 profiles, 18 plans; 1,552 editable dropdown destinations and 22 fixed-current-course attempts; 662 accepted / 912 rejected; 150 capstone attempts (4 accepted / 146 rejected). Zero findings. No uncovered generated cells or profiles.
- Full sweep: 7,250 pairs, 61 profiles, 103 plans; 7,228 editable destinations and 22 fixed-current-course attempts; 2,966 accepted / 4,284 rejected; 775 May 2027 attempts and 881 capstone attempts (4 accepted / 877 rejected). Before the standing repair, 64 accepted moves violated senior standing; seven other differences were legitimate duplicate-plan rejections and five were published-section conflicts. The matrix now checks both independently, including schedule checks when prerequisite review short-circuits the composed Oracle audit. The repaired full sweep passed with zero findings. No uncovered generated cells or profiles. Fifty fixed-seed stateful runs passed (seed 20260923).
- Focused API/Oracle/PDF-client tests: 75 passed. Full Node suite after the standing repair: 563 passed, zero failures, one existing skip.
- Focused browser journeys after the standing repair: 7 passed. Configured local browser suite: 42 passed, one missing `pdftotext` dependency, and one timing-sensitive accessibility assertion that passed its isolated replay. CI installs Poppler for PDF parity.
- Lint passed with the existing unused-variable warning in `scripts/normalize-hanover-catalog.mjs`; production build passed; PDF dry run passed five fictional profiles with no hosted service.

Run full mode with `ECONOMICS_MOVE_MATRIX_MODE=full node --test tests/economics-move-matrix.test.js`. Set `ECONOMICS_MOVE_MATRIX_PROFILE` to replay one named profile. Academic policy, compiled policy, saved-answer behavior, 30-day PDF retention, and disabled HTML storage are unchanged.
