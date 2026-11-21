import test from "node:test";
import assert from "node:assert/strict";
import { GET as getPlannerFingerprint, POST as runPlanner } from "../app/api/majors/map/route.js";
import { POST as openLinkedPlan } from "../app/api/mcp/open-plan/route.js";
import { POST as mcpRequest, maxDuration } from "../app/api/mcp/route.js";
import { registerPlannerTools } from "../lib/planning/mcp-tools.js";
import { encodeState, openInEconPlannerUrl, publicSiteOrigin } from "../lib/planning/mcp-state.js";

const stateKey = "ab".repeat(32); // Fictional test key, never used in a deployment.
process.env.ECONPLANNER_MCP_STATE_KEY = stateKey;
process.env.VERCEL_URL = "econplanner-preview.vercel.app";

function toolHandlers() {
  const handlers = new Map();
  registerPlannerTools({ registerTool: (name, _definition, handler) => handlers.set(name, handler) }, {
    runPlanner, getPlannerFingerprint, secret: stateKey
  });
  return handlers;
}

function placement(plan, code, termId = null) {
  return plan.terms.flatMap(term => term.courses
    .filter(course => course.code === code && (!termId || term.id === termId))
    .map(course => ({ termId: term.id, courseId: course.id }))).at(0);
}

async function redeem(stateToken, planId) {
  return openLinkedPlan(new Request("https://econplanner.test/api/mcp/open-plan", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stateToken, planId })
  }));
}

test("hosted MCP advertises the same two tools with a five-minute function limit", async () => {
  assert.equal(maxDuration, 300);
  const response = await mcpRequest(new Request("https://econplanner-preview.vercel.app/api/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  const message = JSON.parse(text.match(/^data: (.*)$/m)[1]);
  const tools = message.result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ["generate_plans", "move_course"]);
  for (const tool of tools) {
    assert.match(tool.description, /Hanover.*Economics major/);
    assert.match(tool.description, /seats/);
    assert.match(tool.description, /catalogue.year/);
    assert.match(tool.description, /advisor/);
    assert.match(tool.description, /link unchanged, never its raw URL/);
    assert.ok(tool._meta?.["openai/toolInvocation/invoking"]?.length <= 64);
    assert.ok(tool._meta?.["openai/toolInvocation/invoked"]?.length <= 64);
  }
  assert.match(tools[0].description, /Ask for the declaration catalogue year first/);
  assert.match(tools[1].description, /Use after generate_plans/);
});

test("pilot planning and move decisions stay the same and return encrypted handoff links", async () => {
  const tools = toolHandlers();
  const generatedResult = await tools.get("generate_plans")({
    planningDate: "2026-11-20", standing: "freshman", earlyGraduation: true,
    courses: [{ code: "ECO 113", status: "in_progress" }]
  });
  const generated = generatedResult.structuredContent;
  assert.deepEqual(generated.plans.map(plan => [plan.id, plan.terms.at(-1).id]), [
    ["balanced", "spring-2030"], ["explore-first", "spring-2030"], ["one-year-early", "spring-2029"]
  ]);
  assert.equal(placement(generated.plans[0], "MAT 113").termId, "fall-2027");
  assert.equal(new URL(generated.openInEconPlannerUrl).origin, "https://econplanner-preview.vercel.app");
  assert.equal(new URL(generated.openInEconPlannerUrl).search, "");
  assert.equal(new URLSearchParams(new URL(generated.openInEconPlannerUrl).hash.slice(1)).get("openPlan"), generated.stateToken);
  assert.ok(generatedResult.content[0].text.endsWith(`[Open in EconPlanner](${generated.openInEconPlannerUrl})`));
  assert.ok(!("student" in generated));

  let token = generated.stateToken;
  let balanced = generated.plans[0];
  let lastMoveResult;
  async function move(code, toTermId, fromTermId = null) {
    const from = placement(balanced, code, fromTermId);
    assert.ok(from, `${code} must be in the displayed plan`);
    lastMoveResult = await tools.get("move_course")({
      stateToken: token, planId: "balanced", courseId: from.courseId,
      fromTermId: from.termId, toTermId
    });
    const response = lastMoveResult.structuredContent;
    if (response.accepted) { token = response.stateToken; balanced = response.plan; }
    return response;
  }
  assert.equal((await move("MAT 113", "winter-2027")).accepted, true);
  const conditional = await move("MAT 113", "winter-2028");
  assert.equal(conditional.accepted, true);
  assert.equal(conditional.plan.readinessStatus, "READY_WITH_CONDITIONS");
  assert.ok(conditional.plan.conditions.some(item => item.affectedObject?.course === "ECO 213"
    && /Approval from the ECO 213 instructor is required/.test(item.message)));
  assert.ok(conditional.plan.conditions.every(item => item.message));
  assert.match(conditional.message, /^Accepted, but needs ECO 213 instructor approval\./);
  assert.ok(lastMoveResult.content[0].text.endsWith(`[Open in EconPlanner](${conditional.openInEconPlannerUrl})`));
  assert.ok(!("student" in conditional));
  const rejected = await move("MAT 217", "winter-2030");
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.errors.length, 2);
  assert.match(rejected.message, /^Move rejected:/);
  for (const error of rejected.errors) assert.ok(lastMoveResult.content[0].text.includes(`- ${error}`));
  assert.equal((await move("ECO elective", "fall-2027", "spring-2030")).accepted, true);
  const rejectedAgain = await move("MAT 217", "spring-2030");
  assert.equal(rejectedAgain.accepted, false);
  assert.ok(rejectedAgain.errors.length >= 1);
  assert.equal(new URLSearchParams(new URL(conditional.openInEconPlannerUrl).hash.slice(1)).get("plan"), "balanced");
  assert.equal((await redeem(token, "balanced")).status, 200);
});

