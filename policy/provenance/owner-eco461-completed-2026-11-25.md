# Owner decision: seniors may mark ECO 461 completed — November 25, 2026

Authority: project owner and Economics Department domain expert, explicit instruction in the clean-up session dated 2026-11-25. Effective from 2026-11-25 with no end date.

## Decision

ECO 461 must be taken at Hanover College, so the course form showed no status buttons for it. A student who already passed it (for example a fifth-year senior) could not say so and was scheduled for it again.

- Students whose class standing is senior get one button for ECO 461: **Completed**. There is no "Taking now" and no transfer or AP option. Other standings keep the note "Must be taken at Hanover College".
- Changing the standing away from senior removes the ECO 461 completion.
- When ECO 461 is marked completed, the plan adds an advisor-check note. Student: "You marked ECO 461 as completed. Your advisor will confirm it." Advisor: "Confirm the student completed ECO 461 at Hanover College."

The senior-only gate follows the existing rule that ECO 461 requires senior standing. Implemented in `app/page.js` (`canMarkHanoverOnlyCompleted`) and `lib/planning/plan-presentation.js`.
