import test from "node:test";
import assert from "node:assert/strict";
import { loadPlannerFingerprint } from "../lib/planning/fingerprint.js";
import { loadPolicyBundle } from "../lib/policy/load-bundle.js";
import { POST, GET } from "../app/api/majors/map/route.js";
import { handleEconomicsReportRequest } from "../app/api/reports/economics/route.js";
import { buildPlanningSlots, isValidPlanningDate, normalizeStanding, resolvePlanningContext, validatePlanningInputs } from "../lib/planning/horizon.js";

const student = { academicStanding: "freshman", planCreationDate: "2026-09-23", courses: [] };
const request = body => new Request("http://localhost/api/local-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("calendar validation checks real Gregorian dates without host-clock substitution", () => {
  for (const value of ["not-a-date", "2026-02-30", "2026-13-01", "2026-00-01", "2026-01-00", "2026-04-31", "2026-02-29", "1900-02-29", "0000-01-01", "2026-1-1", " 2026-01-01", 20260101, {}]) {
    assert.equal(isValidPlanningDate(value), false, JSON.stringify(value));
    const context = resolvePlanningContext({ ...student, planCreationDate: value });
    assert.equal(context.planningValidation.valid, false);
    assert.equal(context.startYear, null);
    assert.deepEqual(buildPlanningSlots(context), []);
  }
  for (const value of ["2024-02-29", "2000-02-29", "2026-02-28", "2026-12-31", "2027-01-01"]) {
    assert.equal(isValidPlanningDate(value), true, value);
    assert.equal(resolvePlanningContext({ ...student, planCreationDate: value }).planCreationDate, value);
  }
  const optional = resolvePlanningContext({}, new Date(2026, 8, 23));
  assert.equal(optional.planCreationDate, "2026-09-23");
  assert.equal(optional.effectiveStanding, "freshman");
  assert.equal(validatePlanningInputs({}).valid, true);
  assert.throws(() => normalizeStanding("doctoral"), error => error.code === "INVALID_PLANNING_INPUT");
});

test("generation, edit and report requests block malformed input with structured input errors", async () => {
  const ready = await POST(request({ student }));
  const generated = await ready.json();
  const plan = generated.programs.find(item => item.program.id === "economics-base").economicsPlans[0];
  assert.ok(plan);
  for (const override of [
    ...["not-a-date", "2026-02-30", "2026-13-01"].map(planCreationDate => ({ planCreationDate })),
    { academicStanding: "doctoral" }
  ]) {
    const malformed = { ...student, ...override };
    const requests = [
      () => POST(request({ student: malformed })),
      () => POST(request({ student: malformed, action: "validate-plan", plan })),
      ...["json", "html", "pdf"].map(format => () => handleEconomicsReportRequest(request({ student: malformed, selectedPlan: plan, format }), {
        fetchImpl: () => { throw new Error("No application transport is allowed in this test."); }
      }))
    ];
    for (const run of requests) {
      const response = await run();
      const data = await response.json();
      assert.equal(response.status, 422, JSON.stringify(data));
      assert.equal(data.code, "INVALID_PLANNING_INPUT");
      assert.equal(data.economicsPlanResult.category, "INPUT_BLOCKED");
      assert.equal(data.inputResolution.planningMustRemainBlocked, true);
      assert.equal(data.issues[0].field, Object.keys(override)[0]);
      assert.ok(data.issues[0].message);
      assert.equal(data.planningContext, undefined, "No synthetic valid context may accompany an invalid input");
    }
  }
  const prepared = await handleEconomicsReportRequest(request({ student, preparedDate: "2026-02-30", format: "json" }));
  assert.equal(prepared.status, 422);
  assert.equal((await prepared.json()).issues[0].field, "preparedDate");
});

test("supported standings, leap day, optional standing and report date defaults still work", async () => {
  for (const standing of ["freshman", "sophomore", "junior", "senior", " Junior ", undefined]) {
    const input = { ...student, academicStanding: standing, planCreationDate: "2028-02-29" };
    const response = await POST(request({ student: input }));
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    const context = data.programs.find(item => item.program.id === "economics-base").planningContext;
    assert.equal(context.planCreationDate, "2028-02-29");
    assert.equal(context.effectiveStanding, standing?.trim().toLowerCase() || "freshman");
  }
  const response = await handleEconomicsReportRequest(request({ student: { academicStanding: "freshman", courses: [] }, preparedDate: "2026-09-23", format: "json" }));
  assert.equal(response.status, 200);
});

test("current fingerprint and generated plans identify the same policy/schedule context", async () => {
  const current = await GET();
  const { plannerFingerprint } = await current.json();
  assert.match(plannerFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(current.headers.get("cache-control"), "no-store");
  const data = await (await POST(request({ student }))).json();
  assert.equal(data.plannerFingerprint, plannerFingerprint);
  const bundle = await loadPolicyBundle();
  assert.equal(await loadPlannerFingerprint(bundle), plannerFingerprint);
  assert.notEqual(await loadPlannerFingerprint({ ...bundle, contentHash: "sha256:earlier-policy-or-schedule" }), plannerFingerprint);
});
