import { economicsCourseLabel } from "./plan-notes.js";
import { normalizeStudentCourses } from "../requirements/normalize.js";
import { displayMessage, studentFriendlyCourseMarker } from "./student-language.js";
import { historicalPrerequisiteCourseMessage, historicalPrerequisiteGaps } from "./historical-prerequisites.js";
import { canonicalScheduleCode, normalizeEconomicsSchedule } from "./scheduleProvider.js";
import { HANOVER_ONLY_COURSE_CODES } from "./hanover-only-courses.js";
export { studentFriendlyCourseMarker, studentFriendlyUnavailableReason } from "./student-language.js";

const CHECKLIST_ORDER = ["eco-113", "eco-114", "cognate", "eco-213", "eco-214", "statistics", "finance", "eco-461"];
const CHECKLIST_LABELS = { cognate: "Mathematics", statistics: "Statistics", finance: "Finance", "eco-461": "ECO 461 / Senior Seminar" };
const STATES = {
  completed: { symbol: "✓", label: "Completed" },
  ap_credit: { symbol: "?", label: "AP credit" },
  transfer_credit: { symbol: "?", label: "Transfer credit" },
  in_progress: { symbol: "◐", label: "In progress" },
  planned: { symbol: "○", label: "Planned" },
  still_needed: { symbol: "!", label: "Still needed" }
};

function joinCourseNames(values = []) {
  if (values.length < 2) return values[0] || "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function historicalPrerequisiteParts(decision, policyBundle) {
  const missing = new Set((decision.requiredEvidence || []).map(value => String(value).toUpperCase()));
  const rule = policyBundle?.rules?.find(item => item.ruleType === "coursePrerequisite"
    && item.condition?.course === decision.subject?.course);
  if (!rule) return [...missing].filter(value => /^[A-Z]{2,5} \d{3}$/.test(value));
  const parts = (rule.effect?.allOf || []).filter(code => missing.has(code));
  for (const group of rule.effect?.oneOfGroups || []) {
    if (group.some(code => missing.has(code))) {
      parts.push(group.length > 1 ? `either ${group.join(" or ")}` : group[0]);
    }
  }
  const recognized = new Set([...(rule.effect?.allOf || []), ...(rule.effect?.oneOfGroups || []).flat()]);
  parts.push(...[...missing].filter(value => !recognized.has(value) && /^[A-Z]{2,5} \d{3}$/.test(value)));
  return parts;
}

export function studentFacingPrerequisiteReview(decision, { student = {}, policyBundle } = {}) {
  if (decision?.reasonCode !== "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW") return null;
  const course = decision.subject?.course;
  if (!course) return null;
  const parts = historicalPrerequisiteParts(decision, policyBundle);
  const prerequisiteText = joinCourseNames(parts);
  const statuses = new Map(normalizeStudentCourses(student.courses).map(item => [item.code, item.status]));
  const statusDetails = [...new Set((decision.requiredEvidence || []).map(code => {
    const status = statuses.get(code);
    if (status === "in_progress") return `${code} is marked “Taking now.”`;
    if (status === "uncertain") return `${code} is marked “Not taken / not sure.”`;
    return null;
  }).filter(Boolean))];
  const completedBefore = prerequisiteText
    ? `Your answers do not show ${prerequisiteText} completed before ${course}.`
    : `Your answers do not confirm the required classes were completed before ${course}.`;
  const courseMessage = historicalPrerequisiteCourseMessage(course, student.courses || [], policyBundle?.rules || [], policyBundle?.messages);
  const details = courseMessage ? [courseMessage] : [completedBefore, ...statusDetails];
  const uncertainStatus = statusDetails.find(value => /Not taken \/ not sure/i.test(value));
  const concurrentMath = ["ECO 213", "ECO 214"].includes(course)
    ? (decision.requiredEvidence || []).find(code => /^MAT 1(?:13|21)$/.test(code) && statuses.get(code) === "in_progress")
    : null;
  const specificSummary = courseMessage;
  return {
    course,
    details,
    summary: specificSummary || (concurrentMath
      ? `You are taking ${course} and ${concurrentMath} together. Ask the ${course} instructor for approval.`
      : uncertainStatus
      ? `${course} needs an advisor check because ${uncertainStatus.replace(/[“”]/g, "")}`
      : `${course}’s earlier course requirements need review.`),
    message: details.join(" "),
    advisorPrompt: `Check the student’s earlier course or transfer records to confirm whether ${prerequisiteText || "the required classes"} ${parts.length === 1 ? "was" : "were"} completed before ${course}.${statusDetails.length ? ` The student's answers show ${statusDetails.join(" ")}` : ""}`,
    requiredEvidence: [...(decision.requiredEvidence || [])],
    sourceRefs: [...(decision.sourceRefs || [])]
  };
}

