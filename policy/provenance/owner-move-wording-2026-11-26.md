# Owner decision: course-move wording — November 26, 2026

Authority: project owner and Economics Department domain expert, explicit instruction in the clean-up session dated 2026-11-26 (ten wording changes the owner supplied). Effective from 2026-11-26 with no end date.

## Decision

Wording only. Which moves are allowed, blocked or conditional is unchanged. Each move message names the course and, where it matters, the term, and never says "this class".

| Case | Before | After |
|---|---|---|
| Same-term prerequisite approval | Same term as {course}. One is a prerequisite for the other, so instructor approval is needed. | {prerequisite} comes before {course}. Taking both in {term} needs the {course} instructor’s approval. |
| ECO 213 and ECO 214 in one unpublished term | This move needs an advisor’s review. | ECO 213 and ECO 214 must be in different terms. |
| Course not supported in May | Not confirmed for May. | {course} isn’t offered in May. |
| Missing prerequisite | {courses} is a prerequisite for this class. Take it first. | {course} needs {prerequisites} first. |
| ECO 461 missing statistics | (same as above) | ECO 461 needs a statistics course first. |
| Moving a prerequisite after its dependent | {moving} is a prerequisite for {dependent} and must come first. Move {dependent} later, then try again. | {moving} must come before {dependent}. Move {dependent} later first. |
| No verified conflict-free section | No conflict-free section is available in the published {term} schedule. | No {course} section fits in {term}. |
| Not in a complete published schedule | This class isn’t listed in the published {term} schedule. | {course} isn’t offered in {term}. |
| Term limit, destination May | Term full. Move a course out first. | May allows one course. Move the other one out first. (Fall and Winter keep “Term full. Move a course out first.”) |
| One elective per unpublished term | Move the elective already here first. The department usually offers only one Economics elective each Fall and Winter. | Only one elective per term until the schedule is published. Move the other elective first. |
| Named future course needs a published schedule | Schedule not yet published. | {course} can’t go in {term} until that schedule is published. Use an elective slot instead, or ask your advisor. |

## Adjustments made while applying the decision

- Named future course: the owner’s text ended “Use an elective slot instead.” The same rule also blocks ECO 321 for the finance requirement, where an elective slot is not the remedy, so “, or ask your advisor” was added (the earlier policy text also pointed to the advisor for finance).
- ECO 461 outside Winter (`ECO_461_WINTER_ONLY`) also fell through to “This move needs an advisor’s review.” It now reads “ECO 461 is offered only in Winter.” Same kind of fix as the ECO 213/214 case.
- The two fallback messages that said “this class” now name the course: “{course} has a prerequisite that must come first.” and “{course} isn’t offered or allowed in {term}.”
- “ECO elective” placeholders are shown as “Economics elective”.

## Where

Messages: `policy/messages/en-US.json` (`move.*`). Selection: `studentFriendlyUnavailableAdvice` and `studentFriendlyMoveCondition` in `lib/planning/student-language.js`. The statistics course list there is checked against `data/normalized/economics/requirements.json` by a test.
