import { studentTermLabel } from "../planning/student-language.js";
import { courseOfferingInformation } from "../planning/plan-notes.js";
import { buildEconomicsPlanResult } from "../planning/noPlanResult.js";
import { runtimePolicyBundle } from "../policy/compat-normalized.js";
import { buildAcceleratedPlanningResult } from "../planning/acceleratedResult.js";
import { economicsCourseLabel, buildEconomicsPlanNotes } from "../planning/plan-notes.js";
import { buildPlanningSlots } from "../planning/horizon.js";
import { canonicalTermId } from "../decision-engine/placement.js";
import { buildDegreeDesignationInformation } from "../planning/degree-designations.js";
import { buildMajorRequirementsChecklist, buildPlanConditions } from "../planning/plan-presentation.js";
import { seatStatusPresentation } from "../planning/seat-status.js";

function assignmentFor(result, slotId, scenario) {
  return result?.[scenario]?.assignments?.find(item => item.slotId === slotId) || null;
}

function courseStatus(course) {
  if (!course) return "Remaining";
  if (course.status === "in_progress") return "In progress";
  if (course.evidenceStatus === "PROVISIONAL") return "Advisor Check";
  return "Completed";
}

function reportCourseLabel(course) {
  const label = economicsCourseLabel(course);
  return label === "ECO elective (200+)" ? "Economics elective (200 level or higher)" : label;
}

function inputSummary(student, _mapping, planningContext) {
  const courses = Array.isArray(student.courses) ? student.courses.filter(course => course.code || course.title).length : 0;
  const standing = student.isTransferStudent
    ? `transfer plan targeting Spring/May ${student.transferExpectedGraduationYear || "an unspecified year"}`
    : planningContext?.customGraduationEnabled
      ? `${student.academicStanding || "unspecified"} standing with a student-selected Spring/May ${planningContext.customExpectedGraduationYear || "graduation year"} target`
      : student.academicStanding ? `${student.academicStanding} standing` : "standing not supplied";
  const approvals = student.advisorApprovals ? " Advisor notes were supplied for review." : "";
  const pace = student.isTransferStudent || planningContext?.customGraduationEnabled
    ? ""
    : ` Planning pace: ${String(planningContext?.planningPace || "standard").replaceAll("_", " ")}.`;
  return `${courses} course record${courses === 1 ? "" : "s"} entered; ${standing}.${pace}${approvals} This is a planning aid, not a replacement for final registrar confirmation.`;
}

function academicYearKey(value) {
  return String(value || "").replace("/", "-");
}

function scheduleTermKey(term = {}) {
  const value = String(term.termKey || term.scheduleTerm || term.displayTerm || term.term || "");
  if (/spring|may/i.test(value)) return "May";
  return value;
}