export function studentFacingPlanReviewMessage(decision, { student = {}, policyBundle } = {}) {
  const historyReview = studentFacingPrerequisiteReview(decision, { student, policyBundle });
  if (historyReview) return historyReview.message;
  const course = decision?.subject?.course;
  switch (decision?.reasonCode) {
    case "ENROLLMENT_FULL":
      return `The listed section for ${course || "this class"} was recorded as full. Check the registration system for current availability.`;
    case "ENROLLMENT_CLOSED":
      return `The listed section for ${course || "this class"} was recorded as closed. Ask your advisor about another section or term.`;
    case "ENROLLMENT_WAITLISTED":
      return `The listed section for ${course || "this class"} has a waitlist. Check the registration system for updates.`;
    case "ENROLLMENT_STATUS_UNKNOWN":
      return `Seat availability for ${course || "this class"} has not been confirmed. Check the registration system before registering.`;
    default:
      return null;
  }
}

export function creditReviewSummaries(decisions = [], student = {}) {
  const reviewCodes = new Set(decisions.filter(item => ["COURSE_EVIDENCE_SCOPE_REVIEW", "COURSE_HISTORY_EVIDENCE_FACT_REQUIRED"].includes(item.reasonCode))
    .map(item => item.subject?.course || item.affectedObject?.course).filter(Boolean));
  const groups = new Map();
  for (const course of normalizeStudentCourses(student.courses)) {
    if (!reviewCodes.has(course.code)) continue;
    const source = course.source === "ap_credit" ? "AP" : course.status === "transfer" || /transfer/i.test(course.source || "") ? "transfer" : null;
    if (source) groups.set(source, [...(groups.get(source) || []), course.code]);
  }
  return [...groups].map(([source, codes]) => {
    const courses = [...new Set(codes)].sort();
    return { source, codes: courses,
      message: `Confirm with your advisor that your ${source === "AP" ? "AP" : "transfer"} credit for ${joinCourseNames(courses)} counts.` };
  });
}

function plannedRows(plan) {
  return (plan.terms || []).flatMap(term => (term.courses || [])
    .filter(course => !course.fixedInProgress)
    .map(course => ({ course, term: term.term || term.displayTerm, termId: term.slotId, requirementId: course.requirementId })));
}

// Project validated allocations. This does not decide eligibility or grant credit.
export function checklistMarkerForAdvisorAction(action, { student = {}, policyBundle } = {}) {
  const reason = action?.reasonCode || "";
  const course = action?.affectedObject?.course;
  const history = (student.courses || []).find(item => item.code === course);
  if (reason === "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW") {
    // A short checklist note (the full sentence is already in the plan notes) that names the course.
    const gap = historicalPrerequisiteGaps(course, student.courses || [], policyBundle?.rules || [])[0];
    if (gap) return displayMessage(policyBundle?.messages, gap.takingNow ? "checklist.prerequisiteTakingNow" : "checklist.prerequisiteNotCompleted", { prerequisite: gap.label, course });
    const concurrentMath = normalizeStudentCourses(student.courses).find(item => /^MAT 1(?:13|21)$/.test(item.code) && item.status === "in_progress");
    if (["ECO 213", "ECO 214"].includes(course) && concurrentMath) return displayMessage(policyBundle?.messages, "checklist.concurrentPrerequisite", { prerequisite: concurrentMath.code, course });
  }
  if (reason.startsWith("ENROLLMENT_")) return "Check this class’s enrollment status";
  if (/DUPLICATE|REPEATED/.test(reason)) return "Listed more than once. It counts once.";
  if (history?.source === "ap_credit") return "AP/exam credit. Confirm with your advisor that it counts.";
  if (history?.status === "transfer" || /transfer/i.test(history?.source || "")) return "Transfer credit. Confirm with your advisor that it counts.";
  return "Ask an advisor whether this class counts";
}

