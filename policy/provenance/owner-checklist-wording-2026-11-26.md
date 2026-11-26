# Owner decision: checklist and plan-note prerequisite wording — November 26, 2026

Authority: project owner and Economics Department domain expert, explicit instruction in the clean-up session dated 2026-11-26. Effective from 2026-11-26 with no end date. Wording only: which courses are allowed, placed or counted is unchanged.

Style: name the course, never "this class"; "X comes before Y"; "needs the Y instructor’s approval".

| Where | Before | After |
|---|---|---|
| Checklist, prerequisite not marked (`checklist.prerequisiteNotCompleted`) | {label} is a prerequisite for this class, but it isn’t marked completed. Ask your advisor to check. | {prerequisite} isn’t marked completed, and {course} needs it first. Ask your advisor to check. |
| Checklist, prerequisite Taking now (`checklist.prerequisiteTakingNow`, moved out of `lib/planning/plan-presentation.js`) | {label} marked Taking now rather than done before this class. Ask your advisor to check. | {prerequisite} is marked Taking now, but {course} needs it done first. Ask your advisor to check. |
| Checklist, same-term math (`checklist.concurrentPrerequisite`) | {prerequisite} is a prerequisite for this class. Taking both in the same term needs approval from the {course} instructor. | {prerequisite} comes before {course}. Taking both in the same term needs the {course} instructor’s approval. |
| Planned prerequisite of a completed course (`history.scheduledPrerequisite`) | This class is a prerequisite for {course}, which you marked completed. Check with your advisor. | {prerequisite} comes before {course}, which you marked completed. Check with your advisor. |
| Early-graduation math note (`planNote.mathSequence`, moved out of `lib/planning/acceleratedMathSequence.js`) | Take {math} before {course}. Taking both in one term needs the {course} instructor's approval. | {math} comes before {course}. Taking both in one term needs the {course} instructor’s approval. |

Not changed: the checklist keeps its own short sentence rather than repeating the full Course History sentence, because the student panel’s wording check rejects the same sentence appearing twice on one screen.
