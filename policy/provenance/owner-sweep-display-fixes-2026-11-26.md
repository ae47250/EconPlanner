# Owner decision: final-sweep display fixes — November 26, 2026

Authority: project owner and Economics Department domain expert, explicit instruction ("go") in the clean-up session dated 2026-11-26, on the verified findings of the final screen/PDF sweep and his report that the PDF indent and checklist note were not fixed. Effective from 2026-11-26 with no end date. Display and wording only: which courses are planned is unchanged.

| Situation | Before | After |
|---|---|---|
| Plan that meets the current rules but needs a catalog petition (panel 13, 23, 24, 27, 36, 39, 44) | "Ready to plan. The plan meets the major rules." next to a petition note | "Needs confirmation", explained as "Your catalog needs a petition for this plan. See the notes below for paperwork to file." Screen and PDF use one shared status rule (`planReadinessLabel` in lib/planning/plan-display.js) |
| Class standing when no one-year-early plan is offered (panel 09–12; also "more information needed" cases) | PDF: "Junior (graduating one year early)"; the screen used a different test | "Junior" on both, from one shared rule (`oneYearEarlyPlanOffered` in lib/planning/plan-display.js) |
| "Approval needed" tags (panel 10, 11, 19, 21, 32) | The screen grid tagged fewer courses than the PDF grid and the checklist; ECO 213 taken now with MAT 121 was tagged only in the checklist | Shared rules (`courseNeedsApproval`, `takingNowWithMathNeedsApproval` in lib/planning/student-language.js) for the screen grid, the PDF grid and the checklist. For the taken-now pairing, the ECO course is tagged (the approval is that instructor's) |
| ECO 321 elective sentence (panel 37) | "ECO 321 counts for Finance here, so it cannot also count as an elective." | "ECO 321 counts only for Finance, never as an Economics elective." (the 2025–26 catalog excludes ECO 321 from electives) |
| PDF "Graduation target" line | Indented: an older list rule (`.year-block ul`) overrode the plan-details rule | Starts at the same edge as the status line |
| PDF checklist sentence (for example under ECO 214) | Squeezed into the narrow Status column | Its own line across the course and status columns, joined to its row (no line between); short notes and tags stay in the Status column |

Structural direction recorded the same day: the screen and the PDF should take their text and rules from one shared place. These shared rules are the first steps. Reviewed in two rounds by an independent reviewer on 2026-11-26.
