# Economics planning, checklist and approved portrait report verification

## Scope and authority

The September 28 owner instructions govern unpublished-term elective planning, future finance uncertainty and presentation. Academic rules and provenance are maintained in `policy/`, compiled normally. Historical workbook observations remain informational, independently implemented Oracle checks remain independent, and fictional template data is not academic evidence. The approved ZIP and source boundaries are recorded in `policy/provenance/approved-pdf-presentation-2026-09-28.md` and the preceding planning/checklist provenance records.

The accumulated task preserves requirements, prerequisites, load limits, capstone standing and qualifying completed/current credit. One named or generic elective per unpublished Fall/Winter/May term applies to generation, validation, moves and saved-plan revalidation. More requires individually matching verified sections and independent academic checks. Unsupported future electives use eligible slots; BUSN 323 is preferred when it fits, with future offerings unconfirmed. Extra elective and finance needs remain visible and conditional.

## Presentation and wording

- Old Strict/Optimistic/In progress/Evidence comparison becomes `Requirement | Course / term | Status`, in canonical requested order, with separate elective rows and `ECO 461 / Senior Seminar`.
- Completed, In progress and Planned use symbols plus text/color on each qualifying row. Complete-plan legends omit Still needed. Incomplete candidates identify unmet requirements separately: `This alone does not establish that no viable plan exists.`
- Stale or undated OPEN/FULL display becomes `Seat availability not confirmed`; historical observations remain preserved. Uniform PDF uncertainty is explained once.
- Hypothetical course-option dumps and repeated prerequisite prose become concise actual conditions, affected-course markers and details on demand. Required approval explicitly remains unrecorded.
- Schedule comes first in the approved portrait Year/Fall/Winter/May grid, with all remaining years on page 1 and an intact checklist. Titles/options remain readable supporting text. Notes follow in CCR/ACE, history, upcoming courses and future-years order, with equal 12pt Winter/May listing indentation.
- Missing-plan reports no longer substitute the entire published offering list for student assignments. They show empty planning terms and actual unmet requirements.
- Local `report:economics` now uses the same canonical HTML/template and existing Chromium dependency. The legacy ReportLab utility is retained and labeled; it is no longer the report command's renderer.

Move feedback: `Checking change…` then live DOM status `Change saved.`; the affected course shows `Moved to Winter 2027. Plan checks pass.` A blocked request preserves the plan, and undo clears the stale course message.

## Checks completed locally

- `pnpm run compile:policy`: PASS. Bundle hash `sha256:7219988d20b6f5a1f51a0644ec53f59db63254719c4e75e7c9461d552e223b10`; generated output was not edited manually.
- `pnpm test`: 699 tests, 698 PASS, one optional nightly-property SKIP. Following the final incomplete-report repair, `node --test tests/major-checklist-presentation.test.js tests/economics-report.test.js tests/economics-report-parity.test.js tests/plan-notes-elective-evidence.test.js tests/cp5a-plan-coverage.test.js`: 79 PASS.
- `pnpm exec playwright test tests/e2e/architecture-repairs.spec.js tests/e2e/plan-notes-evidence.spec.js tests/e2e/econ-planner-accessibility.spec.js`: 16 PASS. Actual generation/selection, allowed and blocked moves, undo/reload, saved-field forgery revalidation, desktop/mobile focus, labels, notes/checklist and Axe checks are covered. Earlier task browser results are retained; CI reruns the existing broader suite.
- `pnpm run verify:pdf:economics -- --dry-run`: PASS (independent JSON/HTML/PDF-request projection and fictional contract fixtures).
- `node scripts/verify-approved-economics-layout.mjs`: PASS, ten API exports. The actual application report API and PDF client are exercised with an injected local Chromium transport; no hosted service or environment settings are changed. All years are on page 1, checklists remain intact, actual conditions occur once and section indentation matches. This does not claim hosted-renderer verification.
- All 25 pages across the ten final Chromium sample/mixed/long/incomplete reports were visually inspected for clipping, wrapping, symbols, course row order, titles/options, notes and readability. Balanced and Explore First sample reports have two pages; One Year Early has three to retain real conditions and an intact readable checklist. Longer or conditional profiles flow naturally; no fixed clipped page height or omitted content.
- `pnpm run report:economics -- tests/fixtures/economics-report-student.json output/economics-pdf-verification/approved-portrait/cli`: PASS; shared local Chromium HTML/PDF inspected.
- `pnpm run lint`: PASS, zero errors; existing unused `lower` warning in `scripts/normalize-hanover-catalog.mjs:125` remains.
- `pnpm run build`: PASS.
- `git diff --check`: PASS.

- Release CI initially passed policy/Oracle and lint/build but exposed 13 browser timing failures: saved-plan assertions ran while the planner was still loading, and the two multi-profile notes journeys exceeded their 30-second budget. Trace evidence shows separate validation requests taking about 2.4 seconds each. Reload tests now wait for the visible restoration boundary (bounded at 30 seconds), with bounded 60/90-second journey budgets; every state, blocked-request, forged-session and persistence assertion is retained. `pnpm exec playwright test tests/e2e/architecture-repairs.spec.js tests/e2e/course-moves.spec.js tests/e2e/plan-notes-evidence.spec.js`: 29 PASS. Lint and diff checks PASS. Full CI is rerun before merge.

Detailed local artifacts and page renders are retained under ignored `output/economics-pdf-verification/approved-portrait/`. The three requested fictional revised PDFs are under `output/pdf/`.

## Gaps and release follow-through

Actual screen-reader speech: **NOT RUN**. Speech capture is unavailable in this environment. DOM live-region records, keyboard focus and Axe are separate evidence and are not speech tests.

BUSN 323 historical section series is missing from the supplied workbooks and canonical historical sources. Exact Fall 2026 offering/Winter 2027 absence do not establish future availability. Future BUSN 323, ECO 321 adjunct staffing and extra 2027–28 elective funding/offerings remain unconfirmed. Unsupported general-degree catalog/cohort claims remain identified for advisor review.

Owner-authorized release follows local review/checks: commit task files, push, PR against main, wait for required CI/review checks, merge without bypass, verify the merged Production deployment with fictional plans/moves and hosted PDF if enabled, and safely fast-forward local main. No unrelated environment/infrastructure changes or service activation are authorized. Release identities and Production results are recorded separately after the merged commit exists.
