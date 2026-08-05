function assignmentFor(result, slotId, scenario) {
  return result?.[scenario]?.assignments?.find(item => item.slotId === slotId) || null;
}

function courseStatus(course) {
  if (!course) return "Remaining";
  if (course.status === "in_progress") return "In progress";
  if (course.evidenceStatus === "PROVISIONAL") return "Advisor Check";
  return "Completed";
}

function inputSummary(student, _mapping) {
  const courses = Array.isArray(student.courses) ? student.courses.filter(course => course.code || course.title).length : 0;
  const standing = student.isTransferStudent
    ? `transfer plan targeting Spring/May ${student.transferExpectedGraduationYear || "an unspecified year"}`
    : student.academicStanding ? `${student.academicStanding} standing` : "standing not supplied";
  const approvals = student.advisorApprovals ? " Advisor notes were supplied for review." : "";
  const pace = student.isTransferStudent
    ? ""
    : ` Planning pace: ${String(student.planningPace || "standard").replaceAll("_", " ")}.`;
  const seniorConfirmation = student.projectedSeniorStandingConfirmation
    ? ` The student reports Registrar or advisor confirmation of senior standing for ${student.projectedSeniorStandingConfirmation.academicYear.replace("-", "/")}.`
    : "";
  return `${courses} course record${courses === 1 ? "" : "s"} entered; ${standing}.${pace}${seniorConfirmation}${approvals} This is a planning aid, not a replacement for final registrar confirmation.`;
}

export function buildEconomicsReport({ student = {}, mapping, schedule, economicsPlan, planBundle = null, catalog = null, preparedDate = new Date().toISOString().slice(0, 10) }) {
  const selectedPlanningContext = economicsPlan?.planningContext || planBundle?.context || null;
  const requirements = (mapping?.requirements || []).map(slot => {
    const strict = assignmentFor(mapping, slot.id, "strict");
    const optimistic = assignmentFor(mapping, slot.id, "optimistic");
    const projected = assignmentFor(mapping.projectedAfterInProgress, slot.id, "optimistic");
    const selected = strict || optimistic || projected;
    return {
      id: slot.id,
      label: slot.label,
      strict: strict?.code || null,
      optimistic: optimistic?.code || null,
      projected: projected?.code || null,
      evidence: selected?.evidenceStatus || null,
      status: courseStatus(selected)
    };
  });

  const rawTerms = Array.isArray(economicsPlan?.terms)
    ? economicsPlan.terms
    : Object.entries(schedule?.terms || {}).map(([term, courses]) => ({ term, courses }));
  const terms = rawTerms.map(item => ({
    term: item.term,
    displayTerm: item.displayTerm || item.term,
    academicYear: item.academicYear || economicsPlan?.academicYear || schedule?.academicYear || null,
    isPlaceholder: Boolean(item.isPlaceholder),
    courses: (item.courses || []).map(course => ({
      code: course.course || course.code,
      title: course.title || "",
      section: course.section || "",
      source: course.source || "verified-offering",
      requirementId: course.requirementId || null,
      availability: course.availability || null,
      meeting: course.meeting || null,
      approvalRequired: course.approvalRequired || null,
      selectedOptionId: course.selectedOptionId || null,
      alternativeOptions: course.alternativeOptions || [],
      residency: course.residency || null
    }))
  }));

  const unresolved = economicsPlan?.unscheduled
    || mapping?.projectedAfterInProgress?.optimistic?.unresolved
    || mapping?.optimistic?.unresolved
    || [];
  const advisorChecks = [
    ...(economicsPlan?.advisorChecks || []),
    ...(mapping?.missingPrerequisites || []).map(item => ({ course: item.course, reason: `Missing prerequisite: ${item.missing}` }))
  ];

  return {
    schemaVersion: "econmapper-economics-report-v1",
    program: { id: "economics", name: "Economics", catalogYear: mapping?.program?.catalogYear || student.entryCatalogYear || null },
    student: {
      displayName: student.displayName || "Student",
      academicStanding: student.isTransferStudent ? "Transfer plan" : student.academicStanding || "Not supplied",
      planType: student.isTransferStudent ? "transfer" : "standard",
      planningPace: selectedPlanningContext?.planningPace || student.planningPace || "standard",
      transferEntryAcademicYear: student.isTransferStudent ? student.transferEntryAcademicYear || null : null,
      expectedGraduationTerm: selectedPlanningContext?.expectedGraduationTerm || student.expectedGraduationTerm || "Not supplied",
      projectedSeniorStandingConfirmation: selectedPlanningContext?.projectedSeniorStandingConfirmation || null,
      projectedSeniorStandingAcademicYear: selectedPlanningContext?.projectedSeniorStandingAcademicYear || null,
      projectedSeniorStandingBasis: selectedPlanningContext?.projectedSeniorStandingBasis || null
    },
    preparedDate,
    catalog,
    selectedPlan: economicsPlan || null,
    candidateOutcomes: planBundle?.candidateOutcomes || [],
    convergences: planBundle?.convergences || [],
    planningHorizon: schedule?.academicYear || economicsPlan?.academicYear || "Not supplied",
    inputSummary: inputSummary(student, mapping),
    remaining: {
      strict: mapping?.strict?.remainingUnits ?? null,
      optimistic: mapping?.optimistic?.remainingUnits ?? null,
      projected: mapping?.projectedAfterInProgress?.optimistic?.remainingUnits ?? null
    },
    requirements,
    terms,
    unresolved,
    advisorChecks,
    sourceEvidence: mapping?.sourceEvidence || [],
    verifiedOfferings: schedule?.terms || {}
  };
}

export function reportPlanCount(report) {
  return report.terms.reduce((total, term) => total + term.courses.length, 0) + report.unresolved.length;
}
