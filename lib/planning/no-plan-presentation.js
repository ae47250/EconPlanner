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
  if (reason === "CAPSTONE_SENIOR_STANDING_NO_ELIGIBLE_WINTER") {
    return {
      title: "ECO 461 cannot fit before this graduation target without senior standing.",
      message: evidence?.blockingReasons?.find(item => item.code === reason)?.message
        || "ECO 461 requires senior standing in Winter. Choose a later graduation year or talk with your advisor.",
      action: "Review graduation timeline",
      actionTarget: "timeline"
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
      title: "More information needed to check a course overload.",
      message: evidence?.message || "A plan may need more than the normal course limit. You need advisor approval and must not be on academic probation.",
      action: "Review my answers"
    };
  }
  if (reason === "RESERVED_ROOM_BLOCKS_PLAN") {
    return {
      title: "Your reserved room leaves too little space for the major courses.",
      message: evidence?.message || "Lower the room reserved for other courses, then try again.",
      action: "Change room for other courses",
      actionTarget: "other-courses-reserved"
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