export function buildMajorRequirementsChecklist({ plan = {}, mapping = {}, student = {}, policyBundle } = {}) {
  const allocation = plan.validation?.requirementAllocation;
  const allocations = allocation?.assignments || [];
  const proposed = plannedRows(plan);
  const recordedElectives = allocations.filter(item => /^eco-elective-\d+$/.test(item.slotId)
    && item.source === "completed_or_in_progress")
    .map(item => (mapping.assignments || []).find(candidate => candidate.code === item.code && candidate.courseId === item.courseId)
      || (mapping.assignments || []).find(candidate => candidate.code === item.code))
    .filter(Boolean);
  const requirements = [...(mapping.requirements || [])].sort((a, b) => {
    const rank = item => CHECKLIST_ORDER.includes(item.id) ? CHECKLIST_ORDER.indexOf(item.id)
      : CHECKLIST_ORDER.length + Number(item.id.match(/eco-elective-(\d+)/)?.[1] || 100);
    return rank(a) - rank(b);
  });
  const rows = requirements.map(requirement => {
    const electiveNumber = requirement.id.match(/^eco-elective-(\d+)$/)?.[1];
    const allocatedElective = electiveNumber ? allocations.find(item => item.slotId === requirement.id && item.source === "completed_or_in_progress") : null;
    const recordedElective = allocatedElective ? recordedElectives.find(item => item.code === allocatedElective.code) : null;
    const matches = allocations.filter(item => item.slotId === requirement.id);
    const planned = proposed.find(item => item.requirementId === requirement.id);
    const recordedMatch = matches.length === 1 && matches[0].source === "completed_or_in_progress" ? matches[0] : null;
    const recordedHistory = recordedMatch
      ? normalizeStudentCourses(student.courses).find(item => item.code === recordedMatch.code) : null;
    const recorded = recordedElective || (!electiveNumber ? (recordedMatch && recordedHistory
      ? {
          code: recordedMatch.code,
          courseId: recordedMatch.courseId,
          status: recordedHistory.status,
          evidenceStatus: recordedHistory.source === "ap_credit" || recordedHistory.status === "transfer"
            ? "PROVISIONAL" : "VERIFIED"
        }
      : (mapping.assignments || []).find(item => item.slotId === requirement.id)) : null);
    const relevantMatches = recordedElective ? allocations.filter(item => item.code === recorded.code && item.source === "completed_or_in_progress") : matches;
    const assignment = relevantMatches.length === 1 ? relevantMatches[0] : null;
    const strict = mapping.strict?.assignments?.find(item => item.code === recorded?.code);
    const duplicate = relevantMatches.length > 1 || (assignment && assignment.code !== "ECO elective"
      && allocations.some(item => item !== assignment && item.code === assignment.code));
    let status = "still_needed";
    let course = recorded?.code || null;
    let term = null;
    const markers = [];
    if (!duplicate && ["completed", "transfer"].includes(recorded?.status) && recorded.evidenceStatus === "VERIFIED") {
      status = "completed";
      course = recorded.code;
    } else if (!duplicate && recorded?.status === "in_progress" && recorded.evidenceStatus === "VERIFIED") {
      status = "in_progress";
      term = (plan.terms || []).find(item => item.courses?.some(c => c.fixedInProgress && c.course === course))?.term || "Taking now";
    } else if (!duplicate && recorded?.evidenceStatus === "PROVISIONAL") {
      const history = normalizeStudentCourses(student.courses).find(item => item.code === recorded.code);
      if (history?.source === "ap_credit") status = "ap_credit";
      else if (history?.status === "transfer" || /transfer/i.test(history?.source || "")) status = "transfer_credit";
    } else if (!duplicate && assignment?.source === "planned" && planned && plan.validation?.valid !== false) {
      status = "planned";
      course = economicsCourseLabel(planned.course);
      term = planned.term;
    }
    if (duplicate) markers.push("Listed more than once. It counts once.");
    if ((recorded?.code || planned?.course?.course) && /^ECO 1\d\d$/.test(recorded?.code || planned?.course?.course) && electiveNumber) {
      markers.push("Counts as your one 100-level elective.");
    }
    const history = (student.courses || []).find(item => item.code === (recorded?.code || planned?.course.course));
    if (recorded && recorded.evidenceStatus !== "VERIFIED") {
      if (history?.source === "ap_credit") markers.push("AP/exam credit. Confirm with your advisor that it counts.");
      else if (history?.status === "transfer" || /transfer/i.test(history?.source || "")) markers.push("Transfer credit. Confirm with your advisor that it counts.");
      else {
        markers.push("Ask your advisor whether this course counts toward the major.");
      }
    }
    if (planned && status === "still_needed") markers.push("Ask your advisor to review this course's record.");
    for (const action of plan.advisorActions || []) {
      if (action.affectedObject?.course !== (recorded?.code || planned?.course.course)) continue;
      const marker = checklistMarkerForAdvisorAction(action, { student, policyBundle });
      if (["ap_credit", "transfer_credit"].includes(status) && /^(AP\/exam credit|Transfer credit)/.test(marker)) continue;
      if (!markers.includes(marker)) markers.push(marker);
    }
    if (planned?.course.planningMarkers?.includes("Approval required") || planned?.course.approvalRequired?.length) markers.push(studentFriendlyCourseMarker("Approval required"));
    if (requirement.id === "eco-461" && status === "planned" && plan.planningContext?.acceleratedPlanAssumesSeniorStanding) markers.push("Ask your advisor and the Registrar to confirm senior standing.");
    return {
      id: requirement.id,
      label: CHECKLIST_LABELS[requirement.id] || (electiveNumber ? `Economics elective ${electiveNumber}` : requirement.label),
      course, term, courseTerm: [course, term].filter(Boolean).join(" — ") || "No class matched yet",
      status, symbol: STATES[status].symbol, statusLabel: STATES[status].label, markers,
      alternatives: [...(requirement.options || [])],
      evidence: strict || recorded || assignment || null,
      sourceRefs: requirement.sourceRefs || []
    };
  });
  const unmetRequirements = rows.filter(row => row.status === "still_needed");
  const allocatedCodes = new Set(allocations.map(item => item.code));
  const statsAssignment = allocations.find(item => item.slotId === "statistics");
  const extraCourseNotes = normalizeStudentCourses(student.courses).flatMap(course => {
    if (allocatedCodes.has(course.code)) return [];
    if (/^ECO 1\d\d$/.test(course.code) && recordedElectives.some(item => /^ECO 1\d\d$/.test(item.code))) {
      return [`${course.code} does not count toward the major because only one 100-level Economics elective can count.`];
    }
    if (["ECO 257", "MAT 217", "PSY 217"].includes(course.code) && statsAssignment) {
      return [displayMessage(policyBundle?.messages, "checklist.statisticsAlreadyFilled", { course: course.code, statisticsCourse: statsAssignment.code })];
    }
    return [];
  });
  // Owner request 2026-11-26: say the schedule warning once. The plan's status line already
  // says it for these two statuses; every other plan keeps it here.
  const statusLineWarns = ["CONDITIONALLY_FEASIBLE", "PRELIMINARY_ONLY"].includes(plan.feasibilityStatus);
  return { title: "Major requirements checklist",
    note: [...(statusLineWarns ? [] : ["Future schedules can change. Check the published schedule before you register."]), ...new Set(extraCourseNotes)].join(" "),
    rows, complete: unmetRequirements.length === 0, unmetRequirements,
    legend: Object.entries(STATES).filter(([key]) => key !== "still_needed"
      && rows.some(row => row.status === key)).map(([status, state]) => ({ status, ...state })) };
}

