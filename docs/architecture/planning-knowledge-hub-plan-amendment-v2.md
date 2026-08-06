# Planning Knowledge Hub Migration Plan — Amendment v2.0

Status: approved architecture record for CP4b and future CP5–CP8 checkpoints. This amendment is additive. It does not rewrite or reinterpret CP0–CP4 history.

## Purpose and checkpoint sequence

The approved migration remains centered on one compiled policy bundle, a Production Decision Engine, and an independently maintained Oracle. The amended checkpoint sequence is:

1. **CP4b-A** — preserve alternative requirement allocations; add authoritative TBC temporal semantics, readiness/advisor-action dispositions, explicit evidence facts, and catalog-applicability analysis.
2. **CP4b-B** — ingest and validate historical catalog releases, compare catalog applicability, and activate only owner-approved bundles.
3. **CP5A** — run the new joint allocation/placement search in shadow-comparison mode and produce a profile-level gain/loss ledger.
4. **CP5B** — make the new planner authoritative only after owner approval of gains, losses, RED safety, Oracle agreement, strategy behavior, and performance.

CP4b-A must not implement historical catalog ingestion, the CP5 portfolio search, activation, snapshots/editing, report/PDF replanning, UI consolidation, or legacy retirement.

## Completion, evidence, and readiness are separate

Completion status and evidence status remain authoritative fields. Readiness is a separate product-facing classification.

### `STUDENT_READY`

A plan is complete, academically valid, supported by sufficient authoritative evidence, free of unresolved policy/equivalency/waiver/substitution/advisor-review decisions, and not dependent on unresolved approval.

### `READY_WITH_CONDITIONS`

A plan is complete, academically feasible, and usable by the student, but depends only on structured and visible conditions such as unpublished future-offering confirmation, a TBC placement window, waitlist outcome, documented department or instructor approval, or preliminary future-schedule evidence.

### `ADVISOR_ACTION_REQUIRED`

A complete feasible pathway exists, but an advisor or other authorized decision-maker must resolve a waiver, substitution, equivalency, catalog-applicability question, historical prerequisite evidence, unidentified authority, or another review-only policy question.

Such a plan remains a complete incumbent and should be displayed when useful. It must retain `approvedForAuthority: false`, remain visibly review-dependent, identify the exact advisor action, and never be described as approved, final, verified, or student-ready.

### `NOT_READY`

A plan is partial, blocked, proven infeasible, or search-incomplete without a complete incumbent. Truncated search is not proof of infeasibility.

## Primary product metric

The primary future metric is:

> Profiles receiving at least one `STUDENT_READY` or `READY_WITH_CONDITIONS` plan.

`ADVISOR_ACTION_REQUIRED` profiles are reported separately. Also report every complete plan, evidence status, approval status, advisor-action status, and no-plan classification.

## Corrected CP4 control baseline

The corrected CP4 control is:

- 368 frozen fictional profiles;
- 186 profiles with a displayed complete plan;
- 439 displayed plans;
- 193 `PRELIMINARY` plans;
- 246 `REVIEW_REQUIRED` plans;
- zero unexpected Production Decision Engine disagreements;
- zero unexpected Independent Oracle disagreements;
- 44 node-limit profiles.

These are comparison values, not immutable outputs. An intentional CP4b change may alter them only when it follows an approved rule or evidence correction, every affected profile is present in machine-readable and human-readable ledgers, and no previously complete profile loses all complete incumbents without an explicit RED finding and owner approval.

Each ledger row must retain profile ID, plan signature, old and new completion/evidence/readiness status, allocation ID, controlling rules, sources, exact reason, and a classification of intended, review-only, regression, coverage gain, duplicate convergence, or evidence correction.

## CP4b-A contracts

### Alternative requirement allocations

Strict, optimistic, and projected mapping scenarios expose `allocationAlternatives` and `allocationSearch`. The compatibility `assignments` and `unresolved` fields remain the rank-one projection.

The assignment layer must retain every materially different hard-valid maximal allocation within the returned page. Preference scores may order alternatives but may not eliminate academically valid alternatives. Alternatives are canonical, deduplicated, stable under input permutation, deterministically paged, and resumable. The default and maximum page size is 64. `EXHAUSTED` means all alternatives were returned; `ALTERNATIVE_LIMIT` means another page may exist. A page limit never implies infeasibility.

Each `allocationId` incorporates the governing policy release, exact course-to-requirement assignments, unresolved/review states, and catalog-applicability context. This supplies CP5 with allocation candidates without implementing CP5 search or converting preference into academic validity.

### Authoritative TBC temporal semantics

Every TBC placement carries an academic-year placement window, allowed canonical terms, earliest/latest ordinals, and source rule IDs. Prerequisite relationships are explicit `STRICT_PRIOR` or `CONCURRENT_WITH_APPROVAL` edges. Concurrency is legal only when a canonical permission rule, required approval evidence, governing authority, and rule ID are retained.

The Decision Engine produces a deterministic topological witness that fits placement windows, prerequisite edges, authoritative term-load and reserved-capacity limits, known course restrictions, and the graduation horizon. Impossible ordering is `BLOCK`. Feasible unpublished ordering remains `PRELIMINARY` and TBC. An exact active schedule overrides a TBC window for covered terms. Future offerings are never invented.

`projectedTerm` and `planningSequence` remain compatibility/display fields only; they do not determine authoritative validity.

### Readiness and advisor action

Decision results add `readinessStatus`, `planDisposition`, `advisorActionRequired`, `advisorActions`, and structured conditions. Advisor actions have stable IDs and reason codes, controlling rule IDs, sources, responsible authority, required evidence, affected course/requirement/allocation/catalog decision, and current disposition. Duplicate actions are canonically deduplicated. Review-only findings never silently become allow, block, or verified evidence.

