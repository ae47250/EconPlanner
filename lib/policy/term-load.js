function canonicalLoadTerm(value) {
  const term = String(value || "").trim().toUpperCase();
  if (["SPRING", "SPRING/MAY", "MAY", "MAY TERM", "SPRING TERM"].includes(term)) return "MAY";
  return term;
}

// The answer depends only on the rule set and the term. A locked (frozen) rule set,
// as loaded in production, cannot change, so its answers are remembered; any other
// rule set (for example a test's edited copy) is searched every time.
const termLoadRuleCache = new WeakMap();
function findTermLoadRule(rules, key) {
  return rules.find(rule => (
    rule.ruleType === "termLoad"
    && canonicalLoadTerm(rule.condition?.canonicalTerm) === key
  )) || null;
}
export function termLoadRule(policyBundle, term = {}) {
  const key = canonicalLoadTerm(term.canonicalTerm || term.termKey || term.term);
  const rules = policyBundle?.rules;
  if (!rules) return null;
  if (!Object.isFrozen(rules)) return findTermLoadRule(rules, key);
  let byTerm = termLoadRuleCache.get(rules);
  if (!byTerm) termLoadRuleCache.set(rules, byTerm = new Map());
  if (!byTerm.has(key)) byTerm.set(key, findTermLoadRule(rules, key));
  return byTerm.get(key);
}

export function termLoadEvidenceForSlot(student = {}, slot = {}) {
  const values = student.termLoadOverrides || student.termLoadEvidence || {};
  const evidence = values[slot.id]
    || values[slot.label]
    || values[canonicalLoadTerm(slot.canonicalTerm || slot.termKey)]
    || null;
  if (!evidence || typeof evidence !== "object") return null;
  return {
    advisorApproval: String(evidence.advisorApproval || evidence.advisorApprovalStatus || "").toUpperCase(),
    academicProbationStatus: String(evidence.academicProbationStatus || "").toUpperCase(),
    evidenceRef: evidence.evidenceRef || null
  };
}

export function approvedOverloadEvidence(evidence = null) {
  return evidence?.advisorApproval === "APPROVED"
    && evidence?.academicProbationStatus === "NOT_ON_ACADEMIC_PROBATION";
}

export function termLoadCapacity(policyBundle, term = {}) {
  const rule = termLoadRule(policyBundle, term);
  const normalCourseUnits = Number(rule?.effect?.normalCourseUnits ?? rule?.effect?.maxTotalCourses ?? 0);
  const conditionalMaximumCourseUnits = Number(rule?.effect?.conditionalMaximumCourseUnits ?? normalCourseUnits);
  const overloadApproved = approvedOverloadEvidence(term.termLoadEvidence);
  return {
    rule,
    normalCourseUnits,
    conditionalMaximumCourseUnits,
    overloadApproved,
    activeCourseUnits: overloadApproved ? conditionalMaximumCourseUnits : normalCourseUnits
  };
}

export function plannedCourseUnits(courses = []) {
  return courses.reduce((sum, course) => sum + Math.max(0, Number(course?.units ?? 1)), 0);
}

export function policyMessage(bundle, key, params = {}) {
  return String(bundle?.messages?.[key] || "").replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
}

export function termLoadMessage(decision, bundle) {
  if (decision.reasonCode === "TERM_OVERLOAD_APPROVED" && Number(decision.messageParams?.reservedCourseUnits || 0) > 0) {
    return policyMessage(bundle, "termLoad.TERM_OVERLOAD_APPROVED_WITH_RESERVED", decision.messageParams);
  }
  return policyMessage(bundle, `termLoad.${decision.reasonCode}`, decision.messageParams);
}

// Only modeled units are known. These notices neither calculate a charge nor
// establish a student's full enrollment, and never affect academic readiness.
export function termLoadTuitionAdvisories(terms, bundle) {
  const groups = new Map();
  for (const term of terms || []) {
    const key = canonicalLoadTerm(term.termKey || term.term);
    const rule = bundle?.rules?.find(item => item.ruleType === "termLoad"
      && item.effect?.tuitionAdvisory?.canonicalTerms.includes(key));
    const advisory = rule?.effect?.tuitionAdvisory;
    if (!advisory) continue;
    const id = `${term.academicYear}|${rule.ruleId}`;
    const group = groups.get(id) || { advisory, rule, units: 0, reserved: 0, overload: false, terms: [] };
    const units = plannedCourseUnits(term.courses) + Math.max(0, Number(term.reservedCourseUnits || 0));
    group.units += units;
    group.reserved += Math.max(0, Number(term.reservedCourseUnits || 0));
    group.overload ||= units > termLoadCapacity(bundle, term).normalCourseUnits;
    group.terms.push(term.term || term.termKey || term.canonicalTerm);
    groups.set(id, group);
  }
  return [...groups.values()].filter(group => group.overload || group.units > group.advisory.thresholdExclusive).map(group => ({
    code: "TUITION_LOAD_ADVISORY", blocking: false, readinessImpact: "NONE",
    ruleIds: [group.rule.ruleId], sourceRefs: group.rule.sourceRefs,
    modeledUnits: group.units, thresholdExclusive: group.advisory.thresholdExclusive,
    message: policyMessage(bundle, group.reserved > 0 ? "tuition.threshold.withReserved"
      : group.units > group.advisory.thresholdExclusive ? "tuition.threshold.exceeded" : "tuition.threshold.possible", {
      period: group.terms.map(term => String(term).replaceAll("Spring/May", "May")).join(" and "),
      modeledUnits: group.units, threshold: group.advisory.thresholdExclusive
    })
  }));
}
