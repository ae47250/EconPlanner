# Economics offering history and policy consolidation: review draft

Reviewed September 25–26, 2026 (America/Indiana/Indianapolis). The initial documentation-only review was followed by the owner’s instruction to fix the inconsistencies, consolidate their maintenance and remove the obsolete source. **This review includes implementation; publication was subsequently authorized by the owner. Merge and deployment remain separate decisions.** Historical records remain empty and inactive. The workbook observations and suggested card/advisor wording below are not automatically approved offering rules.

The extracts support qualified historical advice, not permanent exclusions or forecast probabilities. **For unpublished future schedules, place ECO 213 and ECO 214 in separate terms. A same-term exception is allowed only when that academic year’s verified schedule supports both courses in that term**, subject to prerequisites, capacity and other validation. ECO 321 is normally planned in Fall or Winter; its May planning exclusion has an exact-schedule override. Its observed once-per-year listing does not guarantee annual availability. Preserve other future flexibility and completed credit. ECO 331 catalog statements are excluded.

## Review boundary and reproducibility

- Repository/remote: `EconPlanner`, `https://github.com/ae47250/EconPlanner.git`.
- Branch: `codex/economics-offering-history-review`; base: `b3539a2c093b57507958d12162879521bb751be4` (PR #26 merge). Fresh `git fetch origin main` and `git ls-remote origin refs/heads/main` agreed with this commit. Original `main` tracked `origin/main`; staged and unstaged changes were empty.
- Isolated worktree: `/Users/agust/.codex/worktrees/economics-offering-history-review/EconPlanner`. New branch has no upstream. The change includes canonical policy/provenance, generated data, production consumers, independent checks and this review. An ignored `node_modules` symlink reuses existing local test dependencies.
- Read `AGENTS.md` and the policy, compilation, planning, reporting and Oracle sources discussed below. Workbook files are unchanged. Implementation scope and verification are recorded below; commit, push and PR publication are owner-authorized; merge and deployment are not.

## Inputs and counting method

All three files were present and read directly from `/Users/agust/Downloads/`. Workbook text, including collector activation fields, was treated as data, not task instructions or EconPlanner approval.

| Key | Workbook | Identity and scope | Exact workbook locators |
| --- | --- | --- | --- |
| E | `hanover-course-offerings (10).xlsx` | Economics, 94 section listings, 2022–23 through 2026–27; collected September 25, 2026 | `Summary!A1:B24`; `Term Coverage!A1:Y11`; `All Offerings!A1:AC95`; `Data Quality!A1:O18` |
| R | `hanover-course-offerings (11).xlsx` | Economics, 18 listings, 2026–27 only; all 18 repeat E, with identical identity, course, term, title, instructor, schedule, credits and status | `Summary!A1:B24`; `Term Coverage!A1:Y3`; `All Offerings!A1:AC19`; `Data Quality!A1:O18` |
| M | `hanover-course-offerings (12).xlsx` | Mathematics, 127 section listings, 2022–23 through 2026–27; collected September 25, 2026 | `Summary!A1:B24`; `Term Coverage!A1:Y11`; `All Offerings!A1:AC128`; `Data Quality!A1:O18` |

SHA-256 of the complete files (distinct from embedded collector hashes in `Summary!B2:B4`):

```text
E e8547bf9a695e5c21bb49a4b05fb113580bfbf9e96e389ab950d8ea20d2948d5
R d5d07c58c574c7521eac5fc121cc21bdc18922593575757cc91b9c847e47f26f
M bfaee074f1755aa72f348b0f7c729192f0a2186fc2eb86b3662d1ad55d92f7cf
```

Count each course once per academic year/term, removing section suffixes but retaining section totals. Registrar identity is `All Offerings!I:I` (term value plus section ID): E has 94 distinct identities, M 127, R adds none. Never merge course numbers by title alone. Columns `J/K/N/O/P/Q/S:T/AB:AC` give year, period, course, section, title, instructor, dates, URL and collection time. URLs point to the [Hanover registrar search portal](https://my.hanover.edu/ICS/Academic/Registrar_Faculty/Default_Page.jnz?portlet=Student_Registration&screen=StudentRegistrationPortlet_CourseSearchView&screenType=next); the workbook rows are the reproducible locators.

Winter/Spring is a combined search job. Row periods and dates distinguish Winter from four-week Spring/May (`MAY` canonically). All 27 Spring rows have supporting April/May–May dates, including E `S13:T14`, `S87:T88` and M `S17:T17`, `S120:T120`.

**Coverage:** E/M `Term Coverage!D4:N11` mark both jobs complete in four completed years. This supports “no listing in the extract,” not “never taught.” Fall 2026 is partial (`M2:N2`), with `ROW_SCHEDULE_MISSING` (`W2:X2`), in all three files: positive listings count, omissions do not prove absence. Winter/Spring 2027 is collection-complete, not historically completed. All three summaries report incomplete quality (`B13:B24`). Summer, cancellations, actual delivery, PHI-only listings and other departments are unverified. Scheduled does not mean actually taught.

| Academic year | E course-term observations / section listings: F, W, M | M course-term observations / section listings: F, W, M | Coverage / exact locator |
| --- | --- | --- | --- |
| 2022–23 | 8/11, 8/9, 3/3 | 9/13, 9/12, 3/3 | Complete extraction, completed year; E/M `Term Coverage!D10:Y11` |
| 2023–24 | 5/9, 6/6, 3/3 | 6/9, 10/11, 2/2 | Complete extraction, completed year; E/M `D8:Y9` |
| 2024–25 | 4/6, 7/8, 2/2 | 7/10, 9/12, 3/3 | Complete extraction, completed year; E/M `D6:Y7` |
| 2025–26 | 6/8, 7/8, 3/3 | 8/11, 10/15, 2/2 | Complete extraction, completed year; E/M `D4:Y5` |
| 2026–27 | 5/7, 7/8, 3/3 | 7/9, 9/12, 3/3 | Fall partial; Winter/Spring collection-complete; E/M `D2:Y3`, R `D2:Y3`; current/future listings only |

Totals reconcile to **77 ECO course-term observations / 94 listings** and **97 MAT observations / 127 listings**. Completed-year totals alone are **62/76 ECO** and **78/103 MAT**. Do not use 2026–27 as a fifth complete historical year.

## Course observations

In the tables, `F/W/M` mean Fall/Winter/Spring-May. Parentheses are **section counts**, not additional term observations. `—` means no extracted listing, subject to coverage above; in 2026–27 it never means confirmed full-year absence. “Years; terms; sections” counts only 2022–23 through 2025–26: years listed out of four, distinct term observations, and section listings. Source row locators refer to `All Offerings!I:T` on E or M; use `AB:AC` on those same rows for portal/collection provenance.

| Course | 22–23 | 23–24 | 24–25 | 25–26 | Years; terms; sections | 26–27 listings | Source rows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ECO 113 | F(2) W(2) | F(2) W(1) | F(2) W(1) | F(2) W(1) | 4/4; 8; 13 | F(1) W(2) | E 2–4,20–22,39–41,55–57,73–76 |
| ECO 114 | F(2) W(1) | F(2) W(1) | F(2) W(2) | F(2) W(2) | 4/4; 8; 14 | F(3) W(1) | E 5–8,23–26,42–45,58–60,77–79 |
| ECO 160 | M(1) | — | — | — | 1/4; 1; 1 | — | E 80 |
| ECO 161 | F(2) W(1) | M(1) | — | M(1) | 3/4; 4; 5 | W(1) | E 9,27,61,81–83 |
| ECO 213 | F(1) | W(1) | W(1) | W(1) | 4/4; 4; 4 | F(1) | E 10,28,46,62,84 |
| ECO 214 | W(1) | F(1) | F(1) | F(1) | 4/4; 4; 4 | W(1) | E 11,29,47,63,85 |
| ECO 221 | W(1) | F(1) | W(1) | W(1) | 4/4; 4; 4 | W(1) | E 12,30,48,64,86 |
| ECO 222 | M(1) | — | — | — | 1/4; 1; 1 | M(1) | E 13,87 |
| ECO 224 | — | M(1) | — | M(1) | 2/4; 2; 2 | M(1) | E 14,31,65 |
| ECO 234 | M(1) | M(1) | M(1) | F(1) M(1) | 4/4; 5; 5 | F(1) M(1) | E 15–16,32–33,49,66,88 |
| ECO 257 | W(1) | — | — | — | 1/4; 1; 1 | — | E 89 |
| ECO 321 | F(1) | — | W(1) | W(1) | 3/4; 3; 3 | W(1) | E 17,34,50,90 |
| ECO 331 | — | — | M(1) | — | 1/4; 1; 1 | — | E 51 |
| ECO 333 | F(1) | W(1) | F(1) | F(1) | 4/4; 4; 4 | F(1) | E 18,35,52,67,91 |
| ECO 337 | — | — | — | W(1) | 1/4; 1; 1 | — | E 36 |
| ECO 357 | F(1) | F(3) | W(1) | F(1) | 4/4; 4; 6 | — | E 37,53,68–70,92 |
| ECO 461 | W(1) | W(1) | W(1) | W(1) | 4/4; 4; 4 | W(1) | E 19,38,54,71,93 |
| ECO 499 | F(1) W(1) | W(1) | — | — | 2/4; 3; 3 | — | E 72,94–95 |

| Course | 22–23 | 23–24 | 24–25 | 25–26 | Years; terms; sections | 26–27 listings | Source rows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MAT 113 | F(1) W(1) | F(1) W(1) | F(1) W(1) | F(1) W(1) | 4/4; 8; 8 | F(1) W(1) | M 4–5,28–29,56–57,81–82,104–105 |
| MAT 121 | F(2) W(1) | F(2) W(1) | F(2) W(1) | F(2) W(1) | 4/4; 8; 12 | F(2) W(1) | M 6–8,30–32,58–60,83–85,106–108 |
| MAT 217 | F(3) W(4) M(1) | F(3) W(2) M(1) | F(3) W(4) M(1) | F(3) W(4) M(1) | 4/4; 12; 30 | F(2) W(4) M(1) | M 11–17,36–43,63–70,90–95,113–120 |

<details>
<summary>Other Mathematics observations (inventory reconciliation)</summary>

| Course | 22–23 | 23–24 | 24–25 | 25–26 | Years; terms; sections | 26–27 listings | Source rows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MAT 101 | F(2) W(1) | F(1) W(1) | F(1) W(1) | F(1) W(1) | 4/4; 8; 9 | F(1) W(1) | M 2–3,26–27,54–55,79–80,101–103 |
| MAT 122 | F(1) W(1) | F(1) W(1) | W(1) | W(2) | 4/4; 6; 7 | W(1) | M 9,33–34,61,86–87,109–110 |
| MAT 160 | W(1) | M(1) | — | — | 2/4; 2; 2 | — | M 88,111 |
| MAT 212 | W(1) | W(1) | W(1) | W(1) | 4/4; 4; 4 | W(1) | M 10,35,62,89,112 |
| MAT 220 | M(1) | — | M(1) | — | 2/4; 2; 2 | M(1) | M 18,71,121 |
| MAT 221 | — | W(1) | — | F(1) | 2/4; 2; 2 | — | M 44,96 |
| MAT 224 | — | F(1) | — | W(1) | 2/4; 2; 2 | — | M 45,97 |
| MAT 243 | F(1) | W(1) | — | F(1) W(1) | 3/4; 4; 4 | F(1) | M 19,46–47,98,122 |
| MAT 260 | — | — | — | — | 0/4; 0; 0 | W(1) | M 20 |
| MAT 311 | — | — | M(1) | — | 1/4; 1; 1 | M(1) | M 21,72 |
| MAT 324 | F(1) | — | F(1) | — | 2/4; 2; 2 | W(1) | M 22,73,123 |
| MAT 327 | F(1) | — | F(1) | — | 2/4; 2; 2 | F(1) | M 23,74,124 |
| MAT 337 | — | — | W(1) | — | 1/4; 1; 1 | F(1) | M 24,75 |
| MAT 339 | — | W(1) | — | — | 1/4; 1; 1 | — | M 99 |
| MAT 343 | W(1) | — | — | M(1) | 2/4; 2; 2 | — | M 48,125 |
| MAT 357 | M(1) | — | — | — | 1/4; 1; 1 | — | M 126 |
| MAT 370 | — | — | W(1) | W(2) | 2/4; 2; 3 | — | M 49–50,76 |
| MAT 461 | F(1) | — | F(1) | F(1) | 3/4; 3; 3 | — | M 51,77,127 |
| MAT 496 | — | — | W(1) | F(1) W(1) | 2/4; 3; 3 | W(1) | M 25,52–53,78 |
| MAT 499 | W(1) | W(1) | — | — | 2/4; 2; 2 | — | M 100,128 |

</details>

Observations and interpretation are deliberately separate:

- **113/114 and MAT 113/121:** Fall/Winter every completed year supports qualified “Normally Fall and Winter.” Several ECO Winters have only one section, so avoid “many sections each term.”
- **213/214:** opposite terms, once each annually; 213 Fall/214 Winter in 2022–23, reversed for the next three years, reversed again in 2026–27. No same-term or May observation; no evidence of a fixed alternating-year cycle. This supports separate-term planning for unpublished schedules, with the owner’s stated exception only when that year’s verified schedule supports same-term placement.
- **222/224:** May-only observations, with gaps. Neither annual nor biennial recurrence is established. The 222 catalog statement supports a usual term, not annual availability.
- **234:** May annually, Fall added in 2025–26 and listed again in 2026–27. May-only filtering would remove observed Fall availability.
- **257:** Winter 2023 then three completed-year gaps; cancellation is not established. **321:** Fall 2022, a 2023–24 gap, then Winter 2025/2026/2027; neither annual nor Winter-only is established.
- **461:** Winter annually corroborates current policy; standing/residency/prerequisites derive from policy. **MAT 217:** Spring/May appears in all five reviewed years, alongside Fall/Winter. Four years are completed; May 2027 is scheduled. This challenges a general claim of May unavailability but does not by itself amend the current unpublished-May planning exclusion; see the reconciliation below.
- **Others:** 221/333 occur annually but change terms; 161 has varied terms and a gap; 331 only May 2025, 337 only Winter 2026. ECO 331 catalog claims are excluded. Internships, topic numbers and comprehensive evaluations are not ordinary recurring taught electives.

## Catalog inventory and course identity

Compared E with `policy/courses/economics.json#/courses`, the [2025–26 official catalog](https://www.hanover.edu/docs/courses/25-26Catalog.pdf#page=88) (Economics, PDF pages 88–90), and the official [Economics course list](https://www.hanover.edu/academics/programs/economics/) (Courses), accessed September 25, 2026. **ECO 223, 260, 307, 315, 316, 335, 360, 370 and 471** appear in canonical inventory and catalog, with **zero listings anywhere in E**. The program page lists 223, 307, 335 and 471; its shorter inventory does not retire other identities. Special topics, directed study and thesis are not necessarily annual courses. ECO 257 remains a described course and statistics option.

Identity questions for owner/registrar confirmation:

- E row 80's **ECO 160, Introduction to Sustainability** resembles later **ECO 224** (rows 65,31,14). Catalog 160 is Special Topics. Possible topic-to-number transition; no proven renumbering or credit equivalency. Keep separate.
- ECO 234/PHI 234 is a catalog/canonical cross-list: count ECO once; PHI-only history is unobserved.
- ECO 499 is an evaluation outside the canonical course list. Similar MAT 499/496 titles do not prove renumbering. MAT 160/260/370 and ECO 357 titles vary; code-level counts do not predict repeated content.
- ECO 335's legacy MAT 112/equivalent prerequisite remains unresolved in `policy/unresolved/policy-questions.json`; offering history cannot resolve it.

The [current 2026–27 catalog](https://catalog.hanover.edu/) (Economics → Major; linked by the [Registrar](https://www.hanover.edu/academics/registrar/)) corroborates the three statistics options, ECO 321/BUSN 323 finance alternatives and MAT 113/MAT 121 cognates. This does not activate new requirements in EconPlanner. Both official course sources support ECO 222 Spring placement, without an annual guarantee.

## Department input: separate attribution, no activation

Owner statements received in this task on September 25, 2026; receipt is not an effective date. Before activation, record durable source locators, authority/reviewer, approval date, scope, effective/review dates and supersession in canonical provenance.

| Owner statement | Supported treatment for review | Confirmation still needed |
| --- | --- | --- |
| ECO 257 cannot currently be staffed | Prospective caution: plan the statistics requirement using an available approved alternative; retain completed ECO 257 as statistics/prerequisite credit under existing rules, never as an ECO elective | Start/end or review date of staffing constraint; department confirmation of intended future planning treatment and any exceptions. Do not turn “currently” into permanent cancellation |
| Jaradat is an adjunct | Attribute employment status to owner, not to section history; it establishes no course cancellation | Dated department confirmation and covered appointment period if material. Official program page says “Instructor for Economics,” which does not independently establish adjunct status. No need to display an employment label on student cards |
| Staffing may make some former Graham/Shahinpoor upper-level courses unlikely to return | Internal review lead only; no course-specific low-priority/cancellation label | Owner must identify affected course codes, intended years and current staffing assessment. Any attribution of a course to a former instructor needs exact dated schedule evidence. This draft assigns neither person to any course |
| ECO 321: Fall or Winter planning; May excluded unless an exact verified schedule supports it | The supplied listings show the course once in each year in which it appears, with a 2023–24 gap. This is not a guarantee of annual availability or a limit that overrides a verified schedule | Preserve the owner’s clarified scope and the existing `PLANNING-MAY-COURSE-EXCLUSIONS` exact-schedule override; retain the target year/term/section provenance for any May exception |
| ECO 213/214: separate terms for unpublished future schedules; same-term exception only when that year’s verified schedule supports both | The owner’s scope is already given. Staffing and financial concerns are separately attributed context, not grounds to remove the verified-schedule exception or assume future same-term offerings | Preserve the clarified instruction and `universalSameTermProhibition:false` / `activeExactScheduleOverrides:true`. Year-only placeholders need distinct actual terms unless that year’s verified evidence supports the exception. Preserve completed history |

## Baseline architecture and conflicts

This section and the all-course impact table describe the **base-commit findings before repair**, not current worktree behavior. See “Implemented consolidation” for their disposition.

| Layer | Current contract / path | Implication |
| --- | --- | --- |
| Authority and compilation | `policy/manifest/econ-2025-2026.1.json`; `scripts/compile-policy.mjs` → `data/compiled/policy/`; `scripts/compile-catalog-policies.mjs` handles catalog/flexibility outputs; `lib/policy/load-bundle.js::loadPolicyBundle` checks the pinned hash; `lib/catalog/policy-releases.js` loads approved catalog/flexibility records | Any later rule belongs in canonical policy/provenance, then generated bundles. UI wording is not an independent rule source |
| Historical evidence | `policy/historical-offerings/economics.json`, its schema, compiler `validateCriticalConflicts`, `historicalOfferingByCourse`; `termSolver.js::historicalOfferingProjectionEvidence`; `economics.js::compareEconomicsPlans` | Empty, `INACTIVE_NO_APPROVED_DATA`, owner approval false. Approved active records can supply named projection evidence and ranking metadata. “VERY_LOW” requires ≥6 complete years and ≤1 year listed; other thresholds inactive |
| Patterns and flexibility | `policy/offering-patterns/economics.json`: `PLANNING-INTERMEDIATE-OFFERING-SEPARATION`, `CATALOG-ECO-222-SPRING`; `policy/rules/planning-flexibility.json#/futureScheduleProjection` and `#/supportingCoursePlacement`; `policy/provenance/sources.json`, `OWNER-PRELIMINARY-SCHEDULE-2026-09-22` | 213/214 pattern explicitly says universal same-term prohibition is false. Its TBC-only fallback and older `knowledge/course-offerings.md` wording need reading alongside the later provenance that supersedes TBC-only projections. Preliminary omissions do not block; `policy/schedules/preliminary.json` currently has no releases |
| Generation | `app/api/majors/map/route.js` → `lib/planning/economics.js::buildEconomicsTermPlans` → `termSolver.js::requirementDomains`, `projectedTermAllowed`, `solveEconomicsTermPlan`; `scheduleProvider.js` | Exact verified choices precede projections. Core future 213/214 choices use `projected-offering` and are separated by the search. Supporting-course generation uses Fall/Winter projections, including MAT 217; manual moves do not apply the same filter (see all-course audit). Named ECO 222 May evidence and generic elective alternatives coexist |
| Cards and moves | `app/page.js` course-card move `<select>` maps **all** `activePlan.terms`; `termSolver.js::applyEconomicsPlanEdit`; route `validateEditedEconomicsPlan` | Dropdown is not currently a legality filter. Server rebuilds destination evidence, validates original and edited plans, and checks the full result. A UI-only pattern filter would diverge from current acceptance |
| Validation and reports | `economics.js::validateGeneratedPlan`; `lib/decision-engine/placement.js` and `plan.js`; `lib/reports/build-economics.js` → `economics.js`/`economics-html.js`; `app/api/reports/economics/route.js`; `templates/econplannertemplate.html` | Reports revalidate selected plans and carry notices/historical messages. HTML feeds the PDF service. Any later approved semantics must agree through API, saved-plan edits, cards and reports, with independent Oracle verification |

**Observed generation/edit distinction:** with fictional sophomore input dated 2027-07-30 and completed ECO 113, ECO 114, MAT 113 and MAT 217, generation separated the intermediates. Moving ECO 213 into ECO 214’s Winter 2028 (Balanced) or Winter 2029 (Explore) returned HTTP 200 and `validation.valid=true`; both report builds succeeded. The moved course acquired `recurring-rule-unconfirmed` while its counterpart retained `projected-offering`. The generator’s separation check is conditional on source labels. These unpublished-year moves lack the verified-schedule evidence required by the owner’s instruction. The implementation below rejects these unsupported moves consistently across source labels and surfaces, while retaining same-term eligibility when that year’s verified schedule supports both courses and other validation passes. No universal prohibition or removal of the canonical exception is proposed.

**Exact schedule boundary and drift:** `policy/schedules/2026-2027.json` is active, with complete canonical term coverage and provenance limited to the documented ECO/supporting sections. Its exact MAT 217 May 2027 section overrides the normal May planning exclusion. `PLANNING-MAY-COURSE-EXCLUSIONS` also explicitly includes ECO 321 and permits an `ACTIVE_EXACT_SCHEDULE` override with a matching section: do not treat ECO 321’s May exclusion as absolute. Exact evidence controls only its documented year, term, courses and sections. Likewise, ECO 213/214 same-term placement requires support from that year’s verified schedule; an offering in another year, historical pattern or preliminary projection is insufficient. The existing ECO 213 Fall 2026 / ECO 214 Winter 2027 placements do not establish a permanent order.

The September extract is **not identical** to the active August-reviewed schedule: canonical May 2027 has ECO 260-S, absent from E; E/R have ECO 224-S and ECO 234-S (rows 14,16), absent from the canonical release. Canonical ECO 222-S agrees (row 13). Do not silently identify 260 with 224 or declare it cancelled. Four matched Fall section statuses differ: ECO 113-A and ECO 114-A/B are OPEN canonically but Full in E rows 2,5,6; MAT 217-A is FULL canonically but Open in M row 11. These are review candidates for a separately verified schedule refresh, not changed academic rules. Partial Fall data cannot replace complete meeting evidence, and neither old nor new seat states are promises. Full is distinct from closed. Preserve the active release until a scoped successor is approved; history must not override it.

## MAT 217: May evidence and planning scope

**Observation:** workbook M lists one MAT 217-S Spring/May section in each of 2022–23, 2023–24, 2024–25, 2025–26 and 2026–27 (`All Offerings!N120:T120`, `N95:T95`, `N70:T70`, `N43:T43`, `N17:T17`, respectively). Row dates confirm Spring/May, not Winter. The first four are completed academic years; the last is scheduled May 2027. Five listings do not prove five delivered courses or guaranteed future recurrence.

**Superseded authority and scope:** at the base commit, `PLANNING-MAY-COURSE-EXCLUSIONS` included MAT 217 and cited `ECONOMICS-OFFERINGS#May-Term`, a department-provided source imported in July. The August 1 rule was scoped to Economics unpublished projections, not a college-wide assertion that Mathematics cannot offer May courses. A second Fall/Winter-only list in `planning-flexibility.json#/supportingCoursePlacement` independently restricted generation. Moves and reports already accepted the tested future-May placement. Those conflicting lists were the defect.

**Verified term:** `policy/schedules/2026-2027.json` includes `2027-MAY-MAT-217-S`, May 3–28, 2027, sourced to `SCHEDULE-2026-2027-MATH-WINTER-MAY#MAT-217-S` and reviewed August 8. That exact section controlled May 2027 even under the former exclusion. It does not establish any later year's offering.

**Implemented resolution:** the September 26 owner instruction to correct the inconsistency is recorded in [dated provenance](../../policy/provenance/offering-policy-2026-09-26.md). MAT 217 is removed from the May exclusion; the supporting-course configuration references the single canonical term rule. Generation and moves can now use unpublished May as a labeled projection. This is a dated planning decision supported by the history, not automatic activation of a historical frequency rule. May capacity, conflicts and statistics-before-capstone timing still apply; May after the target Winter capstone is too late. No annual availability guarantee is made.

## Source lineage, all-course impact and consolidation

**Why the old document exists:** commit `a949629` (July 28, 2026) imported `Econ_Course_Offerings.md` with the first deterministic Hanover planner. That commit’s `scripts/ingest-economics-sources.mjs` copied local source files into `data/raw/economics/`; `data/manifests/source-manifest.json` labels this one `department-provided`. It was subsequently edited on July 29, August 1 and August 4 (`232f828`, `7b3f5c1`, `141bcc7`), so the base-commit file was not an untouched original external snapshot. Git establishes this lineage, not independent proof of authorship or fresh approval of every sentence.

Commit `175c286` (August 5) introduced the canonical hub and carried its ten-course May exclusion into `policy/rules/terms-load-graduation.json`. At the base commit, four structured policy entries directly cited `ECONOMICS-OFFERINGS`: that exclusion, `PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY`, `PLANNING-INTERMEDIATE-OFFERING-SEPARATION`, and `REQ-FINANCE`. Compatibility requirements and the source manifest retain additional lineage references. The old ingestion command is now retired with an explicit error directing maintenance to `policy/` (`scripts/ingest-economics-sources.mjs`; last changed in `2276b11`, August 9). Retaining source evidence is legitimate; retaining unsuperseded stale prescriptions as current authority is the defect. Deleting only that file would have left dangling provenance and unchanged descendants. This change instead replaces active references, records supersession, regenerates descendants, and then deletes it. Git retains the earlier versions.

**Competing copies found at baseline:** `knowledge/course-offerings.md` is a separate maintained-looking copy (last changed July 30, `956ae12`), adds MAT 113/121 to the May ban, says the intermediates are “never” together, asserts once-annually availability, and retains TBC-only projections. `knowledge/major-requirements.md` has overlapping course/requirement prose. No reader of these knowledge files was found in application, library or script code; they can still mislead people and future maintenance. `OWNER-PRELIMINARY-SCHEDULE-2026-09-22` already supersedes earlier TBC-only prose, and the intermediate pattern explicitly supersedes the legacy universal prohibition, but the copies do not clearly direct readers to those successors. The raw source also retains older accelerated-standing and staffing wording that must not override current approved scope. These are distinct from generated compatibility copies, which should be regenerated rather than independently maintained.

**Coverage and method:** the inventory below covers all 31 courses in `policy/courses/economics.json`, all 41 workbook identities in the observation table (52 distinct codes in their union), plus PHI 234’s canonical cross-list: **53 identities**. A second ECO 321 elective-allocation case gives **54 probe cases**. Each used fictional history, a generated baseline, a submitted course replacement for the appropriate requirement, then a May move if baseline validation passed. The target was May 2028 (senior May 2030 for ECO 461), with unpublished schedules. This deliberately exercises direct server submissions as well as the edit path; it does not claim all named choices are generated or exposed as selectable card alternatives. Generation entries were traced through `termSolver.js::requirementDomains` and `projectedTermAllowed`, the compiled supporting-course configuration, allocation rules and named-pattern indexes. The term filter was also evaluated read-only from its existing function text. “Generic elective” means generation has a generic future candidate rather than an approved named recurrence for that course; it is not an exclusion of that course.

**Result key:** **A** = baseline, May move, direct revalidation, selected-plan report and rendered HTML all succeeded; both Oracle checks accepted the resulting projection. **A†** = those application paths succeeded, but the complete Oracle retained prerequisite-history review already present in the baseline (missing earlier prerequisite records for completed advanced courses), rather than proving the whole plan valid. **M** = valid baseline, May move rejected; no accepted May report claimed. **B** = baseline requirement/permission rejection, so no May move was attempted. These are bounded implementation observations, not academic approval or promises of availability. At baseline, dropdowns enumerated all plan terms. These results are preserved as the defect inventory; post-repair browser and report checks appear below.

| Course | Baseline unpublished generation candidate | Baseline May edit / report | Course-specific consequence |
| --- | --- | --- | --- |
| BUSN 323 | F/W finance projection | A | May-list and supporting-configuration mismatch. Finance credit does not satisfy ECO 471’s specific ECO 321 prerequisite; BUSN recurrence is not established by these ECO/MAT workbooks. |
| ECO 113 | F/W core projection | A† | May-list mismatch; historical F/W pattern alone does not approve a new hard rule. “Many sections each term” overstates some observed Winters. |
| ECO 114 | F/W core projection | A† | Same May-list mismatch; retain introductory prerequisite relationships. |
| ECO 160 | Generic elective | A | 100-level elective limit applies; history is not a promised named future offering. |
| ECO 161 | Generic elective | A | 100-level elective limit applies; completed credit/introductory prerequisite alternatives remain distinct from core requirement credit. |
| ECO 213 | F/W core projection; normally separated | M | May rejected. Unpublished same-term pairing with 214 is nevertheless accepted in the earlier probe, contrary to the owner’s scoped instruction. |
| ECO 214 | F/W core projection; normally separated | M | May rejected; same-term separation must apply to both move directions and source labels, with the verified same-year exception retained. |
| ECO 221 | Generic elective | A | ECO 113 prerequisite; no independent future term ban found. |
| ECO 222 | Named May projection or generic elective | A | Only named elective projection pattern currently approved. Exact May 2027 section exists; no annual guarantee. |
| ECO 223 | Generic elective | A | No extract listing; accepted projection is not evidence of an actual offering or cancellation. |
| ECO 224 | Generic elective | A | Workbook May 2027 listing is absent from the active release; scoped schedule refresh remains separate. |
| ECO 234 | Generic elective | A | PHI 234 cross-list counts once. Workbook May 2027 listing is absent from the active release. |
| ECO 257 | F/W statistics projection | A | May-list mismatch. Generator can name 257 despite old “do not suggest by itself” prose and the separately attributed current staffing statement; preserve completed statistics credit, never treat it as an elective. |
| ECO 260 | Generic elective | A | Canonical exact May 2027 section exists; absent from the new extract. Preserve special-topics elective eligibility; do not silently equate it to ECO 224. |
| ECO 307 | Not an eligible full-course elective | B | Baseline rejected for elective allocation; not a May rejection. The old summary’s “confirm whether it counts” does not override canonical exclusion/half-unit identity. |
| ECO 315 | Generic elective | A | No extract listing; maintain prerequisites and uncertainty without a history-based exclusion. |
| ECO 316 | Generic elective | A | No extract listing; maintain prerequisites and uncertainty without a history-based exclusion. |
| ECO 321 | F/W finance projection; generic elective otherwise | A | Both finance and elective May moves passed. This conflicts with the owner’s unpublished-May exclusion. Retain exact-schedule override, BUSN-finance allocation condition for elective use, and no annual availability guarantee. |
| ECO 331 | Generic elective | A | ECO 213 prerequisite retained; catalog offering claims intentionally excluded from this review. No approved term-specific offering pattern found. |
| ECO 333 | Generic elective | A | ECO 114 prerequisite; no instructor attribution or return prediction inferred. |
| ECO 335 | Generic elective | A | Probe supplied ECO 213, ECO 257 and MAT 121. ECO 257 staffing uncertainty can affect prospective prerequisite planning here; MAT/PSY statistics alternatives for the major do not silently replace the specifically recorded ECO 257 prerequisite. Preserve completed credit and review equivalents. |
| ECO 337 | Generic elective | A | Introductory prerequisite alternative retained; no instructor attribution or return prediction inferred. |
| ECO 357 | Generic elective; permission needed for a named course | B | Baseline rejected for missing department permission, not May. Do not fabricate permission to obtain a passing probe. |
| ECO 360 | Generic elective | A | No extract listing; retain special-topics identity questions and generic future flexibility. |
| ECO 370 | Generic elective | A | No extract listing; do not infer a recurring directed-study offering. |
| ECO 461 | Senior Winter only | M | May rejected by separate capstone checks. Residency, statistics-before-capstone and current accelerated-standing policy remain; superseded confirmation prose must not return through the raw/knowledge copies. |
| ECO 471 | Generic elective; no approved named pattern | A | Manually submitted May 2028 placement was accepted with ECO 213/214/321 completed. Canonical compatibility marks 471 `excluded_from_automatic_plans`; this probe did not demonstrate automatic generation. Retired knowledge-only senior-year/request wording creates no new gate. Retain canonical prerequisites; BUSN 323 does not replace the specific ECO 321 prerequisite. |
| ECO 499 | No canonical named candidate; generic elective only | A | Outside the canonical Economics course registry but accepted as a named projected elective through broad ECO eligibility. Course identity/eligibility require review; technical acceptance does not establish academic approval. |
| MAT 113 | F/W cognate projection | A† | Not in canonical ten-course May list, but added to the knowledge copy’s list and restricted by supporting-course configuration. May move accepted; preserve prerequisite/cognate meaning. |
| MAT 121 | F/W cognate projection | A† | Same configuration/knowledge mismatch as MAT 113. Also material to ECO 335’s recorded math prerequisite. |
| MAT 217 | F/W statistics projection | A | May move accepted; five Spring/May listings and exact May 2027 section support the proposed future-May policy correction, not automatic activation. |
| PHI 234 | ECO 234 cross-list; generic elective | A | Accepted as the canonical cross-list identity; one credit allocation, not two separate electives. |
| PSY 217 | F/W statistics projection | A | May-list/configuration mismatch. Its statistics/capstone pathway remains valid; no PSY offering workbook was supplied, so do not infer a recurring term. |
| MAT 101, MAT 122, MAT 160, MAT 212, MAT 220, MAT 221, MAT 224, MAT 243, MAT 260, MAT 311, MAT 324, MAT 327, MAT 337, MAT 339, MAT 343, MAT 357, MAT 370, MAT 461, MAT 496, MAT 499 | Outside Economics requirement options | B | All 20 were rejected as Economics electives. These are workbook observations, not Economics offering-rule subjects; absence from this planner’s options does not mean they are unavailable to students. No Mathematics-major behavior was assessed. |

**Baseline cross-course findings:** generation excludes May for all ten courses in `PLANNING-MAY-COURSE-EXCLUSIONS`, but seven were accepted there by the move path: ECO 113, ECO 114, ECO 257, ECO 321, BUSN 323, MAT 217 and PSY 217. MAT 113/121 show the same generation/edit split through the separate supporting-course list. ECO 213/214 are rejected by `evaluateCoursePlacement`’s explicit May check; ECO 461 has independent Winter/standing/prerequisite checks. Those special checks do not implement the whole exclusion list. The ECO 321 test passed in both finance and elective roles, so allocation choice does not repair its May gap. Other eligible elective projections are permitted by existing future flexibility; their lack of a named generation pattern is not itself a defect.

**Baseline exact-schedule and independent-check findings:** the active May 2027 release contains precisely ECO 222-S, ECO 260-S and MAT 217-S within its documented scope (`policy/schedules/2026-2027.json#/terms`, `2027-MAY`). The separate MAT 217 exact-section probe passed moves, revalidation, reports and both Oracle checks. Do not extend that evidence to another term/course, and do not use these extracts to replace the active release silently. The unconditional intermediate-May check precedes schedule evaluation; any future verified exception needs a targeted check, not an assumption that all consumers honor the general rule’s exact-schedule override. Independent Oracle acceptance also has gaps: both Oracle paths accepted counterfactual intermediate-May placements that production rejected; the canonical offering audit accepted the counterfactual capstone-May placement while the complete Oracle rejected it. These checks must be reconciled against approved canonical meaning, never simply against each other. The four A† results are baseline historical-review cases, not evidence of a May violation. The implementation below corrects these offering checks independently from canonical meaning.

## Implemented consolidation

[The canonical policy hub](../../policy/README.md) now identifies the maintained location for each fact. The retired raw offering document is deleted; three knowledge summaries point to the hub. The dated owner record supplies replacement authority and precise supersession. Finance keeps its official catalog authority; older compiled releases and Git history remain historical records, not alternate live rules.

| Change | Maintained definition and affected outcome |
| --- | --- |
| One May projection list | `policy/rules/terms-load-graduation.json#PLANNING-MAY-COURSE-EXCLUSIONS`: remove MAT 217; retain ECO 113/114/213/214/257/321, BUSN 323, PSY 217 and ECO 461; consolidate MAT 113/121’s existing supporting-course restriction here. Supporting flexibility references this rule rather than another allowed-term list. Matching verified sections override projection exclusions; independent capstone Winter/standing/residency rules still apply. |
| Intermediate separation | `policy/offering-patterns/economics.json#PLANNING-INTERMEDIATE-OFFERING-SEPARATION`: separate terms for unpublished schedules, regardless of source labels. Same-term eligibility requires both courses in that year/term’s verified schedule. `universalSameTermProhibition:false` is preserved. Obsolete TBC-only wording is replaced with labeled term workload projections. Year-only assignments account for the counterpart, including an already fixed term. |
| One production term decision | `lib/decision-engine/placement.js::courseTermEligibility` supplies generation/search, year-only assignment, move eligibility and saved-plan validation. The dormant greedy implementation also delegates. `termSolver.js::annotateEconomicsMoveDestinations` supplies card options; the API refreshes them after edits. Capacity, prerequisite and other full-plan checks still run on submission, so an offered dropdown destination is not a promise that every move will pass. |
| Reports and independent checks | Reports revalidate through the same production plan path; no independent report policy is added. Both Oracle implementations are corrected separately against canonical meaning, without importing the production predicate. Regression cases cover the whole eleven-course May list, scoped exact exceptions, intermediate source labels, forged submissions and report rejection. |
| Compilation and provenance | Existing compilers regenerate the base bundle and compatibility mirrors; flexibility advances to `econ-planning-flexibility.6`. No compiled data is hand-edited. Prior flexibility releases remain unchanged. The deleted source is absent from active provenance, manifests and generated outputs. |

No requirement, prerequisite, completed credit, course identity, schedule section or six-complete-year historical threshold changed. ECO 257 staffing remains attributed advice, not a new cancellation/exclusion rule. ECO 499 identity remains unresolved: the baseline broad-ECO elective acceptance does not establish academic approval. ECO 471 automatic exclusion and specific prerequisites remain canonical; no senior-year restriction is invented from retired prose.

## Decisions on the proposals and wording examples

| Proposal | Assessment |
| --- | --- |
| Short card labels such as “Normally Fall and Winter” | **Agree conditionally** for ECO 113/114 and MAT 113/121, with a historical/projection qualifier and access to period/coverage. **Disagree** for 213/214 individually if it implies twice annually; use “Normally separate terms; verify the year’s schedule.” ECO 321 should say “Fall or Winter when offered,” with its May exact-schedule exception in the note. MAT 217 needs May acknowledged |
| Detailed advisor notes | **Agree.** State observation years, exceptions, partial coverage and staffing attribution separately. Do not call historical ratios future probabilities or claim a section was taught |
| Approved patterns in generation, moves, server validation and reports | **Agree on shared evidence and consistent explanations; disagree with converting historical patterns into universal exclusions.** Apply the owner’s separate-term instruction to unpublished ECO 213/214 projections, but retain the verified same-year same-term exception. Preserve ECO 321’s May exact-schedule override. Other future flexibility and all prerequisite, capacity, standing and enrollment checks remain applicable |
| Omit a destination containing the other intermediate course | **Agree for unpublished schedules or when that year’s verified schedule does not support both courses in that term.** Do not omit it solely because the counterpart is there when the verified schedule supports both; apply all other move checks. Enforce this evidence-dependent rule across cards, generation, server validation and reports. A shared year-only TBC placeholder requires distinct-term placement unless the verified same-year exception applies |
| History-based restrictions on rare/unlisted courses | **Disagree.** The supplied period cannot meet the six-complete-year threshold, and even that classification is ranking/information, not a hard exclusion |

Draft language for owner review, not live labels:

| Course(s) | Card example | Advisor-note example |
| --- | --- | --- |
| ECO 113/114; MAT 113/121 | “Normally Fall and Winter · historical pattern” | “Listed in both terms in each of 2022–23 through 2025–26. Future schedules and seats must be checked.” |
| ECO 213/214 | “Normally separate terms · verify the year’s schedule” | “No same-term listings in the four completed years 2022–23 through 2025–26; the 2026–27 listings continue that pattern. For unpublished future schedules, plan ECO 213 and ECO 214 in separate terms. Same-term placement is allowed only when that year’s verified schedule supports both courses in that term and other requirements are satisfied.” |
| ECO 222 | “Spring/May when offered” | “Listed in May 2023 and scheduled May 2027; absent from the three intervening completed-year extracts. Catalog term guidance does not promise annual availability.” |
| ECO 224 / ECO 234 | “Spring/May observed” / “Spring/May; Fall also observed” | “224 appears in May 2024 and 2026, with May 2027 scheduled. 234 appears each May, with Fall added in 2025–26. Confirm the target year's schedule.” |
| ECO 321 | “Fall or Winter when offered” | “ECO 321 appears once in each observed year in which it is listed, with a 2023–24 gap; this does not guarantee annual availability. For unpublished schedules, plan it in Fall or Winter, not May. A matching section in that year’s verified exact schedule can override the May planning exclusion.” |
| ECO 257 | “Future availability: ask advisor” | “The department reports current staffing is unavailable. Do not depend on a new ECO 257 offering without confirmation; consider the approved statistics alternatives. Completed ECO 257 credit remains eligible under existing policy.” |
| ECO 461 | “Winter · senior capstone” | “One Winter listing per completed year. Apply the existing senior-standing, Hanover-residency and prerequisite rules; confirm the future schedule.” |
| MAT 217 | “Fall, Winter and Spring/May observed” | “Spring/May listings appear in all five reviewed years: four completed years and scheduled 2026–27. May 2027 has a verified section. Unpublished May placements are now eligible as planning projections; check the target year’s schedule. Recurring May listings are not a guarantee.” |

For the ECO 213/214 course-card dropdown, omit a term containing the counterpart unless that academic year’s verified schedule supports both courses in that term. Apply this in both move directions. For an unpublished year, explain: “ECO 214 is already in Winter 2028. Plan ECO 213 in a different term unless the verified 2027–28 schedule supports both there.” When verified same-year evidence supports both, the destination remains eligible subject to all other move checks. Preliminary or historical evidence alone cannot establish the exception. Cards, generation, server validation and reports must use the same scope. Year-only placeholders are not actual terms; retain a feasible distinct-term assignment unless the verified exception applies. ECO 321’s dropdown should likewise exclude projected May placement while allowing a matching verified May section to override that planning exclusion.

## Review decision and remaining evidence

1. **Ready for owner review:** the implemented consolidation and scoped behavior fixes above, plus the evidence tables and proposed plain-language labels. The labels remain draft examples; this change does not activate history-based cards, ranking or forecasts.
2. **Needs separate evidence:** verify the September schedule discrepancies before publishing a scoped successor; confirm ECO 499 identity, ECO 335 equivalencies and dated staffing horizons. Keep ECO 331 catalog offering claims excluded. ECO 257’s future staffing advice needs a confirmation date, scope and review date; completed credit stays eligible.
3. **Historical activation remains separate:** four completed years cannot establish the current ≥6-complete-year/≤1-listed-year `VERY_LOW` classification. At least two further complete years and resolution of the contract’s coverage definition are needed. Six years is a classification threshold, not a blanket prohibition on storing descriptive records; properly approved four-year records would be `NEUTRAL`. Collection and individual records both need approval, identity, dates, coverage, method and provenance. Do not lower thresholds or infer probabilities. The history record remains empty and inactive.
4. **Preserve:** exact-schedule scope and overrides, other unpublished elective flexibility, course/credit identities, completed history, prerequisites, May capacity, finance/statistics allocation and capstone requirements. Staffing concerns and financial forecasts do not establish permanent cancellation or infeasibility.

## Checks and results

- Workbook verification: all three inputs read directly, 41 course rows / 205 course-year cells recalculated; section and observation totals reconcile; file hashes unchanged. No workbook copied into source control.
- Baseline dependency audit: 54 cases / 53 identities, 32 valid baselines, 29 accepted May moves and three rejected May moves. All 29 accepted moves also passed revalidation and report/HTML preservation; 25 passed both Oracle checks and four retained prerequisite-history review. Twenty-two other cases stopped at requirement/permission rejection. The table above records this baseline, not post-repair permissions.
- Policy/source checks: `node scripts/compile-policy.mjs` and `node scripts/compile-catalog-policies.mjs` pass; source-to-bundle parity and independent academic checks pass. The obsolete source has no active dependency. A regression checks that supporting projections reference the sole May list and that the deleted source cannot silently return.
- Implementation verification: `node --test`: **576 passed, one existing skip, zero failures**. Playwright `course-moves.spec.js` against the final production build: **10 passed**. Browser cases exercise future MAT 217 May move/persistence, both intermediate dropdown directions, exact May 2027 moves, rejected edits, undo, reload, accessibility feedback and report consistency. Synthetic exact-schedule fixtures test exceptions without altering real schedule evidence.
- `node scripts/verify-economics-pdf.mjs --dry-run`: five local profiles pass text parity and invalid-plan rejection; hosted service is not called. `next build --webpack` passes. `eslint .` has zero errors and one pre-existing unused-variable warning in `scripts/normalize-hanover-catalog.mjs:125`.
- Reviewed the diff for invented authority, unqualified historical claims, identity/instructor inference, conflicting duplicate rules and lost exact-schedule exceptions. Historical tables remain unchanged. The owner authorized commit, push and PR publication after this review. No merge or deployment is included; the original checkout is preserved.

Verification used the already-installed local binaries because pnpm attempted dependency reinstallation on the shared worktree symlink. No dependency files were changed. The full test run includes the ten new offering-consistency regressions.

The pull-request deterministic workflow explicitly includes `tests/offering-policy-consistency.test.js`; the browser workflow already includes `tests/e2e/course-moves.spec.js`.
