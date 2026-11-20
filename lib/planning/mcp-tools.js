import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { compactEconomicsPlanForValidation } from "./validation-payload.js";

const STATE_LIFETIME_MS = 60 * 60 * 1000;
const MAX_STATE_BYTES = 200_000;
const planInputFields = [
  "id", "label", "description", "academicYear", "planningMode", "isEarlyGraduation",
  "isExtendedGraduation", "terms", "preferredDistributionException",
  "annualDistributionException", "distribution", "unscheduled", "summerFallbacks"
];

function encodeState(state, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "hex"), iv);
  const json = Buffer.from(JSON.stringify({ ...state, expiresAt: Date.now() + STATE_LIFETIME_MS }));
  if (json.length > MAX_STATE_BYTES) throw new Error("The plan is too large to continue in chat.");
  const body = Buffer.concat([cipher.update(deflateRawSync(json)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function decodeState(token, secret) {
  const bytes = Buffer.from(token, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(secret, "hex"), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const compressed = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  const state = JSON.parse(inflateRawSync(compressed, { maxOutputLength: MAX_STATE_BYTES }));
  if (state.expiresAt <= Date.now()) throw new Error("The plan has expired.");
  return state;
}

function planForEdit(plan) {
  const compact = compactEconomicsPlanForValidation(plan);
  return Object.fromEntries(planInputFields.filter(field => field in compact).map(field => [field, compact[field]]));
}

function displayPlan(plan) {
  return {
    id: plan.id,
    label: plan.label,
    description: plan.description,
    readinessStatus: plan.readinessStatus,
    advisorActions: plan.advisorActions,
    conditions: plan.conditions,
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
  return { content: [{ type: "text", text: message }], structuredContent: { message, ...data }, isError };
}

async function callPlanner(runPlanner, body) {
  const response = await runPlanner(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
  return { response, data: await response.json() };
}

export function registerPlannerTools(server, { runPlanner, getPlannerFingerprint, secret }) {
  server.registerTool("generate_plans", {
    description: "Generate Hanover Economics major plans from student-supplied course history.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      planningDate: z.iso.date(),
      standing: z.enum(["freshman", "sophomore", "junior", "senior"]),
      catalogYear: z.string().regex(/^\d{4}-\d{4}$/).optional().describe("Declaration catalogue year, when known."),
      earlyGraduation: z.boolean().optional(),
      courses: z.array(z.object({
        code: z.string().regex(/^[A-Z]{2,5} \d{3}[A-Z]?$/),
        status: z.enum(["completed", "in_progress"]),
        units: z.number().positive().optional()
      })).max(60)
    }
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
      ...summary, plans: plans.map(displayPlan), stateToken
    });
  });

  server.registerTool("move_course", {
    description: "Check one EconPlanner course move. Use the latest stateToken and IDs exactly as returned by a planning tool. An accepted move creates a revised plan for this conversation.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      stateToken: z.string().min(38).max(100_000).regex(/^[A-Za-z0-9_-]+$/),
      planId: z.string().min(1).max(80),
      courseId: z.string().min(1).max(160),
      fromTermId: z.string().min(1).max(80),
      toTermId: z.string().min(1).max(80)
    }
  }, async ({ stateToken, planId, courseId, fromTermId, toTermId }) => {
    let state;
    try {
      state = decodeState(stateToken, secret);
    } catch {
      return result("The plan token could not be read or has expired. Generate fresh plans.", {}, true);
    }

    const fingerprintResponse = await getPlannerFingerprint();
    const { plannerFingerprint } = await fingerprintResponse.json();
    if (!fingerprintResponse.ok || state.fingerprint !== plannerFingerprint) {
      return result("The current planning policy could not be matched. Generate fresh plans.", {}, true);
    }

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
      return result(data.error || "EconPlanner could not validate the move.", { accepted: false, code: data.code });
    }
    const plans = state.plans.map(peer => peer.id === planId ? planForEdit(data.plan) : peer);
    return result("EconPlanner accepted the move.", {
      accepted: true,
      plan: displayPlan(data.plan),
      stateToken: encodeState({ student: state.student, fingerprint: state.fingerprint, plans }, secret)
    });
  });
}
