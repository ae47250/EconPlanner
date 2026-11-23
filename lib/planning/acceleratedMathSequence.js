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
    const concurrentMath = mathOptions.filter(math => (
      placements.has(math) && placements.get(math) === economicsTerm
    ));
    if (!concurrentMath.length) return [];

    const mathLabel = concurrentMath.join(" and ");
    return [`Taking ${mathLabel} and ${economics} in one term needs the ${economics} instructor's approval.`];
  });
}