### Explicit evidence facts

Evidence facts support completed, in-progress, and transfer coursework; course and requirement-credit equivalency; prerequisite-satisfaction evidence; advisor review; department/instructor approval; waiver; and substitution. Every fact identifies its type, affected course or requirement, source, authority, evidence status, effective scope, and applicable term/catalog when relevant.

Requirement-credit evidence does not automatically satisfy a prerequisite. Prerequisite-satisfaction evidence does not automatically grant requirement credit. A broad regular expression or source-name fallback produces only a traceable `REVIEW_REQUIRED`; it never verifies, blocks, satisfies a prerequisite, or assigns requirement credit. Missing historical prerequisites produce review rather than deletion or invention. Completed and transfer advanced-course history remains preserved.

ECO 257 remains Statistics-only and cannot be an Economics elective or receive an advisor elective override. `FULL` remains `REVIEW_REQUIRED`; `CLOSED` remains blocked. No approved academic rule is weakened.

### Catalog applicability analysis

CP4b-A analyzes but does not ingest or activate historical catalog releases. The contract distinguishes `EXACT`, `AMBIGUOUS`, and `UNAVAILABLE`, retaining governing and candidate years, evaluated years, basis, sources, and an advisor action.

A supplied declaration year resolves exactly only when its authoritative release exists. Missing declaration year never silently makes entry year authoritative. Candidate years and missing sources remain explicit; a materially different unresolved outcome makes the plan advisor-action-required. CP4b-A must not invent a 2026–2027 release.

CP4b-B should validate only authoritative candidate releases, compare material outcomes, and activate a deterministic bundle only after owner approval. CP8 should add `majorDeclarationCatalogYear` with an explicit `I do not know` option; CP4b-A does not perform that UI redesign.

## Future CP5 objective and success rule

Remove fixed requirements for `+19 profiles`, `205/368`, or five percentage points. The objective is:

> Maximize student-ready and ready-with-conditions coverage while preserving zero new RED failures, zero unexpected or unclassified Oracle disagreements, meaningful strategy conformity, complete-incumbent preservation, and acceptable measured performance.

CP5 is a coverage success only when ready coverage increases, or bounded/exhaustive evidence shows that no additional tested eligible profile can be rescued under approved rules, available evidence, and fully reported search limits. Zero improvement must not be described as achieving the primary product goal.

## Future validation populations

CP5 must separately report:

1. the frozen 368-profile regression cohort;
2. a held-out generated cohort using previously unused fixed seeds;
3. a hand-authored edge-case cohort;
4. transfer students;
5. review-dependent students;
6. previous node-limit profiles;
7. previous search-incomplete profiles;
8. profiles with multiple valid requirement allocations;
9. students eligible for One Year Early/C-2.

## CP5A shadow comparison and CP5B activation

CP5A runs old and new planners side by side and creates a profile-level gain/loss ledger. CP5B activation occurs only after owner approval of the ledger, RED safety, Oracle agreement, strategy behavior, and performance. CP4b-A does not introduce CP5 search/ranking modules or activation behavior.

## Future C-2 handling

C-2 has a different graduation horizon and therefore a separate candidate pool. CP5 must retain a pinned complete C-2 incumbent, a C-2 elite set, an explicit C-2 ranking tuple, an eligible-profile denominator, and the number and percentage of eligible students receiving a complete C-2 plan. C-2 regression must not be hidden inside A/B/C metrics.

## Future search budgets and conclusions

CP5 must define one global per-profile node budget, one wall-clock budget, a first-ready-plan budget, and a separate alternatives/diversity budget. Scheduling across requirement allocations, catalog interpretations, search orderings, and approval modes must be fair, deterministic, and round-robin.

Search conclusions include `ALLOCATION_SEARCH_INCOMPLETE`, `PORTFOLIO_SEARCH_INCOMPLETE`, `COMPLETE_BOUNDED`, and `NO_PLAN_EXHAUSTIVE`. A truncated search never becomes proven infeasibility, and a complete incumbent must be preserved when alternatives work reaches a limit.

## Future performance acceptance

CP5 is not required to keep p50 latency absolutely no higher than CP4 in every condition. It must measure time to first ready plan, profile p50/p95/maximum, timeouts, nodes, allocations searched, search-order contribution, cache activity, and coverage gained per unit of added cost.

A modest latency increase may be accepted only when it produces verified additional ready plans, remains within an explicitly approved user-facing limit, causes no timeout or incumbent loss, and keeps p95/maximum acceptable.

## CP6–CP8 propagation

CP6 must preserve the readiness category, governing/candidate catalog years, allocation ID, TBC windows, prerequisite witness, advisor actions, plan disposition, applicable policy release, review findings, and sources through the validated snapshot, plan token, edit commands, and move-destination decisions.

CP7 must preserve the same fields through the report model, JSON, HTML, PDF, and exact-plan revalidation. CP8 must preserve them through student intake, readiness labels, catalog-year input, advisor-action explanations, and condition messages.

## Acceptance boundary

CP4b-A passes only with zero new RED failures, zero unexpected/unclassified Production Decision Engine or Oracle disagreements, no complete-incumbent loss, deterministic/resumable allocation alternatives, sound deterministic TBC witnesses, traceable review findings, preserved advanced history, intact edit locking and failed-edit behavior, intact TBC parsing/accessibility/report/PDF fixtures, green lint/build, complete ledgers, no invented/activated catalog release, and no early CP5 behavior.
