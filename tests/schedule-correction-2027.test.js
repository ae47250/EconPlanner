import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POST } from "../app/api/majors/map/route.js";
import { runtimePolicyBundle, runtimeEconomicsSchedule } from "../lib/policy/compat-normalized.js";
import { evaluateTermLoad, evaluateOffering } from "../lib/decision-engine/placement.js";
import { meetingsConflict, normalizeEconomicsSchedule } from "../lib/planning/scheduleProvider.js";
import { termLoadTuitionAdvisories } from "../lib/policy/term-load.js";
import { electiveCompletionBlockers } from "../lib/planning/completion-blockers.js";
import { scheduleCoverageForCourse } from "../lib/policy/schedule-coverage.js";
import { evaluateRequirementAllocation } from "../lib/decision-engine/requirements.js";
import { buildAcceleratedPlanningResult } from "../lib/planning/acceleratedResult.js";
import { buildEconomicsPlanResult } from "../lib/planning/noPlanResult.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { loadCanonicalPolicy, oracleEvaluateTermLoad, oracleEvaluateOffering, oracleEvaluateCanonicalPlan } from "./oracle/load-canonical-policy.js";

const bundle = runtimePolicyBundle();
const approval = {advisorApproval: "APPROVED", academicProbationStatus: "NOT_ON_ACADEMIC_PROBATION"};
const history = ["ECO 113", "ECO 114", "ECO 161", "ECO 213", "ECO 214", "ECO 221", "MAT 113", "MAT 217"];
const studentFor = (standing, overload) => ({academicStanding: standing, planningPace: standing === "junior" ? "one_year_early" : "standard", planCreationDate: "2026-09-27", courses: history.map(code => ({code, status: "completed", units: 1, source: "manual_code"})), termLoadOverrides: overload ? {"winter-2027": approval, "spring-2027": approval} : {}});

for (const standing of ["junior", "senior"]) for (const overload of [false, true]) test(`${standing} May 2027 proof with approved overload=${overload}`, async () => {
  const student = studentFor(standing, overload);
  const response = await POST(new Request("http://localhost/api/majors/map", {method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({student})}));
  assert.equal(response.status, 200);
  const data = await response.json();
  const economics = data.programs.find(item => item.economicsPlanResult);
  assert.ok(economics);
  const result = standing === "junior" ? economics.economicsAcceleratedResult : economics.economicsPlanResult;
  const reasons = result.evidence.blockingReasons;
  assert.equal(reasons.length, 1, JSON.stringify(result));
  assert.match(reasons[0].message, /two|2/);
  assert.match(reasons[0].message, /ECO 222, ECO 224, ECO 234/);
  assert.match(reasons[0].message, /You can take only one/);
  assert.match(reasons[0].message, /ECO 222 and ECO 234/);
  assert.match(reasons[0].message, /ECO 321 counts only for Finance, never as an Economics elective\./);
  assert.equal(reasons[0].financeAllocation.course, "ECO 321");
  assert.deepEqual([...reasons[0].satisfiedElectives].sort(), ["ECO 161", "ECO 221"]);
  assert.deepEqual(reasons[0].remainingWinterElectives, []);
  const busn = reasons[0].financeAllocation.alternatives.find(option => option.course === "BUSN 323");
  assert.equal(busn.terms.find(term => term.termId === "2027-WINTER").reasonCode, "NOT_OFFERED_IN_COMPLETE_SCHEDULE");
  assert.ok(busn.terms.find(term => term.termId === "2027-WINTER").sourceRefs.includes("OWNER-BUSN323-2026-2027-2026-09-28"));
  assert.equal(evaluateRequirementAllocation("ECO 321", "finance", null, bundle).status, "ALLOW");
  assert.equal(evaluateRequirementAllocation("ECO 321", "eco-elective-3", null, bundle, {assignments:[{slotId:"finance",code:"ECO 321"}]}).reasonCode, "ECO_321_FINANCE_ONLY");
  assert.equal(standing === "junior" ? result.status : result.conclusion, standing === "junior" ? "NOT_POSSIBLE" : "PROVEN_INFEASIBLE");
  const targetAttempts = result.evidence.strategyAttempts.filter(item => standing === "senior" || item.strategyId === "one-year-early");
  assert.equal(targetAttempts.length, 4);
  assert.ok(targetAttempts.every(item => item.exhaustive));
  assert.ok(targetAttempts.every(item => item.complete && item.terminationReason === "EXHAUSTED" && !item.solutionFound));
  assert.ok(targetAttempts.every(item => item.nodesVisited === 16 && item.finalValidSchedules === 0));
  assert.ok(targetAttempts.every(item => item.rawSolutionsByStage.every(stage => stage.terminationReason === "EXHAUSTED" && stage.rawSolutionsEncountered === 0)));
  if (standing === "junior") {
    assert.equal(result.effectiveStanding, "junior");
    assert.equal(result.acceleratedTarget, "Spring/May 2027");
    assert.equal(result.standardTarget, "Spring/May 2028");
  }
  const report = await buildEconomicsReportFromStudent(student, "2026-09-27");
  const reportResult = standing === "junior" ? report.acceleratedPlanningResult : report.economicsPlanResult;
  assert.equal(reportResult.evidence.blockingReasons[0].message, reasons[0].message);
  const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
  assert.ok(renderEconomicsHtml(report, template).includes(reasons[0].message));
});

