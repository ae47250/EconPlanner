# Student panel review resolution — 2026-11-22

This file closes the findings in `2026-11-22-accuracy.md` and `2026-11-22-student-reader.md`. Snapshot references are one-based lines in the regenerated 50-student panel. A reference to a nearby heading or row documents a removal when the defective text itself must be absent. The PDF and screen are both in each snapshot. The five reserved authority questions remain owner decisions; this work does not decide them. Every changed sentence, grouped by student and surface, is in `2026-11-22-changed-sentences.md`. Every changed plan course list and status, with its reason, is in `2026-11-22-plan-changes.md`. Every changed test assertion is shown with its old and new source in `2026-11-22-test-assertions.md`.

## Accuracy review

| Finding | Disposition | Evidence and resolution |
| --- | --- | --- |
| H1 | Fixed | Student 27 has ECO 161 as the one 100-level elective on screen (`../snapshots/27.txt:66`) and PDF (`../snapshots/27.txt:180`). Student 48 does too on both screen plans (`../snapshots/48.txt:86`, `:195`) and both PDF reports (`../snapshots/48.txt:331`, `:466`). OD5 also removes the ECO 160 topic condition. |
| H2 | Fixed | Students 09 and 11, `../snapshots/09.txt:27` and `../snapshots/11.txt:27`: the early target is impossible by course count; no overload request appears. |
| H3 | Fixed | Students 20 and 21, `../snapshots/20.txt:30` and `../snapshots/21.txt:39`: the abroad reservation is applied; their results now differ from student 15. `../panel-study-abroad.test.js` plants the old term format and fails. |
| M1 | Fixed | Student 09, `../snapshots/09.txt:135`: only the blocked ECO 213 requirement is named. Alternatives are grouped by requirement where needed. |
| M2 | Fixed | Student 05, `../snapshots/05.txt:194`: MAT 217 replaces the unsupported projected ECO 257. Student 47's projected ECO 257 now has the specific unconfirmed-offering history note, verified by `../../plan-notes-elective-evidence.test.js`. |
| M3 | Fixed | Student 19, `../snapshots/19.txt:86`: the checklist names MAT 121 and the ECO 213 instructor's same-term approval. |
| M4 | Fixed | Student 26, `../snapshots/26.txt:64`: ECO 321 fills Finance and unused BUSN 323 transfer credit no longer lowers readiness. |
| M5 | Fixed | Student 42, `../snapshots/42.txt:22`: the status directs the student to the reason, rather than blaming their answers. |
| M6 | Fixed | Student 19, `../snapshots/19.txt:85`: the Taking now rows have no seat warning; planned rows still identify unknown seats. |
| M7 | Fixed | Student 40, `../snapshots/40.txt:32`: the diagnostic names ECO 213 and uses one no-plan status. N1's broader authority question remains open. |
| L1 | Fixed | Student 24, `../snapshots/24.txt:54`: “them” replaces “they.” |
| L2 | Fixed | Student 45, `../snapshots/45.txt:27`: “1 term left by May 2027” uses correct agreement and timing. |
| L3 | Fixed | Student 19, `../snapshots/19.txt:321`: the advisor sentence uses “was completed.” |
| L4 | Fixed | Student 17, `../snapshots/17.txt:23`: the note names ECO 114 instead of “one.” |
| L5 | Fixed | Student 29, `../snapshots/29.txt:26`: the reserved-course message names the count and asks the student to save less room. |
| L6 | Fixed | Student 25, `../snapshots/25.txt:55`, and student 01, `../snapshots/01.txt:108`: the petition and section-time sentences have no semicolon. |
| L7 | Fixed | Student 07, `../snapshots/07.txt:22`: the single conditional plan gets singular advice; student 02 has multiple plans and retains plural advice. |
| L8 | Fixed | Students 09 and 10, `../snapshots/09.txt:7` and `../snapshots/10.txt:7`: both use the same standing label and a separate early-target result. |
| L9 | Fixed | Student 02, `../snapshots/02.txt:328`: the standing marker names both advisor and Registrar. |
| L10 | Fixed | Student 08, `../snapshots/08.txt:60`: the old-catalog note calls the petition routine. |
| L11 | Fixed | Students 05 and 26, `../snapshots/05.txt:17` and `../snapshots/26.txt:17`: summary entries identify AP and transfer credit. |
| L12 | Fixed | Student 34, `../snapshots/34.txt:27`: the Finance no-plan explanation names the competing requirements and next step without claiming an unproved section clash. |
| L13 | Fixed | Student 01, `../snapshots/01.txt:103`: the heading says “Published Economics schedules.” |
| L14 | Fixed | Student 42, `../snapshots/42.txt:57`: the recorded-full MAT 217 section is excluded from the unknown-seat list. |
| N1 | Owner decision | Whether one missing verified offering proves target impossibility while other coverage is incomplete remains open. No rule was changed. |
| N2 | Fixed | Student 09, `../snapshots/09.txt:39`: OD6 puts no more than two Economics courses per term when a valid target plan exists. |
| N3 | Fixed | Student 15, `../snapshots/15.txt:35` and `:49`: OD7 keeps ECO 214 in Winter 2027 and ECO 461 in Winter 2028 when another valid plan exists. |
| N4 | Fixed | Student 46, `../snapshots/46.txt:152`: OD3 places published ECO 321 in Explore the Major and drops BUSN 323. |
| N5 | Owner decision | Whether an optional, unused Finance petition triggers the paperwork pointer remains open; student 25's behavior is unchanged. |
| N6 | Owner decision | Precedence between reserved-room and total-capacity explanations remains open; the existing reason is retained. |
| N7 | Owner decision | The BUSN 323 title disagreement in canonical sources is unchanged. |
| N8 | Owner decision | The same-term chain for student 32 is unchanged pending authority. |
| N9 | Fixed | Students 27 and 48 both have ECO 160 and ECO 161 completed. Their screen and PDF checklists choose ECO 161 (`../snapshots/27.txt:66`, `:180`; `../snapshots/48.txt:86`, `:195`, `:331`, `:466`). |

