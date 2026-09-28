function canonicalLoadTerm(value) {
  const term = String(value || "").trim().toUpperCase();
  if (["SPRING", "SPRING/MAY", "MAY", "MAY TERM", "SPRING TERM"].includes(term)) return "MAY";
  return term;
}

export function termLoadRule(policyBundle, term = {}) {
  const key = canonicalLoadTerm(term.canonicalTerm || term.termKey || term.term);
  return policyBundle?.rules?.find(rule => (
    rule.ruleType === "termLoad"
    && canonicalLoadTerm(rule.condition?.canonicalTerm) === key
  )) || null;
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
    const group = groups.get(id) || { advisory, rule, units: 0, overload: false, terms: [] };
    const units = plannedCourseUnits(term.courses) + Math.max(0, Number(term.reservedCourseUnits || 0));
    group.units += units;
    group.overload ||= units > termLoadCapacity(bundle, term).normalCourseUnits;
    group.terms.push(term.term);
    groups.set(id, group);
  }
  return [...groups.values()].filter(group => group.overload || group.units > group.advisory.thresholdExclusive).map(group => ({
    code: "TUITION_LOAD_ADVISORY", blocking: false, readinessImpact: "NONE",
    ruleIds: [group.rule.ruleId], sourceRefs: group.rule.sourceRefs,
    modeledUnits: group.units, thresholdExclusive: group.advisory.thresholdExclusive,
    message: policyMessage(bundle, group.units > group.advisory.thresholdExclusive
      ? "tuition.threshold.exceeded" : "tuition.threshold.possible", {
      period: group.advisory.canonicalTerms.map(key => ({FALL: "Fall", WINTER: "Winter", MAY: "Spring/May"}[key])).join(" and "),
      modeledUnits: group.units, threshold: group.advisory.thresholdExclusive
    })
  }));
}
