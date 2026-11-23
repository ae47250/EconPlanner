import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { POST } from "../app/api/majors/map/route.js";
import { buildAcceleratedPlanningResult } from "../lib/planning/acceleratedResult.js";
import { independentlyProvenRequiredOffering } from "../lib/planning/completion-blockers.js";
import { resolvePlanningContext } from "../lib/planning/horizon.js";
import { buildEconomicsPlanResult } from "../lib/planning/noPlanResult.js";
import { runtimePolicyBundle } from "../lib/policy/compat-normalized.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";

const panel = JSON.parse(await readFile(new URL("./panel/students.json", import.meta.url), "utf8"));

function student40() {
  const profile = panel.students.find(student => student.id === "40");
  return {
    displayName: "Panel Student 40",
    academicStanding: profile.standing,
    planningPace: "standard",
    planCreationDate: profile.planDate || "2026-11-22",
    planCreationDateEdited: true,
    courses: profile.courses.map(code => ({
      code, title: code, status: "completed", units: "1", grade: "", source: "manual_code", notes: ""
    }))
  };
}

test("student 40 has an independently proven required-course blocker despite unrelated partial coverage", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ student: student40() })
  }));
  assert.equal(response.status, 200);
  const data = await response.json();
  const economics = data.programs.find(program => program.economicsPlanResult);
  const result = economics.economicsPlanResult;
  assert.equal(result.category, "INFEASIBLE_PROVEN");
  assert.equal(result.conclusion, "PROVEN_INFEASIBLE");
  assert.equal(result.reason, "REQUIRED_COURSE_NO_ELIGIBLE_OFFERING");
  assert.equal(result.evidence.blockingReasons[0].course, "ECO 213");
  assert.deepEqual(result.evidence.blockingReasons[0].termEvidence.map(term => term.reasonCode), [
    "NOT_OFFERED_IN_COMPLETE_SCHEDULE", "COURSE_NOT_SUPPORTED_IN_MAY"
  ]);
  assert.ok(result.evidence.blockingReasons[0].sourceRefs.includes("OWNER-N1-INDEPENDENT-INFEASIBILITY-2026-11-23#N1"));
  assert.equal(result.evidence.blockingReasons[0].message,
    "You still need ECO 213, but no available term by May 2027 offers it. Talk with your advisor about a later graduation year.");

  const report = await buildEconomicsReportFromStudent(student40(), "2026-11-22");
  assert.equal(report.economicsPlanResult.conclusion, result.conclusion);
  const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
  const html = renderEconomicsHtml(report, template);
  assert.match(html, /data-major-completion-result="PROVEN_INFEASIBLE"/);
  assert.match(html, /You still need ECO 213, but no available term by May 2027 offers it/);
});

test("partial coverage, a possible section, or another requirement option cannot prove the obstacle", () => {
  const bundle = runtimePolicyBundle();
  const student = student40();
  const context = resolvePlanningContext(student);
  const mapping = {
    requirements: [{ id: "eco-213", kind: "exact", options: ["ECO 213"] }],
    optimistic: { unresolved: [{ requirementId: "eco-213" }] }
  };
  assert.equal(independentlyProvenRequiredOffering(mapping, context, bundle, student)?.course, "ECO 213");

  const partialWinter = structuredClone(bundle);
  partialWinter.indexes.offeringByTerm["2027-WINTER"].coverageScopes =
    partialWinter.indexes.offeringByTerm["2027-WINTER"].coverageScopes.filter(scope => scope.subject !== "ECO");
  assert.equal(independentlyProvenRequiredOffering(mapping, context, partialWinter, student), null);

  const partialMay = structuredClone(bundle);
  partialMay.indexes.offeringByTerm["2027-MAY"].coverageScopes =
    partialMay.indexes.offeringByTerm["2027-MAY"].coverageScopes.filter(scope => scope.subject !== "ECO");
  assert.equal(independentlyProvenRequiredOffering(mapping, context, partialMay, student), null);

  const offered = structuredClone(bundle);
  offered.indexes.offeringByTerm["2027-WINTER"].sections.push({
    course: "ECO 213", enrollmentState: "OPEN", sourceRefs: ["FICTIONAL-TEST-SECTION"]
  });
  assert.equal(independentlyProvenRequiredOffering(mapping, context, offered, student), null);

  const alternatives = { ...mapping, requirements: [{ id: "eco-213", kind: "choice", options: ["ECO 213", "ECO 214"] }] };
  assert.equal(independentlyProvenRequiredOffering(alternatives, context, bundle, student), null);
  const creditClaim = { ...student, courses: [...student.courses, { code: "ECO 213", status: "transfer" }] };
  assert.equal(independentlyProvenRequiredOffering(mapping, context, bundle, creditClaim), null);
  const waiverClaim = { ...student, evidenceFacts: [{ factType: "WAIVER", affectedRequirement: "eco-213",
    evidenceStatus: "REVIEW_REQUIRED" }] };
  assert.equal(independentlyProvenRequiredOffering(mapping, context, bundle, waiverClaim), null);
  const equivalencyClaim = { ...student, courses: [...student.courses,
    { code: "BUSN 200", equivalencyCode: "ECO 213", status: "uncertain" }] };
  assert.equal(independentlyProvenRequiredOffering(mapping, context, bundle, equivalencyClaim), null);

  const diagnostics = { strategyAttempts: [{ exhaustive: false, solutionFound: false }],
    searchAttempts: [{ failure: "SEARCH_INCOMPLETE" }] };
  assert.equal(buildEconomicsPlanResult({ mapping, planningContext: context, policyBundle: bundle, student,
    metricsDiagnostics: diagnostics }).category, "INFEASIBLE_PROVEN");
  assert.equal(buildEconomicsPlanResult({ mapping, planningContext: context, policyBundle: partialWinter, student,
    metricsDiagnostics: diagnostics }).category, "SEARCH_INCOMPLETE");

  const acceleratedContext = { ...context, earlyComparisonRequested: true, effectiveStanding: "junior",
    expectedGraduationTerm: "Spring/May 2028" };
  const acceleratedArgs = { planningContext: acceleratedContext, earlyGraduationContext: context,
    mapping, student, metricsDiagnostics: { strategyAttempts: [{ strategyId: "one-year-early", exhaustive: false }] } };
  assert.equal(buildAcceleratedPlanningResult({ ...acceleratedArgs, policyBundle: bundle }).status, "NOT_POSSIBLE");
  assert.equal(buildAcceleratedPlanningResult({ ...acceleratedArgs, policyBundle: partialWinter }).status, "MORE_INFORMATION_NEEDED");
});