## Student-reader review

| Finding | Disposition | Evidence and resolution |
| --- | --- | --- |
| 1.1 | Fixed | Students 27 and 48 choose ECO 161 on every screen and PDF checklist (`../snapshots/27.txt:66`, `:180`; `../snapshots/48.txt:86`, `:195`, `:331`, `:466`). |
| 1.2 | Fixed | Student 49, `../snapshots/49.txt:78` and `:304`: screen/PDF math allocation agrees. The allocation tie now uses course codes, not input-order IDs. |
| 1.3 | Fixed | Student 19, `../snapshots/19.txt:85`: Taking now has no unknown-seat marker. |
| 1.4 | Fixed | Student 09, `../snapshots/09.txt:27`: early result says the target cannot fit; no contradictory “more information” result. |
| 1.5 | Fixed | Student 40, `../snapshots/40.txt:20` and `:32`: the top status is “More information needed,” and the diagnostic explains which requirement did not fit. Neither says the plan is ready. |
| 1.6 | Fixed | Student 09, `../snapshots/09.txt:135`: only blocked requirements are listed. |
| 1.7 | Fixed | Student 42, `../snapshots/42.txt:22` and `:58`: full section is described without blaming student answers. |
| 1.8 | Fixed | Student 30, `../snapshots/30.txt:56`: the Winter count separates planned courses from room saved for others. |
| 1.9 | Fixed | Student 19, `../snapshots/19.txt:86`: MAT 121 and same-term instructor approval are explicit. |
| 1.10 | Fixed | Student 01, `../snapshots/01.txt:28` and `:31`: screen plan status is “Ready to plan”; the confusing “Conditional plan” display is removed. Feasibility remains in the API for validation. |
| 1.11 | Fixed | Student 09, `../snapshots/09.txt:9` and `:26`: May 2028 is the standard target and May 2027 is separately reported as the requested early target. |
| 1.12 | Fixed | Student 02, `../snapshots/02.txt:311`: prerequisite notes describe the actual term order; same-term approval appears only if the plan uses it. |
| 2.1 | Fixed | Student 13, `../snapshots/13.txt:35`: the screen identifies the verified section, matching the PDF. |
| 2.2 | Fixed | Student 29, `../snapshots/29.txt:26`: names the reserved count instead of “that number.” |
| 2.3 | Fixed | Student 10, `../snapshots/10.txt:74`: approval note names the Economics Department and says to ask before registration. |
| 2.4 | Fixed | Student 34, `../snapshots/34.txt:27`: names Finance and electives and directs the student to an advisor. |
| 2.5 | Fixed | Student 40, `../snapshots/40.txt:32`, and student 41, `../snapshots/41.txt:27`: no-plan reasons name the obstacle and next step. |
| 2.6 | Fixed | Student 30, `../snapshots/30.txt:60`: tuition note gives the plan's actual Winter-plus-May total. |
| 2.7 | Fixed | Student 13, `../snapshots/13.txt:84`: ECO 161 checklist row explains the one permitted 100-level elective. |
| 2.8 | Fixed | Student 04, `../snapshots/04.txt:26`: the no-plan standing note explains that graduation year does not establish senior standing; student 07's plan also directs the student to an advisor and the Registrar (`../snapshots/07.txt:55`). |
| 2.9 | Fixed | Student 16, `../snapshots/16.txt:23`: the student is told to show the PDF to an advisor. |
| 2.10 | Fixed | Student 44, `../snapshots/44.txt:103`: the current-term note says Winter has started and to mark enrolled classes Taking now. |
| 3.1 | Fixed | Student 01, `../snapshots/01.txt:20` and `:27`: status replaces “plan feasibility” jargon. |
| 3.2 | Fixed | Student 37, `../snapshots/37.txt:27`: Finance/Economics elective explanation uses course counts and one-course May limit. |
| 3.3 | Fixed | Student 40, `../snapshots/40.txt:32`: plain requirement-specific result replaces “offering evidence.” |
| 3.4 | Fixed | Student 12, `../snapshots/12.txt:27`: plain terms and required-course explanation replaces abstract capacity language. |
| 3.5 | Fixed | Student 01, `../snapshots/01.txt:62`: ECO 461 note says last Winter rather than “eligible term.” |
| 3.6 | Fixed | Student 01, `../snapshots/01.txt:304`: PDF tells the student to pick an elective when the schedule comes out. |
| 3.7 | Fixed | Student 30, `../snapshots/30.txt:56`: approved extra-course wording is plain and shows the saved room. |
| 3.8 | Not a defect | Owner OD4 requires the capacity explanation when remaining required courses exceed available terms (`../../../policy/provenance/wording-review-decisions-2026-11-22.md:19`). Student 10 has 10 required courses and only two terms by May 2027 (`../snapshots/10.txt:27`). Students 35 and 43 retain the specific Statistics blocker. |
| 3.9 | Fixed | Student 29, `../snapshots/29.txt:26`: reserved courses and the “Save less room” action are explicit. |
| 3.10 | Not a defect | `../../../policy/provenance/wording-review-decisions-2026-11-22.md:29` explicitly keeps “Ready to plan” and limits “Needs confirmation” to approvals/standing. The API's readiness label is not a grade. |
| 3.11 | Fixed | Student 05, `../snapshots/05.txt:23`: AP-credit review names the credit and what the advisor must confirm. |
| 3.12 | Fixed | Student 42, `../snapshots/42.txt:38`: full-section marker says to check for open seats. |
| 3.13 | Fixed | Student 48, `../snapshots/48.txt:50`: empty grid row says “No Economics course this term.” |
| 3.14 | Fixed | Student 09, `../snapshots/09.txt:68` and `:69`: the advisor section has no standalone catalog sentence when no older-catalog difference follows. |
| 3.15 | Fixed | Student 17, `../snapshots/17.txt:23`: the instruction names ECO 114. |
| 3.extra | Fixed | Student 01, `../snapshots/01.txt:145`: Explore the Major now says “this year,” not “first year.” |
| 4.1 | Not a defect | `../../../app/page.js:2200` renders course-specific grid notes and `../../../lib/planning/plan-presentation.js:320` renders a separate registration action. These refer to different courses/decisions, and the panel duplicate rule applies to sentences within one plan, not grid rows. |
| 4.2 | Not a defect | `../../../policy/provenance/owner-planning-decisions-2026-11-21.md:23` requires the review reason in readiness, checklist and PDF. Student 16, `../snapshots/16.txt:23`, `:78`, `:186` shows the required projections, with a shorter checklist marker. |
| 4.3 | Fixed | Student 04, `../snapshots/04.txt:26`: the standing explanation appears once in the no-plan result. |
| 4.4 | Fixed | Student 28, `../snapshots/28.txt:41` and `:58`: grid/checklist have a short approval marker and one full advisor note. |
| 4.5 | Fixed | Student 01, `../snapshots/01.txt:95`: choice alternatives appear once below the checklist, not on every row. |
| 4.6 | Fixed | Student 09, `../snapshots/09.txt:169`: the published ECO 321 placement has no “Previously offered” label. |
| 4.7 | Fixed | Student 04, `../snapshots/04.txt:24`, and student 01, `../snapshots/01.txt:80`: filler sentences were removed. The PDF “Plan Notes” heading remains a useful appendix title with content below it. |
| 4.8 | Fixed | Student 11, `../snapshots/11.txt:22`, and student 42, `../snapshots/42.txt:22`: active petition notes have a paperwork pointer on screen and PDF. Optional-petition authority remains N5. |
| 5.1 | Not a defect | Student 01, `../snapshots/01.txt:33`: “2026/2027” is the grid's academic-year column and “Winter” its term column; “Winter 2027” is the prose name for that same term. |
| 5.2 | Fixed | Student 02, `../snapshots/02.txt:9` and `:383`: screen and PDF both say “Graduation target.” |
| 5.3 | Fixed | Student 01, `../snapshots/01.txt:20`, and student 04, `../snapshots/04.txt:20`: both summary boxes say “Status.” |
| 5.4 | Fixed | Student 01, `../snapshots/01.txt:48` and `:172`: screen and PDF both say “Economics elective (200 level or higher).” |
| 5.5 | Fixed | Student 30, `../snapshots/30.txt:56`: course counts replace unit-ceiling jargon in student text. |
| 6.1 | Fixed | Student 24, `../snapshots/24.txt:54`: “them” agrees with plural courses. |
| 6.2 | Fixed | Student 19, `../snapshots/19.txt:321`: singular “was completed.” |
| 6.3 | Fixed | Student 45, `../snapshots/45.txt:27`: “1 term left by May 2027.” |
| 6.4 | Fixed | Student 09, `../snapshots/09.txt:26`: the early-target heading has a space and a consistent status. |
| 6.5 | Fixed | Student 32, `../snapshots/32.txt:183`: the PDF names the ECO 214 instructor and same-term MAT 113 approval. |
| 6.6 | Fixed | Student 25, `../snapshots/25.txt:55`: the petition sentence is split and has no semicolon. |
| 6.7 | Fixed | Students 05 and 47, `../snapshots/05.txt:79` and `../snapshots/47.txt:82`: AP/transfer markers use one credit label. |
| 6.8 | Fixed | Student 37, `../snapshots/37.txt:27`: May course choices use “May 2027” and “or.” |
| 6.9 | Fixed | Student 18, `../snapshots/18.txt:67`: the Winter 2027 prerequisite note names only ECO 321. OD6 places ECO 221 in another term, so there is no longer a two-course note to group. |
| 6.10 | Fixed | Student 07, `../snapshots/07.txt:22`: one-plan status uses singular “This plan.” |
| 6.11 | Fixed | Student 27, `../snapshots/27.txt:73`: “can count” completes the sentence. |
| 6.12 | Fixed | Student 19, `../snapshots/19.txt:321`: advisor sentence uses one apostrophe style. |
| 7.1 | Fixed | Student 20, `../snapshots/20.txt:30`, and student 21, `../snapshots/21.txt:39`: abroad terms now affect the planner, with a regression in `../panel-study-abroad.test.js`. |

