import { buildPrerequisiteStatusNotices } from "./prerequisiteEvaluator.js";
import { annotatePreliminaryScheduleEvidence } from "../policy/preliminary-schedule.js";
import { buildFeasibilityDetails, classifyFeasibility } from "./economics.js";

// The steps that finish a plan once it has been checked: preliminary-schedule notes, prerequisite
// notices, the student messages and how certain the schedule is. The live edit route and the PDF
// builder both call this one function, so the screen and the PDF cannot finish a plan differently
// (owner request 2026-11-27).
export function finishCheckedPlan(plan, { validation, student, prerequisites, policyBundle, search = null }) {
  annotatePreliminaryScheduleEvidence(plan, policyBundle);
  plan.prerequisiteNotices = buildPrerequisiteStatusNotices({ plan, student, prerequisites });
  plan.studentMessages = [...new Set([
    ...(validation.warnings || []),
    ...(validation.studentNotices || []).map(notice => notice.message),
    ...plan.prerequisiteNotices.map(notice => notice.message),
    ...(plan.advisorChecks || []).map(item => item.reason).filter(Boolean),
    ...(plan.terms || []).flatMap(term => (term.courses || []).map(course => course.studentHistoricalOfferingMessage).filter(Boolean))
  ])];
  plan.feasibilityStatus = classifyFeasibility(plan, student);
  plan.feasibility = buildFeasibilityDetails(plan, student, search);
  return plan;
}