test("complete Winter has no distinct elective after allocating finance; corrected May pairs are checked", () => {
  const schedule = normalizeEconomicsSchedule(runtimeEconomicsSchedule());
  const spring = schedule.terms.May.filter(section => section.course.startsWith("ECO"));
  const byCode = code => spring.find(section => section.course === code);
  assert.equal(meetingsConflict(byCode("ECO 222"), byCode("ECO 234")), true);
  assert.equal(meetingsConflict(byCode("ECO 224"), byCode("ECO 222")), false);
  assert.equal(meetingsConflict(byCode("ECO 224"), byCode("ECO 234")), false);
  for (let left = 0; left < spring.length; left++) for (let right = left + 1; right < spring.length; right++) {
    assert.equal(evaluateTermLoad({termKey: "May", courses: [spring[left], spring[right]], termLoadEvidence: approval}, {}, bundle).reasonCode, "TERM_CAPACITY_EXCEEDED");
  }
  assert.ok(bundle.indexes.coursesByCode["ECO 260"]);
});

test("unit boundaries and approval evidence agree with the independent evaluator", async () => {
  const oracle = await loadCanonicalPolicy();
  for (const [termKey, normal, ceiling] of [["Fall", 4, 5.25], ["Winter", 4, 5.25], ["May", 1, 1.25]]) {
    for (const [units, evidence, status, reason] of [[normal, null, "ALLOW", "TERM_CAPACITY_AVAILABLE"], [normal + .25, null, "UNKNOWN", "TERM_OVERLOAD_EVIDENCE_REQUIRED"], [ceiling, approval, "CONDITIONAL", "TERM_OVERLOAD_APPROVED"], [ceiling + .01, approval, "BLOCK", "TERM_CAPACITY_EXCEEDED"], [normal + .25, {...approval, academicProbationStatus: "ON_ACADEMIC_PROBATION"}, "BLOCK", "TERM_OVERLOAD_NOT_ALLOWED_ON_ACADEMIC_PROBATION"]]) {
      const term = {termKey, courses: [{course: "MAT 217", units}], termLoadEvidence: evidence};
      const actual = evaluateTermLoad(term, {}, bundle);
      assert.equal(actual.status, status);
      assert.equal(actual.reasonCode, reason);
      assert.equal(oracleEvaluateTermLoad(oracle, term).reasonCode, reason);
    }
  }
  const notices = termLoadTuitionAdvisories([{academicYear: "2026/2027",termKey:"Winter", courses:[{units:5}]}, {academicYear:"2026/2027",termKey:"May", courses:[{units:1}]}], bundle);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].modeledUnits, 6);
  assert.equal(notices[0].thresholdExclusive, 5.5);
  assert.equal(notices[0].blocking, false);
  assert.equal(notices[0].message, "This plan totals 6 courses in Winter and May. More than 5.5 may add tuition. Ask the Business Office.");
});

test("incomplete schedule or search cannot support the specific proof", () => {
  const context = {earlyComparisonRequested:true,effectiveStanding:"junior",expectedGraduationTerm:"Spring/May 2028"};
  const partial = structuredClone(bundle);
  for (const term of Object.values(partial.indexes.offeringByTerm)) term.coverageScopes = [];
  const result = buildAcceleratedPlanningResult({planningContext: context, earlyGraduationContext: {expectedGraduationTerm:"Spring/May 2027"},policyBundle:partial,metricsDiagnostics:{strategyAttempts:[{strategyId:"one-year-early",exhaustive:true}]}});
  assert.equal(result.status,"MORE_INFORMATION_NEEDED");
  assert.deepEqual(electiveCompletionBlockers({policyBundle:partial}), []);
});

