import { economicsCourseLabel } from "./plan-notes.js";

const CHECKLIST_ORDER = ["eco-113", "eco-114", "cognate", "eco-213", "eco-214", "statistics", "finance", "eco-461"];
const CHECKLIST_LABELS = { cognate: "Mathematics", statistics: "Statistics", finance: "Finance", "eco-461": "ECO 461 / Senior Seminar" };
const STATES = {
  completed: { symbol: "✓", label: "Completed" },
  in_progress: { symbol: "◐", label: "In progress" },
  planned: { symbol: "○", label: "Planned" },
  still_needed: { symbol: "!", label: "Still needed" }
};

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
      markers.push("Eligibility review required");
    }
    for (const action of plan.advisorActions || []) {
      if (action.affectedObject?.course !== (recorded?.code || planned?.course.course)) continue;
      const marker = action.reasonCode?.startsWith("ENROLLMENT_") ? "Enrollment review required" : "Eligibility review required";
      if (!markers.includes(marker)) markers.push(marker);
    }
    if (planned?.course.planningMarkers?.includes("Approval required") || planned?.course.approvalRequired?.length) markers.push("Approval required");
    if (requirement.id === "eco-461" && status === "planned" && plan.planningContext?.acceleratedPlanAssumesSeniorStanding) markers.push("Confirm senior standing");
    const electiveNumber = requirement.id.match(/^eco-elective-(\d+)$/)?.[1];
    return {
      id: requirement.id,
      label: CHECKLIST_LABELS[requirement.id] || (electiveNumber ? `Economics elective ${electiveNumber}` : requirement.label),
      course, term, courseTerm: [course, term].filter(Boolean).join(" — ") || "No qualifying assignment",
      status, symbol: STATES[status].symbol, statusLabel: STATES[status].label, markers,
      alternatives: [...(requirement.options || [])],
      evidence: strict || recorded || assignment || null,
      sourceRefs: requirement.sourceRefs || []
    };
  });
  const unmetRequirements = rows.filter(row => row.status === "still_needed");
  return { title: "Major requirements checklist", note: "Planned courses are not completed requirements. Future offerings need confirmation.",
    rows, complete: unmetRequirements.length === 0, unmetRequirements,
    legend: Object.entries(STATES).filter(([key]) => key !== "still_needed").map(([status, state]) => ({ status, ...state })) };
}

function termText(value) {
  const match = /^(\d{4})-(FALL|WINTER|MAY|SPRING|SUMMER)$/.exec(String(value || ""));
  return match ? `${match[2] === "SPRING" ? "May" : match[2][0] + match[2].slice(1).toLowerCase()} ${match[1]}` : value;
}

// Keep the full validation/evidence contracts; render each actual condition once.
export function buildPlanConditions({ plan = {}, mapping = {}, policyBundle } = {}) {
  const conditions = [];
  const add = (id, message, extra = {}) => {
    if (!message) return;
    const existing = conditions.find(item => item.message === message);
    if (existing) {
      for (const key of ["sourceMessages", "noticeCodes"]) if (extra[key]) existing[key] = [...new Set([...(existing[key] || []), ...extra[key]])];
    } else conditions.push({ id, message, ...extra });
  };
  const decisions = plan.validation?.policyDecision?.decisions || plan.validation?.reviewFindings || [];
  const reviewMessage = (reasonCode, course) => {
    const decision = decisions.find(item => item.reasonCode === reasonCode && (!course || item.subject?.course === course));
    const message = policyBundle?.messages?.[decision?.messageKeys?.student];
    return message ? [course, message].filter(Boolean).join(": ") : `Confirm ${course || "the recorded plan condition"} with your advisor.`;
  };
  const approvals = plan.feasibility?.requiredApprovals || plan.validation?.requiredApprovals || [];
  for (const [index, item] of approvals.entries()) {
    add(`approval-${index}`, `${item.authority || item.type} approval is required for ${item.prerequisite} with ${item.course} in ${item.term}. Approval has not been recorded.`,
      { kind: "approval", course: item.course, prerequisite: item.prerequisite, term: item.term, sourceRefs: item.sourceRef ? [item.sourceRef] : [] });
  }
  const context = plan.planningContext || {};
  if (context.acceleratedPlanAssumesSeniorStanding && (plan.terms || []).some(term => term.courses?.some(course => course.course === "ECO 461" && !course.fixedInProgress))) {
    add("senior-standing", `Senior standing is assumed for ${String(context.projectedSeniorStandingAcademicYear || "the final year").replace("/", "–")}; confirm eligibility for ECO 461.`, { kind: "standing", course: "ECO 461", noticeCodes: ["ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED"] });
  }
  for (const item of plan.unscheduled || []) add(`needed-${item.requirementId}`, `${item.label || item.course || "Requirement"}: ${item.reason || "Still needed."}`, { kind: "unmet", requirementId: item.requirementId });
  for (const message of plan.validation?.errors || []) add(`block-${conditions.length}`, message, { kind: "block" });
  for (const message of plan.displayWarnings || []) {
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
  for (const item of mapping.missingPrerequisites || []) add(`history-${item.course}-${item.missing}`, `${item.course}: missing prerequisite evidence for ${item.missing}.`, { kind: "review", course: item.course });
  return conditions;
}
