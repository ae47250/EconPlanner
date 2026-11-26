# Owner decision: screen and PDF say the same thing — November 26, 2026

Authority: project owner and Economics Department domain expert, explicit instructions in the clean-up session dated 2026-11-26 ("go batch" on the six verified screen/PDF findings and the verified sweep items, and acceptance of the "Your plan has … mark it Completed" wording). Effective from 2026-11-26 with no end date. Wording and display only: which courses are allowed, placed or counted is unchanged.

| Situation | Before | After |
|---|---|---|
| Term names in the PDF | "Spring/May 2028" in places | "May 2028" everywhere, as on the screen (stored term names are unchanged) |
| PDF header, standard plan for a student who asked to graduate early | Only the standard target | Both targets, as on the screen: "May 2030 (one year early: May 2029)" |
| Same-term math with ECO 213/214 (approved pairing) | Three sentences for one situation, and the advisor was asked to check earlier records | One sentence: "{prerequisite} comes before {course}. Taking both in the same term needs the {course} instructor’s approval." Advisor prompt (`advisor.concurrentApproval`): "Confirm the {course} instructor approves taking {course} and {prerequisite} in the same term." Checklist badge: "Approval needed" |
| Early-graduation math note (`planNote.mathSequence`) | Shown on the screen only, and it fired when math came before the course, not in the same term | Removed; the approval sentence above covers the same-term case on screen and PDF |
| Plan schedules a prerequisite the student has not marked (`history.plannedNotMarked`) | Asked the student to mark it, without saying the plan already has it | "Your plan has {prerequisite} in {term}. If you already took it, mark it Completed." |
| Overload that the advisor has approved (`TERM_OVERLOAD_APPROVED`) | Read as if approval were still needed | "{term} has {courseCount} courses. The normal limit is {normalCourseUnits}. Your advisor approved an overload of up to {conditionalMaximumCourseUnits} units." |
| No plan, blocking reason (student 04) | The same reason printed twice: in the result card and again under "Why am I seeing this result?" | Printed once, in the result card |
| No plan because of room saved for other courses (student 29) | Screen status "Needs advisor attention"; PDF "More information needed" | "Change your answers" on both, because the fix ("Save less room") is the student’s own |
| No-plan status in general | Screen and PDF used different rules | One shared rule (`noPlanStatusLabel`) for both |
| Elective label in plan notes | "ECO elective (200+)" | "Economics elective (200 level or higher)", the form used everywhere else |
| Plan table at phone width (700 px and narrower; checked at 375 px) | Words broke mid-word: "Wint/er", "2026/20/27", "ACADEMI/C YEAR" | Short labels: "Fall", "Win", "May"; "26–27"; header "Year". Screen readers still hear the full labels. Wider screens unchanged |