test("owner confirmation is restricted to BUSN 323 Fall 2026 / Winter 2027; global coverage grants no authority", async () => {
  const oracle = await loadCanonicalPolicy();
  const scope = bundle.provenance.sources.find(source => source.sourceId === "OWNER-BUSN323-2026-2027-2026-09-28");
  assert.equal(scope.authorityBoundary, "BUSN 323 / 2026–27 / Fall offered / Winter not offered");
  assert.equal(scope.confirmedOn, "2026-09-28");
  assert.equal(scope.academicYear, "2026-2027");
  const course = {course:"BUSN 323",source:"verified-offering"};
  for (const termKey of ["Fall", "Winter"]) {
    const term = {academicYear:"2026/2027",termKey};
    const actual = evaluateOffering(course, term, bundle.indexes.offeringByTerm, bundle);
    assert.equal(actual.status, termKey === "Fall" ? "REVIEW_REQUIRED" : "BLOCK");
    assert.equal(oracleEvaluateOffering(oracle, course, term).status, termKey === "Fall" ? "REVIEW_REQUIRED" : "BLOCK");
    if (termKey === "Fall") assert.equal(actual.offeringEvidence.offeringExistence, "OFFERED");
  }
  assert.equal(evaluateOffering(course, {academicYear:"2027/2028",termKey:"Winter"}, bundle.indexes.offeringByTerm, bundle).reasonCode, "SCHEDULE_TERM_NOT_COVERED");
  assert.equal(oracleEvaluateOffering(oracle, course, {academicYear:"2027/2028",termKey:"Winter"}).status, "UNKNOWN");
  for (const code of ["BUSN 324", "MAT 143"]) {
    const term = {academicYear:"2026/2027",termKey:"Winter"};
    assert.equal(evaluateOffering({course:code,source:"verified-offering"}, term, bundle.indexes.offeringByTerm, bundle).status, "UNKNOWN");
    assert.equal(oracleEvaluateOffering(oracle, {course:code,source:"verified-offering"}, term).status, "UNKNOWN");
  }
  assert.equal(scheduleCoverageForCourse(bundle.indexes.offeringByTerm["2027-MAY"], "BUSN 323").coverage, "UNKNOWN");
  const unscoped = structuredClone(bundle);
  unscoped.indexes.offeringByTerm["2027-WINTER"].coverage = "COMPLETE";
  unscoped.indexes.offeringByTerm["2027-WINTER"].coverageScopes = [];
  assert.equal(evaluateOffering(course, {academicYear:"2026/2027",termKey:"Winter"}, unscoped.indexes.offeringByTerm, unscoped).status, "UNKNOWN");
  const unscopedOracle = structuredClone(oracle);
  unscopedOracle.schedule.terms.find(term => term.termId === "2027-WINTER").coverage = "COMPLETE";
  unscopedOracle.schedule.terms.find(term => term.termId === "2027-WINTER").coverageScopes = [];
  assert.equal(oracleEvaluateOffering(unscopedOracle, course, {academicYear:"2026/2027",termKey:"Winter"}).status, "UNKNOWN");
  const claimed = {course:"MAT 217",section:"UNREVIEWED",source:"verified-offering"};
  assert.equal(evaluateOffering(claimed, {academicYear:"2026/2027",termKey:"Winter"}, bundle.indexes.offeringByTerm, bundle).reasonCode,"VERIFIED_SECTION_NOT_IN_ACTIVE_SCHEDULE");
  assert.equal(oracleEvaluateOffering(oracle, claimed, {academicYear:"2026/2027",termKey:"Winter"}).reasonCode,"VERIFIED_SECTION_NOT_IN_ACTIVE_SCHEDULE");
});

test("removing only Winter BUSN 323 confirmation or exhausting the search budget preserves uncertainty", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({student:studentFor("junior", false)})}));
  const data = await response.json();
  const economics = data.programs.find(item => item.economicsPlanResult);
  const args = {student:studentFor("junior",false),mapping:economics,planningContext:economics.planningContext,earlyGraduationContext:economics.earlyGraduationContext,policyBundle:bundle,metricsDiagnostics:{strategyAttempts:[{strategyId:"one-year-early",exhaustive:true}]}};
  const partial = structuredClone(bundle);
  partial.indexes.offeringByTerm["2027-WINTER"].coverageScopes = partial.indexes.offeringByTerm["2027-WINTER"].coverageScopes.filter(scope => scope.course !== "BUSN 323");
  const uncertain = buildAcceleratedPlanningResult({...args, policyBundle:partial});
  assert.equal(uncertain.status,"MORE_INFORMATION_NEEDED");
  assert.deepEqual(uncertain.evidence.blockingReasons,[]);
  const incomplete = buildAcceleratedPlanningResult({...args,metricsDiagnostics:{strategyAttempts:[{strategyId:"one-year-early",exhaustive:false}]}});
  assert.equal(incomplete.status,"MORE_INFORMATION_NEEDED");
  assert.deepEqual(incomplete.evidence.blockingReasons,[]);
  const senior = buildEconomicsPlanResult({...args,planningContext:args.earlyGraduationContext,policyBundle:partial});
  assert.equal(senior.conclusion,"UNKNOWN");
  assert.equal(senior.reason,"MISSING_OFFERING");
});