## Review boundary

OD5, OD6, OD7 and the already recorded OD3 control the plan changes. The only other permitted plan changes are the study-abroad panel correction and ECO 257 projected-offering correction. The unused single-plan page branch around `app/page.js:2311-2319` is unreachable through current navigation; it is retained for a later cleanup as requested.

## Verification

- Findings: 87 fixed, 5 not a defect with evidence, and 5 reserved owner decisions.
- `panel:run` regenerated all 50 students in 129.29 seconds. Its output hashes matched the prior regenerated artifacts exactly. The earlier, pre-repair run time was not recorded, so no before/after speed claim is made.
- `panel:check` passed all 50 snapshots, plan files, and the trace against a production build in 140.04 seconds. `panel:lint` found 0 violations: semicolon 0, word limit 0, banned term 0, placeholder 0, duplicate 0, status contradiction 0.
- The 11 panel self-tests passed, including planted course, inventory, 30-word sentence, duplicate sentence, and contradictory-status errors. The completed-math tie test failed with MAT 121 when the old order-dependent tie was deliberately planted, then passed after restoration.
- Browser shards passed 34/34, 34/34, 33/33, and 33/33. The two move-matrix halves passed; their combined coverage checked 1,574 course-to-term pairs. The workflow's deterministic policy, canonical, bounded regression, companion-matrix, lint, production build, and PDF dry-run checks passed.
- `violations.txt` contains only the raw `node scripts/panel/lint.mjs` output. `panel:check` uses a temporary output directory and did not rewrite the snapshots, plan JSON, or trace.