test("chat study-abroad context and both reservations survive a move and web handoff", async () => {
  const tools = toolHandlers();
  const studentContext = {
    planningDate: "2026-11-21", standing: "sophomore", courses: [],
    studyAbroadTerm: "winter-2028", studyAbroadMayOverlap: true,
    studyAbroadDestination: "Australia is one possible destination.",
    studyAbroadAdvisingNote: "Some courses taken abroad, especially Economics electives, may count toward Hanover’s Economics major. Check with your advisor or the Economics department once your course list is available."
  };
  const generated = (await tools.get("generate_plans")(studentContext)).structuredContent;
  assert.deepEqual(generated.studyAbroadTermIds, ["winter-2028", "spring-2028"]);
  assert.deepEqual(generated.studentAdvisorContext, [studentContext.studyAbroadAdvisingNote]);
  const balanced = generated.plans.find(plan => plan.id === "balanced");
  for (const id of generated.studyAbroadTermIds) {
    const term = balanced.terms.find(item => item.id === id);
    assert.equal(term.studyAbroad, true);
    assert.deepEqual(term.courses, []);
  }
  const source = placement(balanced, "ECO 214");
  const rejected = (await tools.get("move_course")({
    stateToken: generated.stateToken, planId: "balanced", courseId: source.courseId,
    fromTermId: source.termId, toTermId: "winter-2028"
  })).structuredContent;
  assert.equal(rejected.accepted, false);
  const elective = balanced.terms.flatMap(term => term.courses.map(course => ({ termId: term.id, course })))
    .find(item => item.course.code === "ECO elective" && item.termId !== "spring-2028");
  const mayRejected = (await tools.get("move_course")({
    stateToken: generated.stateToken, planId: "balanced", courseId: elective.course.id,
    fromTermId: elective.termId, toTermId: "spring-2028"
  })).structuredContent;
  assert.equal(mayRejected.accepted, false);
  const math = placement(balanced, "MAT 217");
  const moved = (await tools.get("move_course")({
    stateToken: generated.stateToken, planId: "balanced", courseId: math.courseId,
    fromTermId: math.termId, toTermId: "winter-2027"
  })).structuredContent;
  assert.equal(moved.accepted, true);
  assert.deepEqual(moved.studyAbroadTermIds, ["winter-2028", "spring-2028"]);
  assert.deepEqual(moved.studentAdvisorContext, generated.studentAdvisorContext);
  const opened = await redeem(moved.stateToken, "balanced");
  assert.equal(opened.status, 200);
  const linked = await opened.json();
  assert.equal(linked.student.reservedCourseUnits["winter-2028"], 4);
  assert.equal(linked.student.reservedCourseUnits["spring-2028"], 1);
  assert.equal(linked.student.studyAbroadDestination, studentContext.studyAbroadDestination);
  assert.equal(linked.student.studyAbroadAdvisingNote, studentContext.studyAbroadAdvisingNote);
  assert.equal(linked.plans.find(plan => plan.id === "balanced").terms.find(term => term.slotId === "winter-2027").courses.some(course => course.course === "MAT 217"), true);
});

test("link redemption rejects altered, expired, wrong-plan, and stale-policy tokens", async t => {
  const { plannerFingerprint } = await (await getPlannerFingerprint()).json();
  const state = { student: { academicStanding: "freshman", courses: [] },
    plans: [{ id: "balanced", terms: [] }], fingerprint: plannerFingerprint };
  const token = encodeState(state, stateKey);
  assert.equal((await redeem(token, "balanced")).status, 200);
  assert.equal((await redeem(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, "balanced")).status, 400);
  assert.equal((await redeem(token, "wrong-plan")).status, 400);
  assert.equal((await redeem(encodeState({ ...state, fingerprint: "obsolete" }, stateKey), "balanced")).status, 409);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 61 * 60 * 1000);
  assert.equal((await redeem(token, "balanced")).status, 400);
});

test("handoff links require a deployed HTTPS site, never localhost", () => {
  assert.equal(publicSiteOrigin(), "https://econplanner-preview.vercel.app");
  const previous = process.env.ECONPLANNER_PUBLIC_URL;
  try {
    process.env.ECONPLANNER_PUBLIC_URL = "http://localhost:3000";
    assert.equal(publicSiteOrigin(), null);
    assert.throws(() => openInEconPlannerUrl("token", "balanced"));
  } finally {
    if (previous === undefined) delete process.env.ECONPLANNER_PUBLIC_URL;
    else process.env.ECONPLANNER_PUBLIC_URL = previous;
  }
});
