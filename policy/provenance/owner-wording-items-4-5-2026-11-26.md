# Owner decision: AP/transfer checklist note and the no-plan sentence — November 26, 2026

Authority: project owner and Economics Department domain expert, explicit instruction in the clean-up session dated 2026-11-26. Effective from 2026-11-26 with no end date. Wording only: which courses are allowed, placed or counted is unchanged.

| Item | Where | Before | After |
|---|---|---|---|
| 4 | Checklist note for AP or transfer credit (`checklist.creditConfirm`, was hard-coded in `lib/planning/plan-presentation.js`) | AP credit **AP/exam credit.** Confirm with your advisor that it counts. / Transfer credit **Transfer credit.** Confirm with your advisor that it counts. (label printed twice) | AP credit — Confirm with your advisor that it counts. / Transfer credit — Confirm with your advisor that it counts. (label once; the status label stays) |
| 5 | No plan at all (`noPlan.noneFits`, was hard-coded in `lib/planning/economics.js`) | No graduation-feasible plan fits the available schedule, prerequisite sequence, section availability, and course-load limits. | No plan fits all your choices. Change your answers, choose a later graduation year, or talk with your advisor. |

Item 5 uses Claude’s cause-neutral wording, chosen by the owner, because the line also appears when room saved for other courses is the real cause.

Panel check: the owner approved updating the student panel’s duplicate check (`scripts/panel/lint.mjs`) to recognise the new credit note, on the condition that it still fails if a label prints twice. It now flags any credit label printed twice in a checklist line (for example “AP credit AP/exam credit”, “AP credit AP credit”, “Transfer credit Transfer credit”) as a duplicate (tested in `tests/panel/panel-self-test.test.js`).

The plan grid and PDF course notes have no status label beside them, so there the note keeps its label: “AP credit. Confirm with your advisor that it counts.” / “Transfer credit. Confirm with your advisor that it counts.”
