# Owner decision: one offering label for each course on the screen and in the PDF — November 27, 2026

Authority: project owner, explicit choice ("a": the same short label on both, decided by one shared rule) and approval ("Go") of the reviewed plan in the clean-up session dated 2026-11-27, after a live-app test found the screen saying "Future offering unconfirmed" while the PDF said "Previously offered in Fall and Winter". Effective from 2026-11-27 with no end date. Wording and display only: which courses are allowed, placed or counted is unchanged.

| Situation | Before | After |
|---|---|---|
| Course offering history on the screen | Not shown | A list under each plan: "ECO 214: Previously offered in Fall and Winter." (the PDF already listed this under its table) |
| Elective placeholder | Screen: "Future offering unconfirmed" in every elective cell. PDF: nothing | "Future offering unconfirmed." once in the list, on the screen and in the PDF |
| A course the student is taking now | PDF showed its offering history (except ECO 461) | No offering label on either (put to the owner with this PR; merging it approves it). Needed so both lists match: the screen adds taking-now courses from the student's answers, without history |
| ECO 461 | Screen: cell note "Offered only in Winter…". PDF list: "ECO 461 is offered only in Winter." | Label "Offered only in Winter." on both: screen list "ECO 461: Offered only in Winter.", PDF list "ECO 461 — Senior Capstone … Offered only in Winter." The screen's cell note is unchanged |

One rule decides the label (`courseOfferingInformation` in lib/planning/plan-notes.js) and one helper builds the list on both (`courseOfferingLines` in lib/planning/plan-display.js). Existing wording only; no new academic claim.

Not changed: seat-availability badges (the per-course badge is the only seat warning for some courses).