function formatAvailabilityVerificationDate(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return value || null;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function exactPublishedSection(schedule, term, course) {
  if (!course?.course || !course.section) return null;
  if (academicYearKey(term?.academicYear) !== academicYearKey(schedule?.academicYear)) return null;
  return (schedule?.terms?.[scheduleTermKey(term)] || []).find(section => (
    section.course === course.course && String(section.section || "") === String(course.section)
  )) || null;
}

export function buildEconomicsReport({ student = {}, mapping, schedule, economicsPlan, planBundle = null, catalog = null, courseCatalog = [], policyBundle = runtimePolicyBundle(), preparedDate = new Date().toISOString().slice(0, 10) }) {
  const selectedPlanningContext = economicsPlan?.planningContext || planBundle?.context || null;
  const publishedScheduleYear = String(schedule?.academicYear || "").replace("-", "/") || null;
  const availabilityVerificationDate = schedule?.availabilityAsOf || null;
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
    : selectedPlanningContext ? buildPlanningSlots(selectedPlanningContext).filter(slot => !slot.isSummer).map(slot => ({ ...slot, slotId: slot.id, term: slot.label, courses: [],
      publicationStatus: policyBundle.indexes.offeringByTerm[canonicalTermId(slot)] ? "PUBLISHED_SCHEDULE" : "PLANNING_PROJECTION" })) : [];
  const terms = rawTerms.map(item => {
    const term = {
      ...item,
      academicYear: item.academicYear || economicsPlan?.academicYear || schedule?.academicYear || null
    };
    return {
      slotId: item.slotId || null,
      term: item.term,
      displayTerm: studentTermLabel(item.displayTerm || item.term),
      termKey: item.termKey || null,
      academicYear: term.academicYear,
      isPlaceholder: Boolean(item.isPlaceholder),
      publicationStatus: item.publicationStatus || null,
      courses: (item.courses || []).map(course => {
        const selectedSection = exactPublishedSection(schedule, term, course);
        return {
          code: course.course || course.code,
          displayLabel: reportCourseLabel(course),
          minimumLevel: course.minimumLevel || null,
          title: course.title || "",
          offeringInformation: course.fixedInProgress && (course.course || course.code) === "ECO 461"
            ? null : courseOfferingInformation(course, policyBundle),
          section: course.section || "",
          source: course.source || "verified-offering",
          scheduleProvenance: course.scheduleProvenance || course.publicationStatus || null,
          publicationStatus: course.publicationStatus || course.scheduleProvenance || null,
          preliminaryScheduleEvidence: course.preliminaryScheduleEvidence || null,
          requirementId: course.requirementId || null,
          fixedInProgress: Boolean(course.fixedInProgress),
          extra: course.extra === true,
          studentStatus: course.studentStatus || null,
          availability: selectedSection?.availability || null,
          seatStatusDisplay: seatStatusPresentation(selectedSection?.availability, {
            verified: Boolean(selectedSection), referenceDate: preparedDate
          }),
          availabilityDisplayEligible: Boolean(selectedSection),
          availabilityDisplayApplicable: academicYearKey(term.academicYear) === academicYearKey(schedule?.academicYear),
          meeting: course.meeting || null,
          approvalRequired: course.approvalRequired || null,
          planningMarkers: course.planningMarkers || [],
          selectedOptionId: course.selectedOptionId || null,
          alternativeOptions: course.alternativeOptions || [],
          replacementNotice: course.replacementNotice || null,
          moveDestinationOptions: course.moveDestinationOptions || [],
          moveGuidance: course.moveGuidance || null,
          residency: course.residency || null
        };
      })
    };
  });

  const unresolved = economicsPlan?.unscheduled
    || mapping?.projectedAfterInProgress?.optimistic?.unresolved
    || mapping?.optimistic?.unresolved
    || [];
  const advisorChecks = [
    ...(economicsPlan?.advisorChecks || []),
    ...(mapping?.missingPrerequisites || []).map(item => ({ course: item.course, reason: `Missing prerequisite: ${item.missing}` }))
  ];
  const acceleratedPlanningResult = buildAcceleratedPlanningResult({
    planningContext: planBundle?.context,
    earlyGraduationContext: planBundle?.earlyGraduationContext,
    student, mapping, policyBundle,
    candidateOutcomes: planBundle?.candidateOutcomes,
    metricsDiagnostics: planBundle?.metricsDiagnostics
  });
  const degreeRequirementInformation = economicsPlan?.degreeRequirementInformation
    || buildDegreeDesignationInformation({ student, plan: { terms: rawTerms }, planningContext: selectedPlanningContext });
  const candidate = { terms: rawTerms, planningContext: selectedPlanningContext, degreeRequirementInformation };

  return {
    schemaVersion: "econmapper-economics-report-v1",
    program: { id: "economics", name: "Economics", catalogYear: mapping?.program?.catalogYear || student.entryCatalogYear || null },
    student: {
      displayName: student.displayName || "Student",
      academicStanding: student.isTransferStudent ? "Transfer plan" : student.academicStanding || "Not supplied",
      planType: student.isTransferStudent
        ? "transfer"
        : selectedPlanningContext?.customGraduationEnabled
          ? "custom-graduation-horizon"
          : "standard",
      planningPace: selectedPlanningContext?.planningPace || student.planningPace || "standard",
      transferEntryAcademicYear: student.isTransferStudent ? student.transferEntryAcademicYear || null : null,
      expectedGraduationTerm: selectedPlanningContext?.expectedGraduationTerm || student.expectedGraduationTerm || "Not supplied",
      projectedSeniorStandingAcademicYear: selectedPlanningContext?.projectedSeniorStandingAcademicYear || null,
      projectedSeniorStandingBasis: selectedPlanningContext?.projectedSeniorStandingBasis || null
    },
    preparedDate,
    catalog,
    selectedPlan: economicsPlan || null,
    publicationStatus: economicsPlan?.publicationStatus || null,
    notices: economicsPlan?.notices || mapping?.advisorNotifications || [],
    studentNotices: economicsPlan?.studentNotices || (mapping?.advisorNotifications || []).filter(notice => notice.audience?.includes("STUDENT")),
    advisorNotifications: economicsPlan?.advisorNotifications || mapping?.advisorNotifications || [],
    prerequisiteNotices: economicsPlan?.prerequisiteNotices || [],
    degreeRequirementInformation,
    planNotes: economicsPlan?.planNotes || buildEconomicsPlanNotes({ plan: candidate, student, mapping, policyBundle, courseCatalog }),
    majorRequirementsChecklist: economicsPlan?.majorRequirementsChecklist || buildMajorRequirementsChecklist({ plan: economicsPlan || {}, mapping }),
    planConditions: economicsPlan?.planConditions || buildPlanConditions({ plan: economicsPlan || {}, mapping, policyBundle, student }),
    candidateOutcomes: planBundle?.candidateOutcomes || [],
    acceleratedPlanningResult,
    economicsPlanResult: buildEconomicsPlanResult({student, mapping, policyBundle, plans: planBundle?.plans || (economicsPlan ? [economicsPlan] : []), planningContext: planBundle?.context, candidateOutcomes: planBundle?.candidateOutcomes, planningGaps: planBundle?.planningGaps, metricsDiagnostics: planBundle?.metricsDiagnostics}),
    tuitionAdvisories: economicsPlan?.validation?.tuitionAdvisories || [],
    convergences: planBundle?.convergences || [],
    planningHorizon: terms.length ? `${terms[0].term} through ${terms.at(-1).term}` : "Not supplied",
    inputSummary: inputSummary(student, mapping, selectedPlanningContext),
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
    verifiedOfferings: schedule?.terms || {},
    availabilityVerification: {
      scheduleAcademicYear: publishedScheduleYear,
      date: availabilityVerificationDate,
      displayDate: formatAvailabilityVerificationDate(availabilityVerificationDate),
      dateAvailable: Boolean(availabilityVerificationDate)
    }
  };
}

export function reportPlanCount(report) {
  return report.terms.reduce((total, term) => total + term.courses.length, 0) + report.unresolved.length;
}
