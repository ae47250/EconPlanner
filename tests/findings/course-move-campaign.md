# Course move campaign: history, findings, and verification

Branch: `codex/course-move-feedback-patterns`. The matrix uses fictional students and reviewed 2026/2027 schedule evidence. All changes remain local.

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

## Completed coverage

The bounded PR matrix passed 1,262 course-to-other-term pairs across 9 fictional profiles and 16 plans, including 714 destinations hidden from dropdowns. The on-demand full sweep passed **6,938 pairs across 60 profiles and 101 plans**: 2,866 listed and 4,072 hidden destinations; 2,268 accepted and 4,670 rejected moves; 753 attempts into Spring/May 2027; 855 ECO 461 attempts; and 22 fixed-current-course attempts. It reported zero uncovered generated cells, zero uncovered profiles, and zero unexplained results. Fifty fixed-seed stateful runs passed. Browser move journeys passed 4/4, and the full Node suite passed 562 tests with 1 existing skip.

Run full mode with `ECONOMICS_MOVE_MATRIX_MODE=full node --test tests/economics-move-matrix.test.js`. Set `ECONOMICS_MOVE_MATRIX_PROFILE` to replay one named profile. PDF creation remains disabled in these tests; report retention remains 30 days in `app/api/reports/economics/route.js`.
