import { economicsCourseLabel } from "./plan-notes.js";
import { normalizeStudentCourses } from "../requirements/normalize.js";
import { studentFriendlyCourseMarker } from "./student-language.js";
export { studentFriendlyCourseMarker, studentFriendlyUnavailableReason } from "./student-language.js";

const CHECKLIST_ORDER = ["eco-113", "eco-114", "cognate", "eco-213", "eco-214", "statistics", "finance", "eco-461"];
const CHECKLIST_LABELS = { cognate: "Mathematics", statistics: "Statistics", finance: "Finance", "eco-461": "ECO 461 / Senior Seminar" };
const STATES = {
  completed: { symbol: "✓", label: "Completed" },
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
  const details = [completedBefore, ...statusDetails,
    `${course} stays on your course history. Ask your advisor to check your earlier course or transfer records.`];
  const uncertainStatus = statusDetails.find(value => /Not taken \/ not sure/i.test(value));
  return {
    course,
    summary: uncertainStatus
      ? `${course} needs an advisor check because ${uncertainStatus.replace(/[“”]/g, "")}`
      : `${course}’s earlier course requirements need review.`,
    message: details.join(" "),
    advisorPrompt: `Check the student’s earlier course or transfer records to confirm whether ${prerequisiteText || "the required classes"} were completed before ${course}.${statusDetails.length ? ` The intake answers show ${statusDetails.join(" ")}` : ""}`,
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

function plannedRows(plan) {
  return (plan.terms || []).flatMap(term => (term.courses || [])
    .filter(course => !course.fixedInProgress)
    .map(course => ({ course, term: term.term || term.displayTerm, termId: term.slotId, requirementId: course.requirementId })));
}

// Project validated allocations. This does not decide eligibility or grant credit.
export function buildMajorRequirementsChecklist({ plan = {}, mapping = {} } = {}) {
  const allocation = plan.validation?.requirementAllocation;
  const allocations = allocation?.assignments || [];
  const proposed = plannedRows(plan);
  const requirements = [...(mapping.requirements || [])].sort((a, b) => {
    const rank = item => CHECKLIST_ORDER.includes(item.id) ? CHECKLIST_ORDER.indexOf(item.id)
      : CHECKLIST_ORDER.length + Number(item.id.match(/eco-elective-(\d+)/)?.[1] || 100);
    return rank(a) - rank(b);
  });
  const rows = requirements.map(requirement => {
    const strict = mapping.strict?.assignments?.find(item => item.slotId === requirement.id);
    const recorded = (mapping.assignments || []).find(item => item.slotId === requirement.id);
    const matches = allocations.filter(item => item.slotId === requirement.id);
    const planned = proposed.find(item => item.requirementId === requirement.id);
    const assignment = matches.length === 1 ? matches[0] : null;
    const duplicate = matches.length > 1 || (assignment && assignment.code !== "ECO elective"
      && allocations.some(item => item.slotId !== requirement.id && item.code === assignment.code));
    let status = "still_needed";
    let course = recorded?.code || null;
    let term = null;
    const markers = [];
    if (!duplicate && ["completed", "transfer"].includes(strict?.status) && strict.evidenceStatus === "VERIFIED") {
      status = "completed";
      course = strict.code;
    } else if (!duplicate && recorded?.status === "in_progress" && recorded.evidenceStatus === "VERIFIED") {
      status = "in_progress";
      term = (plan.terms || []).find(item => item.courses?.some(c => c.fixedInProgress && c.course === course))?.term || "Currently enrolled";
    } else if (!duplicate && assignment?.source === "planned" && planned && plan.validation?.valid !== false) {
      status = "planned";
      course = economicsCourseLabel(planned.course);
      term = planned.term;
    }
    if (duplicate || (recorded && recorded.evidenceStatus !== "VERIFIED") || (planned && status === "still_needed")) {
      markers.push("Ask an advisor whether this class counts");
    }
    for (const action of plan.advisorActions || []) {
      if (action.affectedObject?.course !== (recorded?.code || planned?.course.course)) continue;
      const marker = action.reasonCode?.startsWith("ENROLLMENT_") ? "Check this class’s enrollment status" : "Ask an advisor whether this class counts";
      if (!markers.includes(marker)) markers.push(marker);
    }
    if (planned?.course.planningMarkers?.includes("Approval required") || planned?.course.approvalRequired?.length) markers.push(studentFriendlyCourseMarker("Approval required"));
    if (requirement.id === "eco-461" && status === "planned" && plan.planningContext?.acceleratedPlanAssumesSeniorStanding) markers.push("Ask an advisor to confirm senior standing");
    const electiveNumber = requirement.id.match(/^eco-elective-(\d+)$/)?.[1];
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
  for (const milestone of mapping.majorMilestones || []) {
    if (milestone.status !== "REQUIRED") continue;
    rows.push({
      id: milestone.id,
      label: "Economics comprehensive evaluation",
      course: null,
      term: null,
      courseTerm: "Passing result must be confirmed separately",
      status: "still_needed",
      symbol: STATES.still_needed.symbol,
      statusLabel: "Confirmation needed",
      markers: ["Ask an advisor to confirm the passing result"],
      alternatives: [],
      evidence: null,
      sourceRefs: mapping.sourceEvidence?.map(item => item.ref) || []
    });
  }
  const unmetRequirements = rows.filter(row => row.status === "still_needed");
  return { title: "Major requirements checklist", note: "Classes marked Planned are not completed yet. Future schedules can change. Check the published schedule before you register.",
    rows, complete: unmetRequirements.length === 0, unmetRequirements,
    legend: Object.entries(STATES).filter(([key]) => key !== "still_needed").map(([status, state]) => ({ status, ...state })) };
}

function termText(value) {
  const match = /^(\d{4})-(FALL|WINTER|MAY|SPRING|SUMMER)$/.exec(String(value || ""));
  return match ? `${match[2] === "SPRING" ? "May" : match[2][0] + match[2].slice(1).toLowerCase()} ${match[1]}` : value;
}

// Keep the full validation/evidence contracts; render each actual condition once.
export function buildPlanConditions({ plan = {}, mapping = {}, policyBundle, student = {} } = {}) {
  const conditions = [];
  const add = (id, message, extra = {}) => {
    if (!message) return;
    const existing = conditions.find(item => item.message === message);
    if (existing) {
      for (const key of ["sourceMessages", "noticeCodes"]) if (extra[key]) existing[key] = [...new Set([...(existing[key] || []), ...extra[key]])];
    } else conditions.push({ id, message, ...extra });
  };
  const validation = plan.validation || {};
  if ((mapping.majorMilestones || []).some(item => item.id === "ECONOMICS-COMPREHENSIVE-EVALUATION" && item.status === "REQUIRED")) {
    add("economics-comprehensive-evaluation", "The 2023–2024 Economics major requires a passing comprehensive evaluation. Confirm its completion with your advisor; this plan does not record that result.", {kind: "requirement"});
  }
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
    const approver = /instructor/i.test(item.authority || item.type || "") ? `the ${item.course} instructor` : item.authority || item.type || "an authorized instructor";
    add(`approval-${index}`, `Taking ${item.prerequisite} and ${item.course} together in ${item.term} needs approval from ${approver}. No approval is recorded yet.`,
      { kind: "approval", authority: item.authority || item.type, course: item.course, prerequisite: item.prerequisite, term: item.term,
        advisorPrompt: `Confirm ${item.authority || item.type} approval for ${item.course} in ${item.term}.`,
        sourceRefs: item.sourceRef ? [item.sourceRef] : [] });
  }
  const context = plan.planningContext || {};
  if (context.acceleratedPlanAssumesSeniorStanding && (plan.terms || []).some(term => term.courses?.some(course => course.course === "ECO 461" && !course.fixedInProgress))) {
    add("senior-standing", `This plan assumes you will have senior standing in ${String(context.projectedSeniorStandingAcademicYear || "the final year").replace("/", "–")}. Ask your advisor to confirm you can take ECO 461 then.`, {
      kind: "standing", course: "ECO 461", advisorPrompt: `Confirm the student will be eligible for ECO 461 in ${String(context.projectedSeniorStandingAcademicYear || "the final year").replace("/", "–")}.`,
      noticeCodes: ["ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED"]
    });
  }
  for (const item of plan.unscheduled || []) add(`needed-${item.requirementId}`, `${item.label || item.course || "Requirement"}: ${item.reason || "Still needed."}`, { kind: "unmet", requirementId: item.requirementId });
  const historicalReviews = decisions.filter(item => item.reasonCode === "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW");
  const historicalReviewCourses = new Set();
  for (const decision of historicalReviews) {
    const explanation = studentFacingPrerequisiteReview(decision, { student, policyBundle });
    if (!explanation) continue;
    historicalReviewCourses.add(explanation.course);
    add(`history-review-${explanation.course}`, explanation.message, {
      kind: "review", course: explanation.course, reasonCode: decision.reasonCode,
      summary: explanation.summary, shortMessage: explanation.summary, advisorPrompt: explanation.advisorPrompt,
      requiredEvidence: explanation.requiredEvidence, sourceRefs: explanation.sourceRefs,
      noticeCodes: [`HISTORY_REVIEW_${explanation.course.replace(/\s/g, "_")}`]
    });
  }
  const enrollmentReviewMessages = new Set();
  for (const decision of decisions.filter(item => ["ENROLLMENT_FULL", "ENROLLMENT_CLOSED", "ENROLLMENT_WAITLISTED", "ENROLLMENT_STATUS_UNKNOWN"].includes(item.reasonCode))) {
    const message = studentFacingPlanReviewMessage(decision, { student, policyBundle });
    if (!message) continue;
    enrollmentReviewMessages.add(message);
    add(`enrollment-review-${decision.reasonCode}-${decision.subject?.course || "course"}`, message, {
      kind: "review", course: decision.subject?.course, reasonCode: decision.reasonCode,
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
    const dependents = group.targets.map(target => `${target.course} in ${target.term}`);
    prerequisiteSteps.push({
      order: group.targets[0].firstIndex,
      id: group.prerequisite.course,
      message: group.targets.length > 1
        ? `Finish ${group.prerequisite.course} before taking ${joinCourseNames(dependents)}.`
        : `Complete ${group.prerequisite.course} before taking ${group.targets[0].course} in ${group.targets[0].term}.`,
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
  const seatCourseCodes = [...new Set((plan.planningDetailMessages || [])
    .map(message => message.match(/^Seat availability for ([A-Z]{2,5} \d{3})-/i)?.[1])
    .filter(Boolean))];
  if (seatCourseCodes.length) {
    add("seat-confirmation", `We don’t know if there are open seats in ${joinCourseNames(seatCourseCodes)}. Check the registration system before you register.`, {
      kind: "seat", courses: seatCourseCodes
    });
  }
  for (const message of plan.validation?.errors || []) add(`block-${conditions.length}`, message, { kind: "block" });
  for (const message of plan.displayWarnings || []) {
    if (enrollmentReviewMessages.has(message)) continue;
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
    const message = item.message || (item.reasonCode === "PREREQUISITES_PENDING_SUCCESSFUL_COMPLETION"
      ? policyBundle?.planningAdvice?.display.prerequisiteCompletion
      : reviewMessage(item.reasonCode, subject.course));
    if (message) add(item.conditionId || item.actionId || `condition-${conditions.length}`, message, { kind: "review", course: subject.course, term: termText(subject.termId) });
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
