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
