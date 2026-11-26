# Owner decision: last "this class" notes and one extra-elective sentence — November 26, 2026

Authority: project owner, explicit instruction in the clean-up session dated 2026-11-26 ("go 1": last wording leftovers). Effective from 2026-11-26 with no end date. Wording only: which courses are allowed, placed or counted is unchanged. Style as in the owner's earlier decisions: name the course, never "this class".

| Where | Before | After |
|---|---|---|
| Checklist and plan-grid note for an enrollment review (`checklist.checkEnrollment`) | Check this class’s enrollment status | Check enrollment for {course}. |
| Checklist note for an unrecognised review (`checklist.askWhetherCounts`) | Ask an advisor whether this class counts | Ask your advisor whether {course} counts toward the major. |
| Checklist note for an unconfirmed record (`checklist.askWhetherCounts`) | Ask your advisor whether this course counts toward the major. | Ask your advisor whether {course} counts toward the major. (Also stops a near-duplicate of the note above appearing on the same row.) |
| Checklist note for a planned course with no record (`checklist.reviewRecord`) | Ask your advisor to review this course's record. | Ask your advisor to review the record for {course}. |

Removed as unused (no student could see them):
- The plan note for an unconfirmed extra elective (`lib/planning/plan-notes.js`, `adjunct` in `policy/historical-offerings/economics-advice.json`): it depended on a value nothing in the planner ever sets. The extra-elective sentence students do see is the no-plan message (`electives.extraNeededOne/Many`), so there is now only one version.
- Two generic course markers (“Eligibility review required”, “Enrollment review required”) in `studentFriendlyCourseMarker`: nothing creates them.
