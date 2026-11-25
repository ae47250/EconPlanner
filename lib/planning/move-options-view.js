// Owner decision (Nov 25, 2026): keep the instant move and replace answers, but send the
// browser only the fields it reads. The server still computes every option in full.
const MOVE_OPTION_FIELDS = ["id", "label", "status", "message", "reasonCode", "reasonCodes", "reasonTerm",
  "reasonRecurringTerms", "reasonCourse", "requiredApprovals", "ruleId"];
const REPLACEMENT_OPTION_FIELDS = [...MOVE_OPTION_FIELDS, "toTermId", "course", "title", "minimumLevel"];

function pick(source, fields) {
  const result = {};
  for (const field of fields) if (source[field] !== undefined) result[field] = source[field];
  // Keep only the load verdict, not the full load calculation behind it.
  if (source.loadDecision) result.loadDecision = { status: source.loadDecision.status, reasonCode: source.loadDecision.reasonCode };
  return result;
}

function trimCourse(course) {
  if (!course || typeof course !== "object") return course;
  const { moveNoAlternativeNotice: _unused, ...rest } = course;
  return {
    ...rest,
    ...(Array.isArray(course.moveDestinationOptions)
      ? { moveDestinationOptions: course.moveDestinationOptions.map(option => pick(option, MOVE_OPTION_FIELDS)) } : {}),
    ...(Array.isArray(course.replacementDestinationOptions)
      ? { replacementDestinationOptions: course.replacementDestinationOptions.map(option => pick(option, REPLACEMENT_OPTION_FIELDS)) } : {})
  };
}

export function browserPlanView(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.terms)) return plan;
  return { ...plan, terms: plan.terms.map(term => (Array.isArray(term?.courses) ? { ...term, courses: term.courses.map(trimCourse) } : term)) };
}

export function browserReplyView(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const result = { ...payload };
  if (result.plan) result.plan = browserPlanView(result.plan);
  if (Array.isArray(result.programs)) {
    result.programs = result.programs.map(program => ({
      ...program,
      ...(Array.isArray(program?.economicsPlans) ? { economicsPlans: program.economicsPlans.map(browserPlanView) } : {}),
      ...(program?.economicsPlan ? { economicsPlan: browserPlanView(program.economicsPlan) } : {})
    }));
  }
  return result;
}
