# Owner decision: the sentence under a plan's status comes from the status — November 27, 2026

Authority: project owner, explicit instruction ("go") in the clean-up session dated 2026-11-27, on the item "each plan's status explanation is generic". Effective from 2026-11-27 with no end date. Display and wording only.

Problem: under every plan's status the screen and the PDF printed the schedule sentence ("Check seats and future schedules before you register."), so "Needs confirmation" or "Needs advisor attention" never said what to do.

Decision: one shared rule, `planStatusExplanation` in lib/planning/plan-display.js, used by the screen and the PDF. Wording in policy/messages/en-US.json (`planStatus.*`).

| Status | Sentence |
|---|---|
| Ready to plan | "The plan meets the major rules." plus the schedule sentence (for example "Check seats and future schedules before you register.") |
| Needs confirmation, petition only | "Your catalog needs a petition for this plan. See the notes below for paperwork to file." |
| Needs confirmation, other conditions | "Before you register, confirm {the instructor approval / your senior standing / the preliminary schedule} in the notes below." or, with none of these, "Before you register, check the notes below." Adds "The notes also list paperwork to file." when a petition is also needed |
| Needs advisor attention | "Ask your advisor to review the notes below before relying on this plan." (plus the paperwork line when a petition is needed). The screen summary keeps its "Why: …" line with the reason |

With one plan, the screen shows the sentence once, in the summary at the top, not again on the plan card. The checklist's "Future schedules can change…" note appears when the status sentence does not already warn about schedules, so the warning still appears once.
