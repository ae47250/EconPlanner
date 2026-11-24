# Owner-approved wording — November 24, 2026

Authority: project owner and Economics Department domain expert. Approved on 2026-11-24.

Boundary: only the student-facing sentences below, wherever they appear on screen, in PDF, in “Why:” explanations, advisor lists, and move menus. No academic rule, placement, approval, or offering decision changes.

This supersedes the “forms are at the Registrar’s Office” presentation instruction in `catalog-note-wording-2026-11-21.md`, and only the listed wording in earlier presentation records. All other authority and academic boundaries remain unchanged. The owner also approved forwarding existing course and recurring-term metadata for K9 without changing rules or decision-engine logic.

Changes (current -> new):
A8  "You have {n} required courses left and {n} terms left by {term}. They cannot all fit. Choose a later graduation year or talk with your advisor." -> "You have {n} required courses left and {n} terms left by {term}. Even with a full course load each term, they cannot all fit. Choose a later graduation year or talk with your advisor." (also the singular "term" version)
C3  "Scheduled after {course}, which you marked completed. Check with your advisor." -> "This class is a prerequisite for {course}, which you marked completed. Check with your advisor."
D4  "{course} does not count toward the major because {course} fills the Statistics requirement." -> "{course} isn’t needed for the major, because {course} already fills your Statistics requirement."
D9  "{label} not marked done before this class. Ask your advisor to check." -> "{label} is a prerequisite for this class, but it isn’t marked completed. Ask your advisor to check." Always singular ({label} may be an "A or B" list).
D10 "Taking {course} now. Ask the {course} instructor about same-term approval." -> "{course} is a prerequisite for this class. Taking both in the same term needs approval from the {course} instructor."
E5  remove "Forms are at the Registrar's Office." from both catalog petition notes ("plan counts" and "plan may use"), and remove "(forms are at the Registrar's Office)" in lib/catalog/applicability.js:77.
E6  "Your {year}–{n} catalog also required a comprehensive evaluation in Economics. Ask your advisor whether you still need to take it." -> "Your {year}–{n} catalog also required a comprehensive evaluation in Economics. The current major does not. Ask your advisor whether you still need to take it."
E8  "The department prefers no more than 2 per term" -> "The department recommends no more than 2 per term", in all four versions (the termLoad text in policy/messages/en-US.json and the three endings in lib/planning/economics.js). Edit the termLoad text in place; do not add an ID.
E9  "In {term}, this plan has {n} courses. The normal limit is {n}. You recorded advisor approval and no academic probation." -> "In {term}, this plan has {n} courses. The normal limit is {n}. With advisor approval, and if you are not on academic probation, you may take up to {max} course units." ({max} = conditionalMaximumCourseUnits from the placement messageParams; same change in the "plus room for {n} more" version; edit the termLoad text in place.)
F2  drop the leading "W2" label on the W2 note only ("{course} also counts toward your Writing 2 (W2) requirement."), on screen (app/components/planNotes.js) and in the PDF (lib/reports/economics-html.js about line 176). Other notes keep their labels.
K4  "Move the elective already here first." -> "Move the elective already here first. The department usually offers only one Economics elective each Fall and Winter." K5 (the next-step sentence shown beside it) stays unchanged, so the explanation appears once.
K6  "{dependent} needs {moving} first. Move {dependent} later, then try again." -> "{moving} is a prerequisite for {dependent} and must come first. Move {dependent} later, then try again."
K7  "Take {courses} before this class." -> "{courses} is a prerequisite for this class. Take it first." Always singular (the list joins alternatives).
K8  "A required earlier class must come first." -> "This class has a prerequisite that must come first."
K9  "Not confirmed for {term}." -> when the message is the "projected only in MAY" message (UNAPPROVED_UNPUBLISHED_TERM, recurring terms MAY only; text from lib/decision-engine/placement.js about lines 222-223): "{course} is normally offered only in May. No {term} section is confirmed."; if no term is known: "{course} is normally offered only in May. No section is confirmed for this term." Otherwise keep "Not confirmed for {term}."
K14 "Same term as {course} — {authority} approval needed." -> "Same term as {course}. One is a prerequisite for the other, so {authority} approval is needed." When several approvals are joined, write "One is a prerequisite for the other" only once. Leave the version without a course name unchanged.
K16 "An advisor needs to check this move." -> "An advisor needs to check this move, because it depends on an approval or record EconPlanner can’t confirm."
K17 "This class can’t be placed in that term." -> "This class isn’t offered or allowed in that term."
K18 "This move would leave a major requirement without a class." -> "After this move, one of your major requirements would no longer be met."
