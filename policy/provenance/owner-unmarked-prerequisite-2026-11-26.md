# Owner decision: no "Not possible" that rests on an unmarked prerequisite — November 26, 2026

Authority: project owner and Economics Department domain expert, explicit instruction ("go") in the clean-up session dated 2026-11-26, on the final screen/PDF sweep finding. Effective from 2026-11-26 with no end date. Scope: which no-plan result a student sees. It does not change which courses are planned, prerequisites, or any requirement.

Problem: a student who marks a course Completed (for example ECO 213) but not its prerequisite (MAT 113 or MAT 121) is counted as still needing the prerequisite. That extra course can make the remaining courses not fit, and the student was told "Not possible". Panel student 31: "Not possible" as entered; with MAT 121 marked, a plan fits.

Decision: when no plan fits and a course marked Completed, transfer or Taking now has a prerequisite that is not marked, the planner plans again with that prerequisite counted as done. Only when that second search finds a plan, and the result would otherwise be "Not possible", the student sees:
- Status: "Needs one more detail"
- Heading: "Did you already take MAT 113 or MAT 121?" (the unmarked courses, named as in the course sentence, for example "a statistics course")
- The existing course sentence (for example "ECO 213 is marked completed, but MAT 113 or MAT 121 is not marked. Mark it, or your advisor will check.") followed by "With your current answers, no plan fits. Once it is marked, a plan fits." ("Once they are marked" for several courses)
- Button: "Review your courses". The search-details panel is not shown for this result.

The earlier reasons are kept in the result record (`evidence.provenReasonWithCurrentAnswers`, `evidence.reasonsWithCurrentAnswers`) but not shown: the second search shows marking resolves them. In every other case "Not possible" is unchanged. The screen (live route) and the PDF (report builder) run the same re-check.

Review history (2026-11-26): the first version replaced every "Not possible" when any prerequisite was unmarked; the second used a course count, which still hid other blockers (statistics before ECO 461, the elective count). The reviewer argued for the re-run; adopted.
