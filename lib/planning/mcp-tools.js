import { z } from "zod";
import { compactEconomicsPlanForValidation } from "./validation-payload.js";
import { encodeState, openInEconPlannerUrl, verifyPlanningState } from "./mcp-state.js";

const planInputFields = [
  "id", "label", "description", "academicYear", "planningMode", "isEarlyGraduation",
  "isExtendedGraduation", "terms", "preferredDistributionException",
  "annualDistributionException", "distribution", "unscheduled", "summerFallbacks"
];

export function planForEdit(plan) {
  const compact = compactEconomicsPlanForValidation(plan);
  return Object.fromEntries(planInputFields.filter(field => field in compact).map(field => [field, compact[field]]));
}

function displayPlan(plan) {
  const approvals = plan.validation?.requiredApprovals || plan.feasibility?.requiredApprovals || [];
  return {
    id: plan.id,
    label: plan.label,
    description: plan.description,
    readinessStatus: plan.readinessStatus,
    advisorActions: plan.advisorActions,
    conditions: (plan.conditions || []).map(condition => {
      if (condition.message) return condition;
      const course = condition.affectedObject?.course;
      const approval = approvals.find(item => item.course === course && item.message);
      return { ...condition, message: approval?.message
        || `Review ${course || "this plan condition"} with your advisor before relying on this plan.` };
    }),
    terms: plan.terms.map(term => ({
      id: term.slotId || term.term,
      label: term.term,
      courses: term.courses.map(course => ({
        id: course.requirementId || `${course.course}-${course.source || "course"}`,
        code: course.course,
        title: course.title,
        section: course.section,
        offeringStatus: course.offeringStatus,
        publicationStatus: course.publicationStatus,
        approvalRequired: course.approvalRequired,
        moveDestinationIds: course.moveDestinationIds
      }))
    }))
  };
}

function result(message, data = {}, isError = false) {
  const link = data.openInEconPlannerUrl;
  return { content: [{ type: "text", text: link ? `${message}\n\n[Open in EconPlanner](${link})` : message }], structuredContent: { message, ...data }, isError };
}

function moveErrors(data) {
  const errors = [
    ...(data.validation?.errors || []),
    ...(data.plan?.validation?.errors || []),
    ...(data.planSetValidation?.errors || [])
  ].filter(message => typeof message === "string" && message.trim());
  return errors.length ? errors : [data.error || "EconPlanner could not validate the move."];
}

