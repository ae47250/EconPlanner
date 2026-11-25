# Owner decision: "taking now" course not on this term's schedule — November 25, 2026

Authority: project owner and Economics Department domain expert, explicit instruction in the clean-up session dated 2026-11-25. Effective from 2026-11-25 with no end date.

## Decision

When a student marks a course "taking now" and that course is not on the published schedule for the current term, the plan is never blocked and no overload warning is added. The student may be taking the course at another school. Add an advisor-check note instead:

- Student: "{course} is not on the {term} schedule. If you are taking it at another school, that is fine. Your advisor will check it."
- Advisor: "Confirm where the student is taking {course} in {term}. It is not on the Hanover {term} schedule."

## Boundary

The note is added only when the published schedule's coverage for that course's subject (or that course) in the current term is `COMPLETE` (`coverageByTerm` in `policy/schedules/2026-2027.json`), and only in Fall and Winter, whose dates map to one term without ambiguity. Partial coverage (for example Mathematics) or a missing schedule year adds nothing, so no absence is inferred from incomplete evidence. Implemented in `takingNowNotOfferedCourses` (`lib/planning/plan-presentation.js`).
