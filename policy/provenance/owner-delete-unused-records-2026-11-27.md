# Owner decision: delete records nothing uses — November 27, 2026

Authority: project owner, explicit approval ("Go") of the clean-up outline in the session dated 2026-11-27. Effective from 2026-11-27 with no end date. No change to plans or student text.

Deleted: tests/panel/reviews/ (the November 22 review notes), docs/architecture/, docs/approved-portrait-verification.md, docs/canonical-consumption-repairs-2026-09-27.md, docs/production-restoration-symbol-repair.md, and tests/e2e/econ-planner-visual.spec.js (not on the CI list; its checks repeat other browser specs apart from two display details). Kept: docs/testing.md and docs/student-facing-language.md. Git history keeps every deleted file.

Before deleting, the four undecided owner questions N5 to N8, whose full wording existed only in the review notes, are written out below (owner-decisions-2026-11-22b.md names them only by label; that file is a hashed policy source, so it was left unchanged). Every other rule or decision in the deleted files was already recorded in policy/.

Undecided items N5 to N8, as written in the November 22 accuracy review (still undecided; see owner-decisions-2026-11-22b.md#Unresolved-items-retained):

- N5: Should an optional finance petition note (student 25) also trigger the "paperwork to file" line?
- N6: When reserved room causes the failure (students 29, 50), which explanation comes first: the reserved-room reason or OD4's courses-versus-capacity reason?
- N7: BUSN 323's title differs between policy files: "Investments" in `policy/courses/economics.json` and the verified 2026-2027 schedule, "Business Finance" in `policy/catalogs/economics-2025-2026.json`, for which the review found no raw source. Should the catalog record be corrected?
- N8: Is a same-term chain acceptable (student 32: MAT 113, ECO 214 and ECO 461 all in Winter 2027), where ECO 214's math prerequisite is met only through another same-term arrangement? Rule `CONCURRENT-INTERMEDIATE-ECO-461` requires the same-term intermediate course's own prerequisites to be met, and the student's completed ECO 213 was itself under review for missing math.