async function callPlanner(runPlanner, body) {
  const response = await runPlanner(new Request("https://econplanner.internal/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
  return { response, data: await response.json() };
}

export function registerPlannerTools(server, { runPlanner, getPlannerFingerprint, secret }) {
  server.registerTool("generate_plans", {
    description: "Use to build or compare Hanover College Economics major plans from a student's course history. Ask for the declaration catalogue year first; if the student does not know it, omit catalogYear and use EconPlanner's default. This tool is for the Hanover Economics major only and does not confirm course seats. For another major, say EconPlanner cannot help and suggest an advisor. Show the supplied [Open in EconPlanner] link unchanged, never its raw URL.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: {
      "openai/toolInvocation/invoking": "Building Economics plans…",
      "openai/toolInvocation/invoked": "Economics plans ready"
    },
    inputSchema: z.object({
      planningDate: z.iso.date(),
      standing: z.enum(["freshman", "sophomore", "junior", "senior"]),
      catalogYear: z.string().regex(/^\d{4}-\d{4}$/).optional().describe("Declaration catalogue year, when known."),
      earlyGraduation: z.boolean().optional(),
      courses: z.array(z.object({
        code: z.string().regex(/^[A-Z]{2,5} \d{3}[A-Z]?$/),
        status: z.enum(["completed", "in_progress"]),
        units: z.number().positive().optional()
      })).max(60)
    })
  }, async ({ planningDate, standing, catalogYear, earlyGraduation, courses }) => {
    const student = { planCreationDate: planningDate, academicStanding: standing, courses };
    if (catalogYear) student.majorDeclarationCatalogYear = catalogYear;
    if (earlyGraduation) student.planningPace = "one_year_early";

    const { response, data } = await callPlanner(runPlanner, { student });
    const economics = data.programs?.find(entry => entry.program?.id === "economics-base");
    const plans = economics?.economicsPlans || [];
    const planningResult = economics?.economicsPlanResult || data.economicsPlanResult;
    const accelerated = economics?.economicsAcceleratedResult;
    const summary = {
      conclusion: planningResult?.conclusion,
      planningResult,
      inputResolution: data.inputResolution,
      earlyGraduation: accelerated && {
        status: accelerated.status, message: accelerated.message,
        standardTarget: accelerated.standardTarget, acceleratedTarget: accelerated.acceleratedTarget
      }
    };
    if (!response.ok || !plans.length) {
      return result(data.error || "EconPlanner returned no plans.", summary, !response.ok);
    }
    if (!data.plannerFingerprint || plans.some(plan => plan.validation?.valid !== true)) {
      return result("EconPlanner could not verify the returned plans.", {}, true);
    }
    const stateToken = encodeState({
      student, plans: plans.map(planForEdit), fingerprint: data.plannerFingerprint
    }, secret);
    return result("EconPlanner returned validated plans.", {
      ...summary, plans: plans.map(displayPlan), stateToken,
      openInEconPlannerUrl: openInEconPlannerUrl(stateToken, plans[0].id)
    });
  });

  server.registerTool("move_course", {
    description: "Use after generate_plans to check one course move in a Hanover College Economics major plan. Use the latest stateToken and returned IDs exactly; an accepted move revises that plan for this conversation. This tool is for the Hanover Economics major only, does not confirm course seats, and uses the catalogue-year choice or default from generation. For another major, say EconPlanner cannot help and suggest an advisor. Show the supplied [Open in EconPlanner] link unchanged, never its raw URL.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: {
      "openai/toolInvocation/invoking": "Checking course move…",
      "openai/toolInvocation/invoked": "Course move checked"
    },
    inputSchema: z.object({
      stateToken: z.string().min(38).max(100_000).regex(/^[A-Za-z0-9_-]+$/),
      planId: z.string().min(1).max(80),
      courseId: z.string().min(1).max(160),
      fromTermId: z.string().min(1).max(80),
      toTermId: z.string().min(1).max(80)
    })
  }, async ({ stateToken, planId, courseId, fromTermId, toTermId }) => {
    const verified = await verifyPlanningState(stateToken, secret, getPlannerFingerprint);
    if (verified.kind === "invalid") {
      return result("The plan token could not be read or has expired. Generate fresh plans.", {}, true);
    }
    if (verified.kind !== "valid") {
      return result("The current planning policy could not be matched. Generate fresh plans.", {}, true);
    }
    const { state } = verified;

    const plan = state.plans.find(candidate => candidate.id === planId);
    if (!plan || fromTermId === toTermId) {
      return result("Choose a returned plan and a different destination term.", {}, true);
    }
    const { response, data } = await callPlanner(runPlanner, {
      action: "validate-plan",
      student: state.student,
      plans: state.plans,
      plan,
      edit: { type: "move", planId, courseId, fromTermId, toTermId }
    });
    if (!response.ok || data.plan?.validation?.valid !== true || data.planSetValidation?.valid !== true) {
      const errors = moveErrors(data);
      return result(`Move rejected:\n\n${errors.map(message => `- ${message}`).join("\n")}`, {
        accepted: false, code: data.code, errors,
        openInEconPlannerUrl: openInEconPlannerUrl(stateToken, planId)
      });
    }
    const plans = state.plans.map(peer => peer.id === planId ? planForEdit(data.plan) : peer);
    const nextStateToken = encodeState({ student: state.student, fingerprint: state.fingerprint, plans }, secret);
    const displayedPlan = displayPlan(data.plan);
    const approvals = data.plan.validation?.requiredApprovals || [];
    const authorities = [...new Set(approvals.map(item => item.authority).filter(Boolean))];
    const conditions = displayedPlan.conditions.map(item => item.message);
    const headline = authorities.length
      ? `Accepted, but needs ${authorities.join(" and ")} approval.`
      : conditions.length || displayedPlan.readinessStatus === "READY_WITH_CONDITIONS"
        ? "Accepted with conditions. Review them before relying on this plan."
        : "EconPlanner accepted the move.";
    const message = conditions.length ? `${headline}\n\n${conditions.map(item => `- ${item}`).join("\n")}` : headline;
    return result(message, {
      accepted: true,
      plan: displayedPlan,
      stateToken: nextStateToken,
      openInEconPlannerUrl: openInEconPlannerUrl(nextStateToken, planId)
    });
  });
}