## Files changed

- `.github/workflows/econplanner-pr-tests.yml`
- `AGENTS.md`
- `app/page.js`
- `data/compiled/policy/active.json`
- `data/compiled/policy/planning-flexibility/active.json`
- `data/compiled/policy/releases/econ-2025-2026.1/bundle.json`
- `data/compiled/policy/releases/econ-2025-2026.1/bundle.sha256`
- `data/compiled/policy/releases/econ-2025-2026.1/compatibility/courses.json`
- `data/compiled/policy/releases/econ-2025-2026.1/compatibility/requirements.json`
- `data/compiled/policy/releases/econ-2025-2026.1/compile-report.json`
- `data/compiled/policy/releases/econ-2025-2026.1/dependency-impact.md`
- `data/compiled/policy/releases/econ-2025-2026.1/policy-diff.md`
- `data/normalized/economics/courses.json`
- `data/normalized/economics/requirements.json`
- `lib/assignment/solve.js`
- `lib/catalog/planning-requirements-note.js`
- `lib/decision-engine/placement.js`
- `lib/decision-engine/plan.js`
- `lib/planning/acceleratedMathSequence.js`
- `lib/planning/acceleratedResult.js`
- `lib/planning/completion-blockers.js`
- `lib/planning/economics.js`
- `lib/planning/historical-prerequisites.js`
- `lib/planning/no-plan-presentation.js`
- `lib/planning/noPlanResult.js`
- `lib/planning/plan-display.js`
- `lib/planning/plan-notes.js`
- `lib/planning/plan-presentation.js`
- `lib/planning/student-language.js`
- `lib/planning/termSolver.js`
- `lib/policy/compatibility-projection.js`
- `lib/policy/term-load.js`
- `lib/reports/economics-html.js`
- `lib/reports/economics.js`
- `policy/compatibility/economics.json`
- `policy/messages/en-US.json`
- `policy/provenance/owner-decisions-2026-11-22b.md`
- `policy/provenance/planning-flexibility.13.json`
- `policy/provenance/sources.json`
- `policy/rules/planning-flexibility.json`
- `scripts/panel/lint.mjs`
- `scripts/panel/run.mjs`
- `tests/e2e/architecture-repairs.spec.js`
- `tests/e2e/course-moves.spec.js`
- `tests/e2e/cp7-helpers.js`
- `tests/e2e/econ-planner-accessibility.spec.js`
- `tests/e2e/econ-planner-parity.spec.js`
- `tests/e2e/econ-planner.spec.js`
- `tests/e2e/plan-notes-evidence.spec.js`
- `tests/e2e/planning-explanations.spec.js`
- `tests/e2e/requested-behaviors.spec.js`
- `tests/economics-candidate-pools.test.js`
- `tests/economics-owner-panel-decisions.test.js`
- `tests/economics-plan-editing-api.test.js`
- `tests/economics-replacement-moves.test.js`
- `tests/economics-report-parity.test.js`
- `tests/fixtures/pdf-layout-profiles.v1.json`
- `tests/major-api.test.js`
- `tests/major-checklist-presentation.test.js`
- `tests/oracle/economics-artifact-projection.js`
- `tests/panel/fact-variants.txt`
- `tests/panel/panel-review-regressions.test.js`
- `tests/panel/panel-self-test.test.js`
- `tests/panel/panel-study-abroad.test.js`
- `tests/panel/plans/01.json`
- `tests/panel/plans/02.json`
- `tests/panel/plans/03.json`
- `tests/panel/plans/05.json`
- `tests/panel/plans/08.json`
- `tests/panel/plans/09.json`
- `tests/panel/plans/10.json`
- `tests/panel/plans/11.json`
- `tests/panel/plans/12.json`
- `tests/panel/plans/13.json`
- `tests/panel/plans/14.json`
- `tests/panel/plans/15.json`
- `tests/panel/plans/16.json`
- `tests/panel/plans/17.json`
- `tests/panel/plans/18.json`
- `tests/panel/plans/19.json`
- `tests/panel/plans/20.json`
- `tests/panel/plans/21.json`
- `tests/panel/plans/26.json`
- `tests/panel/plans/46.json`
- `tests/panel/plans/47.json`
- `tests/panel/plans/48.json`
- `tests/panel/plans/49.json`
- `tests/panel/reviews/2026-11-22-changed-sentences.md`
- `tests/panel/reviews/2026-11-22-plan-changes.md`
- `tests/panel/reviews/2026-11-22-resolution.md`
- `tests/panel/reviews/2026-11-22-test-assertions.md`
- `tests/panel/snapshots/01.txt`
- `tests/panel/snapshots/02.txt`
- `tests/panel/snapshots/03.txt`
- `tests/panel/snapshots/04.txt`
- `tests/panel/snapshots/05.txt`
- `tests/panel/snapshots/06.txt`
- `tests/panel/snapshots/07.txt`
- `tests/panel/snapshots/08.txt`
- `tests/panel/snapshots/09.txt`
- `tests/panel/snapshots/10.txt`
- `tests/panel/snapshots/11.txt`
- `tests/panel/snapshots/12.txt`
- `tests/panel/snapshots/13.txt`
- `tests/panel/snapshots/14.txt`
- `tests/panel/snapshots/15.txt`
- `tests/panel/snapshots/16.txt`
- `tests/panel/snapshots/17.txt`
- `tests/panel/snapshots/18.txt`
- `tests/panel/snapshots/19.txt`
- `tests/panel/snapshots/20.txt`
- `tests/panel/snapshots/21.txt`
- `tests/panel/snapshots/22.txt`
- `tests/panel/snapshots/23.txt`
- `tests/panel/snapshots/24.txt`
- `tests/panel/snapshots/25.txt`
- `tests/panel/snapshots/26.txt`
- `tests/panel/snapshots/27.txt`
- `tests/panel/snapshots/28.txt`
- `tests/panel/snapshots/29.txt`
- `tests/panel/snapshots/30.txt`
- `tests/panel/snapshots/31.txt`
- `tests/panel/snapshots/32.txt`
- `tests/panel/snapshots/33.txt`
- `tests/panel/snapshots/34.txt`
- `tests/panel/snapshots/35.txt`
- `tests/panel/snapshots/36.txt`
- `tests/panel/snapshots/37.txt`
- `tests/panel/snapshots/38.txt`
- `tests/panel/snapshots/39.txt`
- `tests/panel/snapshots/40.txt`
- `tests/panel/snapshots/41.txt`
- `tests/panel/snapshots/42.txt`
- `tests/panel/snapshots/43.txt`
- `tests/panel/snapshots/44.txt`
- `tests/panel/snapshots/45.txt`
- `tests/panel/snapshots/46.txt`
- `tests/panel/snapshots/47.txt`
- `tests/panel/snapshots/48.txt`
- `tests/panel/snapshots/49.txt`
- `tests/panel/snapshots/50.txt`
- `tests/panel/trace.json`
- `tests/panel/trace.md`
- `tests/panel/unique-lines.txt`
- `tests/panel/violations.txt`
- `tests/plan-notes-elective-evidence.test.js`
- `tests/requested-behaviors.test.js`
- `tests/schedule-correction-2027.test.js`
- `tests/student-facing-language.test.js`
