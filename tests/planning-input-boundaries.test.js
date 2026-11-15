import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadPlannerFingerprint } from "../lib/planning/fingerprint.js";
import { loadPolicyBundle } from "../lib/policy/load-bundle.js";
import { POST, GET } from "../app/api/majors/map/route.js";
import { handleEconomicsReportRequest } from "../app/api/reports/economics/route.js";
import { buildPlanningSlots, isValidPlanningDate, MAX_STUDENT_COURSE_RECORDS, normalizeStanding, resolvePlanningContext, validatePlanningInputs, validateStudentCourseHistoryLimit } from "../lib/planning/horizon.js";

const student = { majorDeclarationCatalogYear: "2025-2026", academicStanding: "freshman", planCreationDate: "2026-09-23", courses: [] };
const reportStudentFixture = JSON.parse(await readFile(new URL("./fixtures/economics-report-student.json", import.meta.url), "utf8")).student;
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
  const response = await handleEconomicsReportRequest(request({ student: { majorDeclarationCatalogYear: "2025-2026", academicStanding: "freshman", courses: [] }, preparedDate: "2026-09-23", format: "json" }));
  assert.equal(response.status, 200);
});

test("100 course records reach all local routes and 101 are rejected without truncation", async () => {
  const baseStudent = { ...reportStudentFixture, academicStanding: "freshman", planCreationDate: "2026-09-23" };
  const history = [...baseStudent.courses];
  const repeatedStatuses = ["repeated", "failed", "withdrawn"];
  for (let index = 0; index < 96; index += 1) {
    history.push({
      code: baseStudent.courses[index % baseStudent.courses.length].code,
      status: repeatedStatuses[index % repeatedStatuses.length],
      units: 1,
      source: "manual_code",
      attemptNumber: index + 1
    });
  }
  const atLimit = { ...baseStudent, courses: history.slice(0, MAX_STUDENT_COURSE_RECORDS) };
  const overLimit = { ...baseStudent, courses: history.slice(0, MAX_STUDENT_COURSE_RECORDS + 1) };
  assert.equal(atLimit.courses.length, 100);
  assert.equal(overLimit.courses.length, 101);
  assert.equal(validateStudentCourseHistoryLimit(atLimit).valid, true);
  assert.deepEqual(
    (({ valid, count, limit }) => ({ valid, count, limit }))(validateStudentCourseHistoryLimit(overLimit)),
    { valid: false, count: 101, limit: 100 }
  );

  const generatedResponse = await POST(request({ student: atLimit }));
  const generated = await generatedResponse.json();
  assert.equal(generatedResponse.status, 200, JSON.stringify(generated));
  assert.ok(Array.isArray(generated.programs));
  const economics = generated.programs.find(program => program.program?.id === "economics-base");
  assert.ok(economics);
  const plan = economics.economicsPlans[0];
  assert.ok(plan);

  const validatedResponse = await POST(request({ student: atLimit, action: "validate-plan", plan, plans: economics.economicsPlans }));
  const validated = await validatedResponse.json();
  assert.equal(validatedResponse.status, 200, JSON.stringify(validated));
  assert.equal(validated.plan.validation.valid, true);

  const reportAtLimit = await handleEconomicsReportRequest(request({ student: atLimit, preparedDate: "2026-10-31", format: "json" }));
  const report = await reportAtLimit.json();
  assert.equal(reportAtLimit.status, 200, JSON.stringify(report));
  assert.equal(report.schemaVersion, "econmapper-economics-report-v1");

  for (const [route, run] of [
    ["map-generation", () => POST(request({ student: overLimit }))],
    ["map-plan-validation", () => POST(request({ student: overLimit, action: "validate-plan", plan, plans: economics.economicsPlans }))],
    ["report-json", () => handleEconomicsReportRequest(request({ student: overLimit, preparedDate: "2026-10-31", format: "json" }))]
  ]) {
    const response = await run();
    const error = await response.json();
    assert.equal(response.status, 413, route);
    assert.deepEqual({ code: error.code, field: error.field, count: error.count, limit: error.limit }, {
      code: "COURSE_HISTORY_LIMIT_EXCEEDED", field: "courses", count: 101, limit: 100
    }, route);
    assert.match(error.error, /101 course history records/, route);
    assert.equal(error.programs, undefined, `${route} must not process a truncated history`);
  }
});

test("a larger legitimate-style history with repeats, transfer, and supporting courses reaches planning", async () => {
  const courses = Array.from({ length: 40 }, (_, index) => ({
    code: ["ECO 113", "MAT 113", "ECO 114", "ECO 213"][index % 4],
    status: index % 4 === 3 ? "repeated" : index === 1 ? "transfer" : "completed",
    academicYear: `${2016 + Math.floor(index / 4)}/${2017 + Math.floor(index / 4)}`,
    termKey: ["Fall", "Winter", "Spring", "May"][index % 4],
    ...(index === 1 ? { source: "transfer_equivalency" } : {})
  }));
  const response = await POST(request({ student: { ...student, courses } }));
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.ok(data.programs.some(program => program.program?.id === "economics-base"));
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