function termText(value) {
  const match = /^(\d{4})-(FALL|WINTER|MAY|SPRING|SUMMER)$/.exec(String(value || ""));
  return match ? `${match[2] === "SPRING" ? "May" : match[2][0] + match[2].slice(1).toLowerCase()} ${match[1]}` : value;
}

// Keep the full validation/evidence contracts; render each actual condition once.
// Owner decision (Nov 25, 2026): a course marked "taking now" that is not on this term's
// published schedule never blocks the plan. The student may be taking it at another school,
// so it gets an advisor-check note. Only terms whose schedule coverage for that subject (or
// course) is COMPLETE are checked, and only Fall and Winter, whose dates are unambiguous.
export function takingNowNotOfferedCourses({ student = {}, planningContext = {}, schedule } = {}) {
  const term = planningContext.startTerm;
  const startYear = Number(planningContext.currentAcademicYearStart);
  const normalized = normalizeEconomicsSchedule(schedule);
  // A summer plan starts at Fall, but a course "taking now" in summer is a summer course: skip it.
  if (!normalized || planningContext.isSummer || !["Fall", "Winter"].includes(term) || !Number.isFinite(startYear)) return [];
  if (String(normalized.academicYear || "").replace("/", "-") !== `${startYear}-${startYear + 1}`) return [];
  const scopes = normalized.coverageByTerm?.[term]?.coverageScopes || [];
  const offerings = normalized.terms?.[term] || [];
  const termLabel = `${term} ${term === "Fall" ? startYear : startYear + 1}`;
  const codes = [...new Set((student.courses || []).filter(course => course?.status === "in_progress")
    .map(course => String(course.code || "").trim().toUpperCase()).filter(Boolean))];
  return codes.filter(code => {
    const subject = code.split(" ")[0];
    const complete = scopes.some(scope => scope.coverage === "COMPLETE" && (scope.course === code || (!scope.course && scope.subject === subject)));
    if (!complete) return false;
    const canonical = canonicalScheduleCode(normalized, code);
    return !offerings.some(offering => offering.course === canonical || (offering.crossListedAs || []).includes(code));
  }).map(course => ({ course, term: termLabel }));
}

