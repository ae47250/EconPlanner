const INTERMEDIATE_ECONOMICS_COURSES = ["ECO 213", "ECO 214"];

export function acceleratedMathSequenceNotes(plan = {}, prerequisites = {}) {
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

    const mathLabel = earlierMath.join(" and ");
    return [`${mathLabel} ${earlierMath.length === 1 ? "is" : "are"} scheduled before ${economics}, so you can take ${economics} later without special approval for concurrent math. Taking them at the same time is a last-resort option and requires approval from the ${economics} instructor; approval is not guaranteed.`];
  });
}