test("the proposed Winter finance/capstone/elective combination is rejected for exact offering evidence", async () => {
  const oracle = await loadCanonicalPolicy();
  const winter = {termKey: "Winter", academicYear: "2026/2027"};
  const sections = bundle.indexes.offeringByTerm["2027-WINTER"].sections;
  const finance = sections.find(section => section.course === "ECO 321");
  const capstone = sections.find(section => section.course === "ECO 461");
  assert.equal(evaluateOffering({course: finance.course, source:"verified-offering"}, winter, bundle.indexes.offeringByTerm, bundle).status, "ALLOW");
  assert.equal(evaluateOffering({course: capstone.course, source:"verified-offering"}, winter, bundle.indexes.offeringByTerm, bundle).status, "ALLOW");
  assert.equal(evaluateTermLoad({...winter,courses:[finance, capstone, {course:"ECO elective", units:1}]}, {}, bundle).status, "ALLOW");
  assert.equal(meetingsConflict(normalizeEconomicsSchedule(runtimeEconomicsSchedule()).terms.Winter.find(row => row.course === finance.course), normalizeEconomicsSchedule(runtimeEconomicsSchedule()).terms.Winter.find(row => row.course === capstone.course)), false);
  for (const section of bundle.indexes.offeringByTerm["2027-MAY"].sections.filter(row => row.course.startsWith("ECO"))) {
    for (const code of [section.course, ...(section.crossListedAs || [])]) {
      const course = {course: code, source:"verified-offering"};
      assert.equal(evaluateOffering(course, winter, bundle.indexes.offeringByTerm, bundle).reasonCode, "NOT_OFFERED_IN_COMPLETE_SCHEDULE");
      assert.equal(oracleEvaluateOffering(oracle, course, winter).reasonCode, "NOT_OFFERED_IN_COMPLETE_SCHEDULE");
    }
  }
});

test("approved Winter overload, move blockers and server validation use the same recorded units", async () => {
  const student = {academicStanding:"senior",planCreationDate:"2026-09-27",courses:["ECO 113","ECO 114","ECO 213","ECO 214","MAT 113","MAT 217","BUSN 323","ECO 260","ECO 234"].map(code=>({code,status:"completed",units:1,source:"manual_code"})),reservedCourseUnits:{"winter-2027":2,"spring-2027":1},termLoadOverrides:{"winter-2027":approval}};
  const request = payload => POST(new Request("http://localhost/api/majors/map",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}));
  const response = await request({student});
  assert.equal(response.status,200);
  const data = await response.json();
  const economics = data.programs.find(item=>item.economicsPlans);
  const plan = economics.economicsPlans[0];
  assert.ok(plan, JSON.stringify(economics.economicsPlanResult));
  assert.equal(plan.validation.valid,true);
  assert.ok(plan.validation.warnings.includes("Winter 2027 has 3 Economics courses. The department recommends no more than 2. This term uses an approved overload."));
  assert.ok(plan.validation.conditions.some(item=>item.reasonCode==="TERM_OVERLOAD_APPROVED" && item.message.includes("Winter 2027 has 3 courses plus room for 2 more. The normal limit is 4.")));
  assert.equal(plan.validation.tuitionAdvisories[0].modeledUnits,6);
  const winter = plan.terms.find(term=>term.slotId==="winter-2027");
  const course = winter.courses.find(course=>course.course==="ECO 161");
  const move = course.moveDestinationOptions.find(option=>option.id==="spring-2027");
  assert.equal(move.status,"BLOCKED");
  assert.equal(move.loadDecision.reasonCode,"TERM_CAPACITY_EXCEEDED");
  assert.match(move.message,/not listed|not eligible|verified/);
  assert.match(move.message,/approved course limit/);
  const rejected = await request({action:"validate-plan",student,plan,plans:economics.economicsPlans,edit:{type:"move",planId:plan.id,fromTermId:winter.slotId,toTermId:"spring-2027",courseId:course.requirementId}});
  assert.equal(rejected.status,422);
  const oracle = await loadCanonicalPolicy();
  const audited = oracleEvaluateCanonicalPlan(oracle, student, plan, economics.planningContext);
  assert.equal(audited.valid, true, JSON.stringify(audited));
  assert.equal(oracleEvaluateCanonicalPlan(oracle, {...student, termLoadOverrides:{}}, plan, economics.planningContext).valid, false);
  const report = await buildEconomicsReportFromStudent(student, "2026-09-27", plan, economics.economicsPlans);
  assert.deepEqual(report.tuitionAdvisories, plan.validation.tuitionAdvisories);
  const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
  assert.ok(renderEconomicsHtml(report, template).includes(report.tuitionAdvisories[0].message));
  const missing = await request({student:{...student,termLoadOverrides:{}}});
  const missingData = await missing.json();
  assert.equal(missingData.programs.find(item=>item.economicsPlans).economicsPlans.length,0);
});