export function buildPlanConditions({ plan = {}, mapping = {}, policyBundle, student = {}, schedule = null } = {}) {
  const conditions = [];
  const add = (id, message, extra = {}) => {
    if (!message) return;
    const existing = conditions.find(item => item.message === message);
    if (existing) {
      for (const key of ["sourceMessages", "noticeCodes"]) if (extra[key]) existing[key] = [...new Set([...(existing[key] || []), ...extra[key]])];
    } else conditions.push({ id, message, ...extra });
  };
  const validation = plan.validation || {};
  const policyDecision = validation.policyDecision || {};
  const decisions = [...new Map([
    ...(validation.reviewFindings || []), ...(policyDecision.reviewFindings || []), ...(policyDecision.decisions || [])
  ].map(item => [item.decisionId || `${item.reasonCode}:${item.subject?.course || ""}`, item])).values()];
  const reviewMessage = (reasonCode, course) => {
    const decision = decisions.find(item => item.reasonCode === reasonCode && (!course || item.subject?.course === course));
    const studentMessage = studentFacingPlanReviewMessage(decision, { student, policyBundle });
    if (studentMessage) return studentMessage;
    const message = policyBundle?.messages?.[decision?.messageKeys?.student];
    return message ? [course, message].filter(Boolean).join(": ") : `Confirm ${course || "the recorded plan condition"} with your advisor.`;
  };
  const approvals = plan.feasibility?.requiredApprovals || plan.validation?.requiredApprovals || [];
  for (const [index, item] of approvals.entries()) {
    const approver = /instructor/i.test(item.authority || item.type || "") ? `the ${item.course} instructor`
      : item.authority === "Economics Department" ? "the Economics Department" : item.authority || item.type || "an authorized instructor";
    add(`approval-${index}`, `Taking ${item.prerequisite} and ${item.course} together in ${item.term} needs approval from ${approver} before you register.`,
      { kind: "approval", authority: item.authority || item.type, course: item.course, prerequisite: item.prerequisite, term: item.term,
        advisorPrompt: `Confirm ${approver} approves taking ${item.prerequisite} and ${item.course} together in ${item.term}.`,
        sourceRefs: item.sourceRef ? [item.sourceRef] : [] });
  }
  const context = plan.planningContext || {};
  if (context.acceleratedPlanAssumesSeniorStanding && (plan.terms || []).some(term => term.courses?.some(course => course.course === "ECO 461" && !course.fixedInProgress))) {
    add("senior-standing", `This plan assumes you will have senior standing in ${String(context.projectedSeniorStandingAcademicYear || "the final year").replace("/", "–")}. Ask your advisor and the Registrar to confirm you can take ECO 461 then.`, {
      kind: "standing", course: "ECO 461", advisorPrompt: `Confirm the student will be eligible for ECO 461 in ${String(context.projectedSeniorStandingAcademicYear || "the final year").replace("/", "–")}.`,
      noticeCodes: ["ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED"]
    });
  }
  for (const item of plan.unscheduled || []) add(`needed-${item.requirementId}`, `${item.label || item.course || "Requirement"}: ${item.reason || "Still needed."}`, { kind: "unmet", requirementId: item.requirementId });
  const historicalReviews = decisions.filter(item => item.reasonCode === "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW");
  const apCreditCodes = [...new Set((student.courses || [])
    .filter(item => item.status === "completed" && item.source === "ap_credit")
    .map(item => item.code))];
  const apCreditSummary = apCreditCodes.length
    ? `${joinCourseNames(apCreditCodes)} ${apCreditCodes.length === 1 ? "is" : "are"} recorded as AP or exam credit. Confirm with your advisor that ${apCreditCodes.length === 1 ? "it counts" : "they count"}.`
    : null;
  const historicalReviewCourses = new Set();
  const historicalReviewMessages = new Set();
  const creditReviews = creditReviewSummaries(decisions, student);
  const creditReviewCodes = new Set(creditReviews.flatMap(item => item.codes));
  for (const [index, review] of creditReviews.entries()) {
    add(`credit-review-${index}`, review.message, { kind: "review",
      shortMessage: `Your advisor needs to confirm that your ${review.source === "AP" ? "AP" : "transfer"} credit for ${joinCourseNames(review.codes)} counts toward the major.`,
      advisorPrompt: `Confirm whether the student’s ${review.source === "AP" ? "AP" : "transfer"} credit for ${joinCourseNames(review.codes)} counts.` });
  }
  for (const decision of historicalReviews) {
    const explanation = studentFacingPrerequisiteReview(decision, { student, policyBundle });
    if (!explanation) continue;
    historicalReviewCourses.add(explanation.course);
    historicalReviewMessages.add(explanation.message);
    for (const [index, message] of explanation.details.entries()) {
      add(`history-review-${explanation.course}-${index}`, message, {
        kind: "review", course: explanation.course, reasonCode: decision.reasonCode,
        ...(index === 0 ? { summary: explanation.summary, shortMessage: explanation.summary, advisorPrompt: explanation.advisorPrompt,
          noticeCodes: [`HISTORY_REVIEW_${explanation.course.replace(/\s/g, "_")}`] } : {}),
        requiredEvidence: explanation.requiredEvidence, sourceRefs: explanation.sourceRefs
      });
    }
  }
  // Owner decision (Nov 25, 2026): a senior may mark ECO 461 completed (Hanover only); the advisor confirms it.
  for (const course of normalizeStudentCourses(student.courses || []).filter(item => ["completed", "in_progress"].includes(item.status)
    && HANOVER_ONLY_COURSE_CODES.has(item.code))) {
    const code = course.code;
    const takingNow = course.status === "in_progress";
    add(`hanover-only-${takingNow ? "taking-now" : "completed"}-${code}`,
      displayMessage(policyBundle?.messages, takingNow ? "history.hanoverOnlyTakingNow" : "history.hanoverOnlyCompleted", { course: code }), {
      kind: "review", course: code,
      advisorPrompt: displayMessage(policyBundle?.messages, takingNow ? "history.hanoverOnlyTakingNowAdvisor" : "history.hanoverOnlyCompletedAdvisor", { course: code }),
      noticeCodes: [`HANOVER_ONLY_${takingNow ? "TAKING_NOW" : "COMPLETED"}_${code.replace(/\s/g, "_")}`]
    });
  }
  for (const item of takingNowNotOfferedCourses({ student, planningContext: plan.planningContext || {}, schedule })) {
    add(`taking-now-not-offered-${item.course}`, displayMessage(policyBundle?.messages, "history.takingNowNotOffered", item), {
      // No shortMessage: this note must not replace the real cause in the plan's "Why:" line.
      kind: "review", course: item.course,
      advisorPrompt: displayMessage(policyBundle?.messages, "history.takingNowNotOfferedAdvisor", item),
      noticeCodes: [`TAKING_NOW_NOT_OFFERED_${item.course.replace(/\s/g, "_")}`]
    });
  }
  const enrollmentReviewMessages = new Set();
  for (const decision of decisions.filter(item => ["ENROLLMENT_FULL", "ENROLLMENT_CLOSED", "ENROLLMENT_WAITLISTED", "ENROLLMENT_STATUS_UNKNOWN"].includes(item.reasonCode))) {
    const message = studentFacingPlanReviewMessage(decision, { student, policyBundle });
    if (!message) continue;
    enrollmentReviewMessages.add(message);
    add(`enrollment-review-${decision.reasonCode}-${decision.subject?.course || "course"}`, message, {
      kind: "review", course: decision.subject?.course, reasonCode: decision.reasonCode,
      shortMessage: decision.reasonCode === "ENROLLMENT_FULL" ? message : null,
      sourceRefs: decision.sourceRefs || []
    });
  }
  const prerequisiteNotices = plan.prerequisiteNotices || [];
  const prerequisiteTargets = new Map();
  for (const [index, item] of prerequisiteNotices.entries()) {
    const key = `${item.dependentCourse}\u001f${item.dependentTerm}`;
    const target = prerequisiteTargets.get(key) || {
      course: item.dependentCourse, term: item.dependentTerm, firstIndex: index, prerequisites: []
    };
    if (!target.prerequisites.some(entry => entry.course === item.prerequisite)) {
      target.prerequisites.push({ course: item.prerequisite, status: item.prerequisiteStatus });
    }
    prerequisiteTargets.set(key, target);
  }
  const prerequisiteSteps = [];
  const repeatedPrerequisites = new Map();
  for (const target of prerequisiteTargets.values()) {
    if (target.prerequisites.length > 1) {
      prerequisiteSteps.push({
        order: target.firstIndex,
        id: target.course,
        message: `Before taking ${target.course} in ${target.term}, finish ${joinCourseNames(target.prerequisites.map(item => item.course))}.`,
        extra: { kind: "prerequisite", course: target.course, prerequisites: target.prerequisites.map(item => item.course), term: target.term }
      });
      continue;
    }
    const prerequisite = target.prerequisites[0];
    const group = repeatedPrerequisites.get(prerequisite.course) || { prerequisite, targets: [] };
    group.targets.push(target);
    repeatedPrerequisites.set(prerequisite.course, group);
  }
  for (const group of repeatedPrerequisites.values()) {
    const termOrder = term => {
      const match = /^(Fall|Winter|Spring\/May|May) (\d{4})$/.exec(term || "");
      return match ? Number(match[2]) * 3 + ({ Winter: 0, "Spring/May": 1, May: 1, Fall: 2 })[match[1]] : Number.MAX_SAFE_INTEGER;
    };
    group.targets.sort((left, right) => termOrder(left.term) - termOrder(right.term) || left.course.localeCompare(right.course));
    const commonTerm = group.targets.length > 1 && group.targets.every(target => target.term === group.targets[0].term)
      ? group.targets[0].term : null;
    const dependents = commonTerm
      ? group.targets.map(target => target.course)
      : group.targets.map(target => `${target.course} in ${target.term}`);
    prerequisiteSteps.push({
      order: group.targets[0].firstIndex,
      id: group.prerequisite.course,
      message: group.targets.length > 1
        ? `Before taking ${joinCourseNames(dependents)}${commonTerm ? ` in ${commonTerm}` : ""}, finish ${group.prerequisite.course}.`
        : `Before taking ${group.targets[0].course} in ${group.targets[0].term}, finish ${group.prerequisite.course}.`,
      extra: {
        kind: "prerequisite", prerequisite: group.prerequisite.course,
        dependentCourses: group.targets.map(target => target.course),
        term: group.targets.length === 1 ? group.targets[0].term : undefined
      }
    });
  }
  prerequisiteSteps.sort((a, b) => a.order - b.order).forEach((step, index) => {
    add(`prerequisite-${step.id.replace(/[^A-Z0-9]+/gi, "-")}-${index}`, step.message, step.extra);
  });
  const recordedFullCourses = new Set((plan.terms || []).flatMap(term => (term.courses || [])
    .filter(course => course.availability?.status === "full").map(course => course.course)));
  const seatCourseCodes = [...new Set((plan.planningDetailMessages || [])
    .map(message => message.match(/^Seat availability for ([A-Z]{2,5} \d{3})-/i)?.[1])
    .filter(code => code && !recordedFullCourses.has(code)))];
  if (seatCourseCodes.length) {
    add("seat-confirmation", `We don’t know if there are open seats in ${joinCourseNames(seatCourseCodes)}. Check the registration system before you register.`, {
      kind: "seat", courses: seatCourseCodes
    });
  }
  for (const message of plan.validation?.errors || []) add(`block-${conditions.length}`, message, { kind: "block" });
  for (const message of plan.displayWarnings || []) {
    if (enrollmentReviewMessages.has(message)) continue;
    if (historicalReviewMessages.has(message)) continue;
    if ([...creditReviewCodes].some(code => message === `${code} needs an advisor review.` || message === `Confirm ${code} with your advisor.`)) continue;
    if (message === policyBundle?.planningAdvice?.display?.prerequisiteCompletion && prerequisiteNotices.length) continue;
    if (message === policyBundle?.planningAdvice?.display?.seatConfirmation && seatCourseCodes.length) continue;
    const historicalWarning = message.match(/^([A-Z]{2,5} \d{3}).*historical prerequisite evidence requires advisor review/i);
    if (historicalWarning && historicalReviewCourses.has(historicalWarning[1])) continue;
    if (/approval is required|approval from .* is required/i.test(message) && approvals.length) continue;
    const rawReview = message.match(/^(.*?) requires advisor review \(([A-Z_]+)\)\.?$/);
    if (rawReview) {
      add(`review-${rawReview[2]}-${rawReview[1]}`, reviewMessage(rawReview[2], rawReview[1]), { kind: "review", course: rawReview[1], sourceMessages: [message] });
      continue;
    }
    add(`warning-${conditions.length}`, message, { kind: "warning" });
  }
  for (const item of plan.advisorChecks || []) {
    if (approvals.some(approval => approval.course === item.course && /concurrent|approval/i.test(item.reason || ""))) continue;
    add(`review-${conditions.length}`, item.reason, { kind: "review", course: item.course });
  }
  for (const item of [...(plan.conditions || plan.validation?.conditions || []), ...(plan.advisorActions || plan.validation?.advisorActions || [])]) {
    if (item.reasonCode === "PREREQUISITES_PENDING_SUCCESSFUL_COMPLETION" && prerequisiteNotices.length) continue;
    if (item.reasonCode === "PREREQUISITES_CONDITIONAL_ON_APPROVAL" && approvals.length) continue;
    const subject = item.affectedObject || item.subject || {};
    if (creditReviewCodes.has(subject.course) && ["COURSE_EVIDENCE_SCOPE_REVIEW", "COURSE_HISTORY_EVIDENCE_FACT_REQUIRED"].includes(item.reasonCode)) continue;
    if (item.reasonCode === "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW" && historicalReviewCourses.has(subject.course)) continue;
    const message = item.message || (item.reasonCode === "PREREQUISITES_PENDING_SUCCESSFUL_COMPLETION"
      ? policyBundle?.planningAdvice?.display.prerequisiteCompletion
      : reviewMessage(item.reasonCode, subject.course));
    if (message) add(item.conditionId || item.actionId || `condition-${conditions.length}`, message, {
      kind: item.reasonCode === "TERM_OVERLOAD_APPROVED" ? "registration" : "review",
      course: subject.course, term: termText(subject.termId),
      shortMessage: item.reasonCode === "TERM_OVERLOAD_APPROVED" ? null
        : apCreditCodes.includes(subject.course) ? apCreditSummary : message
    });
    else {
      add(item.conditionId || item.actionId || `review-${conditions.length}`,
        `Confirm ${[subject.course, subject.termId ? `in ${termText(subject.termId)}` : ""].filter(Boolean).join(" ") || "the recorded plan condition"} with your advisor.`, { kind: "review", course: subject.course });
    }
  }
  for (const item of mapping.missingPrerequisites || []) {
    if (historicalReviewCourses.has(item.course)) continue;
    add(`history-${item.course}-${item.missing}`, `Your answers don’t show ${item.missing} completed before ${item.course}. Ask your advisor to check your course history.`, { kind: "review", course: item.course, summary: `${item.course}’s earlier course requirements need review.` });
  }
  return conditions;
}
