# Owner decision: one shared step finishes a checked plan for the screen and the PDF — November 27, 2026

Authority: project owner, explicit approval ("Go") of the clean-up outline in the session dated 2026-11-27. Effective from 2026-11-27 with no end date. Code clean-up; no change to any plan, message or status.

Change: after a plan is checked, the live plan check (app/api/majors/map/route.js) and the PDF builder (lib/reports/build-economics.js) each wrote out the same finishing steps (schedule notes, prerequisite notices, student messages, plan status, schedule certainty). Both now call `finishCheckedPlan` in lib/planning/finish-checked-plan.js.

Not covered: newly generated plans are still finished by `finishGeneratedPlan` in lib/planning/economics.js, which adds search messages in a different order. Merging it would change message order and is left for a separate decision.

Check: a one-off before/after comparison (not kept in the repo) found identical outputs for 31 test students (screen answer, report data, PDF page) and 37 plan checks; an independent reviewer separately found byte-identical output for 4 students on both paths.
