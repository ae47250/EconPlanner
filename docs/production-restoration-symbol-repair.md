# Production reload and PDF symbol repair

The canonical student URL is https://econ-major-course-planner.vercel.app/. The September 29 owner request authorizes repairing the two observed failures and completing the existing release workflow. This repair changes no academic policy, schedules, Oracle implementation, domains, access settings or service configuration.

## Reproduced causes

- A fictional freshman's allowed MAT 217 move returned HTTP 200 after 24,604 ms. Reload then aborted the first saved-plan validation after 14,922 ms. Restoration validated three plans serially under one 15-second deadline; each request rebuilt move/replacement controls for all three plans although it returned only one. Any interruption was treated as an invalid session and deleted it.
- Actual hosted PDFs embedded Open Sans regular/bold, but the checklist page contained 15 glyph-zero text entries: 12 row icons and three legend icons. The embedded Unicode maps did not contain the requested symbols. The problem was unsupported glyphs in the hosted font environment, not missing font embedding. Text labels survived; the symbols did not.

## Repair and wording

Current-policy fingerprint verification remains mandatory. Each saved plan and recoverable undo is academically revalidated before display. Requests retain the existing five-second fingerprint and 15-second validation limits. Independent plan requests run concurrently; the server rebuilds controls only for the requested plan, while retaining every peer in academic and plan-set validation. An equivalence regression compares targeted rebuilding with rebuilding the full set.

Transport interruption, server failure or incomplete successful responses retain the original saved session. The UI shows: “Saved plans could not be checked right now. Your saved plans and edits are kept. Retry to validate and restore them.” The explicit retry restores selection, edits and undo only after successful validation. Pending restoration is cancelled when inputs or generation change; late responses cannot overwrite newer work. Temporary failure never displays the saved plan as validated.

Academic rejection instead shows: “The saved plan does not pass current academic checks. Your saved answers are kept; generate new plans.” Obsolete policy/schema/input sessions still require regeneration. Clear all explicitly clears recoverable data.

Report HTML draws the large green check, dark half-circle on the light-blue In progress badge, and neutral open Planned circle using CSS borders/fill. Every row and legend retains its readable text label; decorative shapes are hidden from assistive technology. Symbol meaning is independent of installed fonts and remains distinguishable in grayscale. The approved portrait grid, course order, actual conditions and notes are retained. The three fictional revised PDFs are regenerated using the application's report route/client and Chromium transport.

## Local verification

- `pnpm test`: 705 tests, 704 passed, one optional nightly-property skip; no failures. Subsequent affected session/API/Oracle/boundary checks: 41 passed. Targeted option-equivalence/session checks: 23 passed.
- Full six-spec browser run: 90 passed, three old wording assertions exposed the newly required distinction between unavailable and invalid saved data. After correcting those assertions/wording, `pnpm exec playwright test tests/e2e/course-moves.spec.js tests/e2e/plan-notes-evidence.spec.js`: all 26 passed. The other 67 cases reuse their passing results. Coverage includes all three selections/repeated reloads, allowed/blocked MAT 217 moves, edited reload, undo/reload, the simulated 15-second interruption, retry, repeated temporary failure, obsolete/invalid saved data, forged presentation and late-response protection.
- `pnpm run verify:pdf:economics -- --dry-run`: passed.
- `node scripts/verify-approved-economics-layout.mjs`: ten fictional application exports passed, 25 pages. All remaining years stay on page one, the checklist stays intact, conditions occur once and note order/indentation/content match. Page layout and mixed-state symbols were inspected, including a grayscale checklist render. This is local Chromium evidence; it does not substitute for the hosted service.
- `pnpm run lint`: zero errors; the existing unused `lower` warning in `scripts/normalize-hanover-catalog.mjs` remains. Build and whitespace checks run before commit.

The new session regression is included in the existing deterministic CI gate. Full CI and actual Production verification follow the normal release; detailed results and hosted color/grayscale page renders are retained under ignored `output/economics-pdf-verification/production-restoration-symbol-repair/`.

Actual screen-reader speech: **NOT RUN** because speech capture is unavailable. Keyboard, DOM live-region and Axe checks remain separate evidence.
