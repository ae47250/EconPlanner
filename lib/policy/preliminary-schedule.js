export function preliminaryTermId(term = {}) {
  const years = String(term.academicYear || "").match(/^(\d{4})[-/](\d{4})$/);
  const key = String(term.canonicalTerm || term.termKey || "").toUpperCase().replace("SPRING", "MAY");
  if (!years || !["FALL", "WINTER", "MAY", "SUMMER"].includes(key)) return null;
  return `${key === "FALL" ? years[1] : years[2]}-${key}`;
}

export function preliminaryEvidenceFor(bundle, termId, courseCode) {
  if (!termId || bundle?.indexes?.offeringByTerm?.[termId]) return null;
  const term = bundle?.indexes?.preliminaryOfferingByTerm?.[termId];
  if (!term?.courses?.includes(courseCode)) return null;
  return {
    releaseId: term.releaseId,
    issuedOn: term.issuedOn,
    sourceRefs: term.sourceRefs
  };
}

export function annotatePreliminaryScheduleEvidence(plan, bundle) {
  for (const term of plan?.terms || []) {
    for (const course of term.courses || []) {
      const evidence = preliminaryEvidenceFor(bundle, preliminaryTermId(term), course.course);
      if (evidence && course.source !== "verified-offering" && course.source !== "student-in-progress") {
        course.preliminaryScheduleEvidence = evidence;
      } else {
        delete course.preliminaryScheduleEvidence;
      }
    }
  }
  return plan;
}
