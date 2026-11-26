# Owner decision: last "this class" notes and one extra-elective sentence — November 26, 2026

Authority: project owner, explicit instruction in the clean-up session dated 2026-11-26 ("go 1": last wording leftovers). Effective from 2026-11-26 with no end date. Wording only: which courses are allowed, placed or counted is unchanged. Style as in the owner's earlier decisions: name the course, never "this class".

| Where | Before | After |
|---|---|---|
| Checklist and plan-grid note for an enrollment review (`checklist.checkEnrollment`) | Check this class’s enrollment status | Check enrollment for {course}. |
| Checklist note for an unrecognised review (`checklist.askWhetherCounts`) | Ask an advisor whether this class counts | Ask your advisor whether {course} counts toward the major. |
| Generic course markers with no course name (`studentFriendlyCourseMarker`) | Ask an advisor whether this class counts / Check this class’s enrollment status | Ask your advisor whether it counts toward the major / Check enrollment status (shown beside the course) |
| Plan note for an unconfirmed extra elective (`policy/historical-offerings/economics-advice.json`, `adjunct`) | An additional Economics elective may be possible in Fall or Winter, but the course, funding, and instructor are not confirmed. Ask your advisor before relying on it. | An extra Economics elective in Fall or Winter may be possible but isn’t confirmed, so ask your advisor. |

The no-plan extra-electives message (`electives.extraNeededOne/Many`) now ends with exactly the same sentence as the plan note, so the student never sees two versions; a test checks they stay identical.
