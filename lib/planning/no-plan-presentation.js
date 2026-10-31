export function noPlanPresentation(category, reason, evidence = {}, coursePrerequisites = {}) {
  const attempts = Array.isArray(evidence?.searchAttempts) ? evidence.searchAttempts : [];
  const gaps = Array.isArray(evidence?.planningGaps) ? evidence.planningGaps : [];
  const prerequisiteGap = gaps.flatMap(gap => gaps
    .filter(dependent => coursePrerequisites[dependent.course]?.all?.includes(gap.course))
    .map(dependent => ({ prerequisite: gap, dependent })))
    .find(({ prerequisite }) => attempts.length > 0
      && attempts.every(attempt => attempt.complete && !attempt.solutionFound && attempt.emptyDomains?.includes(prerequisite.requirementId)));

  if (category === "INPUT_BLOCKED") {
    return {
      title: "We need one more detail before we can build your plan.",
      message: "Review the question below. Your previous answers are still saved.",
      action: "Review my answers"
    };
  }
  if (category === "SEARCH_INCOMPLETE") {
    return {
      title: "We could not finish checking every possible plan.",
      message: "This does not mean a plan is impossible. Review your answers or ask an advisor to help check the remaining possibilities.",
      action: "Review my answers"
    };
  }
  if (reason === "MISSING_OFFERING") {
    return {
      title: "More information needed to decide whether this major can be completed by your target.",
      message: "Course offering evidence is incomplete for this graduation target. This result does not establish that major completion is impossible.",
      action: "Review my answers"
    };
  }
  if (reason === "TERM_OVERLOAD_EVIDENCE_REQUIRED") {
    return {
      title: "More information needed to assess an advisor-approved overload.",
      message: "The normal-load search found no complete plan. Record existing advisor approval and absence of academic probation before using additional capacity.",
      action: "Review my answers"
    };
  }
  if (category === "INFEASIBLE_PROVEN") {
    if (reason === "EMPTY_DOMAIN" && prerequisiteGap) {
      return {
        title: `${prerequisiteGap.prerequisite.course} is a prerequisite for ${prerequisiteGap.dependent.course} and could not be placed first.`,
        message: "Review your course history and graduation target with your academic advisor.",
        action: "Review graduation timeline",
        actionTarget: "timeline"
      };
    }
    return {
      title: "No complete plan fits this graduation target with the available course timing and capacity.",
      message: "Review your graduation timeline and bring this result to your academic advisor.",
      action: "Review graduation timeline",
      actionTarget: "timeline"
    };
  }
  return {
    title: "This planning result needs advisor attention before we can show a complete schedule.",
    message: "Your answers are saved. Review the details below with your academic advisor.",
    action: "Review my answers"
  };
}
