import { displayMessage } from "./student-language.js";

const INTERMEDIATE_ECONOMICS_COURSES = ["ECO 213", "ECO 214"];

export function acceleratedMathSequenceNotes(plan = {}, prerequisites = {}, messages) {
  if (!plan.isEarlyGraduation) return [];

  const placements = new Map();
  (plan.terms || []).forEach((term, termIndex) => {
    for (const course of term.courses || []) {
      const code = String(course.course || "").toUpperCase();
      if (code) placements.set(code, termIndex);
    }
  });

  return INTERMEDIATE_ECONOMICS_COURSES.flatMap(economics => {
    const economicsTerm = placements.get(economics);
    if (economicsTerm === undefined) return [];

    const mathOptions = [...new Set((prerequisites[economics]?.any || []).flat())];
    const earlierMath = mathOptions.filter(math => (
      placements.has(math) && placements.get(math) < economicsTerm
    ));
    if (!earlierMath.length) return [];

    // Either math course is enough, so a list reads "MAT 113 or MAT 121".
    const mathLabel = earlierMath.join(" or ");
    return [displayMessage(messages, "planNote.mathSequence", { math: mathLabel, course: economics })];
  });
}
