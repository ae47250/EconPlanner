# Owner decision: Course History prerequisite wording and the both-Taking-now warning — November 25, 2026

Authority: project owner and Economics Department domain expert, explicit instruction in the clean-up session dated 2026-11-25. Effective from 2026-11-25 with no end date.

## Decision

Student-facing wording and display only. Planner placement, credit and which courses are allowed are unchanged.

1. One message per course, naming every unmet prerequisite: “ECO 461 is marked completed, but ECO 213, ECO 214 and a statistics course are not marked. Mark them, or your advisor will check.” A prerequisite’s own prerequisites are not listed.
2. Course Completed, prerequisite Taking now: “ECO 213 is marked completed, but ECO 113 is marked Taking now. Fix one of them, or your advisor will check.” The earlier “retaking” sentence is removed.
3. Course Taking now, prerequisite not marked: “ECO 213 needs ECO 113 first. Mark it Completed or Taking now, or your advisor will check.”
4. The statistics choice (ECO 257, MAT 217, PSY 217) is named “a statistics course”.
5. The “Choose a prerequisite option” panel shows when the course is Taking now, as it does when it is Completed.
6. New warning: when a course and its prerequisite are both marked Taking now: “ECO 113 comes before ECO 213, but both are marked Taking now. Check both. If that’s right, your advisor will confirm.” Display only: the course stays in the plan and plan generation is not blocked.

## Boundary and adjustments made while applying the decision

- Item 6 exception: the owner named MAT 113/121 with ECO 213/214. The same exception is applied to every same-term pairing that policy already allows with instructor approval (`permissionException` rules with `allowConcurrency`, in `policy/rules/permissions-exceptions.json`). That also covers ECO 213 or ECO 214 with ECO 461 (owner decision of 2026-11-24: ECO 461 instructor approval), so an approved pairing never also gets a “check both” warning.
- Plurals: “is not marked. Mark it” for one item, “are not marked. Mark them” for several. A course choice inside a longer list reads “either MAT 113 or MAT 121”.
- Mixed case: when a Completed course has one prerequisite not marked and another marked Taking now, both owner sentences appear in the same message.

## Where

Messages: `policy/messages/en-US.json` (`history.completedMissing*`, `history.completedPrerequisiteTakingNow*`, `history.takingNowNeeds*`, `history.bothTakingNow*`). Selection: `historicalPrerequisiteCourseMessage` in `lib/planning/historical-prerequisites.js`, used by the Course History screen (`app/page.js`) and by plan notes and the PDF (`lib/planning/plan-presentation.js`).
