import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POST } from "../app/api/majors/map/route.js";
import { POST as reportPost } from "../app/api/reports/economics/route.js";
import { runtimePolicyBundle, runtimeEconomicsSchedule } from "../lib/policy/compat-normalized.js";
import { evaluateTermLoad } from "../lib/decision-engine/placement.js";
import { evaluatePlan } from "../lib/decision-engine/plan.js";
import { normalizeStudentFacts } from "../lib/decision-engine/student-facts.js";
import { buildPrerequisiteFollowUp, unansweredPrerequisiteQuestions } from "../lib/planning/prerequisiteFormValidation.js";
import { normalizeEconomicsSchedule, meetingsConflict } from "../lib/planning/scheduleProvider.js";
import { validateGeneratedPlan, annotateEconomicsPlanChoices } from "../lib/planning/economics.js";
import { resolvePlanningContext } from "../lib/planning/horizon.js";
import { loadCatalog } from "../lib/catalog/load.js";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { loadCanonicalPolicy, oracleEvaluateTermLoad, oracleEvaluateCanonicalPlan } from "./oracle/load-canonical-policy.js";

const bundle = runtimePolicyBundle();
const catalog = await loadCatalog("2025-2026");
const prerequisites = catalog.prerequisitesByProgram.get("economics");
const oracle = await loadCanonicalPolicy();
const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
const approval = {advisorApproval:"APPROVED", academicProbationStatus:"NOT_ON_ACADEMIC_PROBATION"};
const completed = codes => codes.map(code => ({code, status:"completed", units:1, source:"manual_code"}));
const post = async payload => {
  const response = await POST(new Request("http://localhost/api/majors/map", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}));
  return {response, data:await response.json()};
};
const economics = data => data.programs.find(item => item.program.id === "economics-base");
const mappingFor = student => mapStudentToProgram(catalog.programs.find(item => item.id === "economics"), catalog.requirementsByProgram.get("economics"), student, {policyBundle:bundle});

for (const dependent of ["ECO 213", "ECO 214"]) for (const math of ["MAT 113", "MAT 121"]) test(`${dependent} form gate accepts only ${math} Taking now as its math alternative`, () => {
  const rule = prerequisites[dependent];
  const courses = [...completed(rule.all), {code:math,status:"in_progress"}];
  for (const targetStatus of ["completed", "in_progress"]) {
    const followUp = buildPrerequisiteFollowUp({course:dependent,targetStatus,courses,prerequisites});
    assert.deepEqual(unansweredPrerequisiteQuestions(followUp), []);
    assert.ok(!courses.some(course => course.code === (math === "MAT 113" ? "MAT 121" : "MAT 113")));
  }
});

test("whole-plan production and independent Oracle enforce Taking now chronology on every prerequisite edge", () => {
  let checked = 0;
  for (const [dependent, rule] of Object.entries(prerequisites)) {
    const ruleId = bundle.rules.find(item => item.ruleType === "coursePrerequisite" && item.condition.course === dependent).ruleId;
    const edges = [...rule.all.map(code => ({code,kind:"all"})), ...rule.any.flatMap((group,index) => group.map(code => ({code,kind:"any",index})))];
    for (const edge of edges) {
      const baseline = [...rule.all.filter(code => code !== edge.code), ...rule.any.flatMap((group,index) => edge.kind === "any" && edge.index === index ? [] : [group[0]])];
      const student = {academicStanding:"senior",planCreationDate:"2027-01-11",courses:[...completed(baseline),{code:edge.code,status:"in_progress"}]};
      for (const [termKey, academicYear, expected] of [["Fall","2026/2027",false],["Winter","2026/2027",false],["Fall","2027/2028",true]]) {
        const term = {termKey,academicYear,slotId:`${termKey.toLowerCase()}-${termKey === "Winter" ? 2027 : Number(academicYear.slice(0,4))}`,courses:[{course:dependent,source:"projected-offering",requirementId:"prerequisite-probe"}]};
        const actual = evaluatePlan({terms:[term]}, normalizeStudentFacts(student,bundle), {}, bundle).decisions.find(decision => decision.ruleIds.includes(ruleId) && decision.reasonCode !== "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW");
        const audited = oracleEvaluateCanonicalPlan(oracle,student,{terms:[term]}).findings.find(decision => decision.ruleIds.includes(ruleId));
        assert.ok(actual, `${dependent}/${edge.code}`);
        assert.equal((actual.messageParams.missing || []).filter(code => code !== "DEPARTMENT_PERMISSION").length === 0, expected, `${dependent}/${edge.code}/${termKey}/${academicYear}`);
        assert.equal(audited.status === "ALLOW", expected, `${dependent}/${edge.code}/${termKey}/${academicYear}: Oracle`);
        const finished = {...student,courses:[...completed(baseline),...completed([edge.code])]};
        const completedDecision = evaluatePlan({terms:[term]},normalizeStudentFacts(finished,bundle),{},bundle).decisions.find(decision => decision.ruleIds.includes(ruleId) && decision.reasonCode !== "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW");
        assert.equal((completedDecision.messageParams.missing || []).filter(code => code !== "DEPARTMENT_PERMISSION").length,0,`${dependent}/${edge.code}: completed`);
        assert.equal(oracleEvaluateCanonicalPlan(oracle,finished,{terms:[term]}).findings.find(decision => decision.ruleIds.includes(ruleId)).status,"ALLOW");
      }
      checked++;
    }
  }
  assert.equal(checked, 36);
});

for (const math of ["MAT 113","MAT 121"]) test(`${math} Taking now supports later generation, allocation, move validation and report evidence`, async () => {
  const student = {academicStanding:"freshman",planCreationDate:"2026-08-24",courses:[...completed(["ECO 113","ECO 114"]), {code:math,status:"in_progress",units:1}],scheduleSetByTerm:{"fall-2026":true}};
  const generated = await post({student});
  assert.equal(generated.response.status,200);
  const mapped = economics(generated.data);
  const plan = mapped.economicsPlans[0];
  assert.ok(plan);
  for (const dependent of ["ECO 213","ECO 214"]) {
    const from = plan.terms.find(term => term.courses.some(course => course.course === dependent));
    const course = from.courses.find(course => course.course === dependent);
    assert.notEqual(from.slotId,"fall-2026");
    assert.equal(course.moveDestinationOptions.find(option => option.id === "fall-2026").status,"BLOCKED");
    const edited = await post({action:"validate-plan",student,plan,plans:[plan],edit:{type:"move",fromTermId:from.slotId,toTermId:"fall-2026",courseId:course.requirementId}});
    assert.equal(edited.response.status,422);
  }
  assert.equal(oracleEvaluateCanonicalPlan(oracle,student,plan,mapped.planningContext).valid,true);
  const report = await buildEconomicsReportFromStudent(student,student.planCreationDate,plan,[plan]);
  assert.equal(report.selectedPlan.validation.valid,true);
  assert.equal(report.terms.find(term => term.slotId === "fall-2026").courses.find(course => course.code === math).fixedInProgress,true);
  assert.ok(renderEconomicsHtml(report,template).includes(math));
});

const boundaryHistory = ["ECO 113","ECO 114","ECO 213","MAT 113","MAT 217","ECO 161","ECO 234"];
// Fictional profile: four remaining Winter courses and one May elective. The
// prior broader two-reservation fixture remains in schedule-correction-2027.
for (const standing of ["senior","junior"]) for (const reserved of [0,1]) test(`${standing} exact four Winter plus one May boundary with ${reserved} reserved Winter unit`, async () => {
  const student = {academicStanding:standing,planningPace:standing === "junior" ? "one_year_early" : "standard",planCreationDate:"2026-09-28",courses:completed(boundaryHistory),reservedCourseUnits:{"winter-2027":reserved},termLoadOverrides:reserved ? {"winter-2027":approval} : {}};
  const {response,data} = await post({student});
  assert.equal(response.status,200);
  const mapped = economics(data);
  const plan = mapped.economicsPlans.find(plan => plan.id === (standing === "junior" ? "one-year-early" : "balanced"));
  assert.ok(plan, JSON.stringify(mapped.economicsAcceleratedResult || mapped.economicsPlanResult));
  const winter = plan.terms.find(term => term.slotId === "winter-2027");
  const may = plan.terms.find(term => term.slotId === "spring-2027");
  assert.deepEqual(winter.courses.map(course => course.course).sort(), ["ECO 214","ECO 221","ECO 321","ECO 461"]);
  assert.equal(may.courses.length,1);
  assert.equal(winter.reservedCourseUnits,reserved);
  const load = plan.validation.policyDecision.decisions.find(decision => decision.subject.termId === "2027-WINTER" && decision.ruleIds.includes("CAPACITY-WINTER"));
  assert.equal(load.status,reserved ? "CONDITIONAL" : "ALLOW");
  if (reserved) assert.equal(plan.feasibilityStatus,"CONDITIONALLY_FEASIBLE");
  assert.equal(load.messageParams.courseUnits,4 + reserved);
  assert.equal(oracleEvaluateCanonicalPlan(oracle,student,plan,plan.planningContext || mapped.planningContext).valid,true);
  if (standing === "junior") {
    assert.equal(mapped.economicsAcceleratedResult.status,"POSSIBLE");
    assert.equal(mapped.planningContext.effectiveStanding,"junior");
    assert.equal(winter.seniorStandingBasis,"accelerated_plan_assumes_senior_standing_in_final_year");
  }
  const report = await buildEconomicsReportFromStudent(student,student.planCreationDate,plan,[plan]);
  assert.equal(report.selectedPlan.validation.policyDecision.decisions.find(decision => decision.reasonCode === load.reasonCode && decision.subject.termId === "2027-WINTER").status,load.status);
  if (reserved) assert.match(renderEconomicsHtml(report,template), /Advisor-approved overload/);
});

test("load classifications distinguish missing, partial, denied, probation, approved ceilings and tuition", () => {
  for (const [termKey,units,evidence,status,reason] of [
    ["Winter",4,null,"ALLOW","TERM_CAPACITY_AVAILABLE"],
    ["Winter",4.25,null,"UNKNOWN","TERM_OVERLOAD_EVIDENCE_REQUIRED"],
    ["Winter",4.25,{advisorApproval:"APPROVED"},"UNKNOWN","TERM_OVERLOAD_EVIDENCE_REQUIRED"],
    ["Winter",5.25,approval,"CONDITIONAL","TERM_OVERLOAD_APPROVED"],
    ["Winter",4.25,{...approval,advisorApproval:"NOT_APPROVED"},"BLOCK","TERM_OVERLOAD_APPROVAL_DENIED"],
    ["Winter",4.25,{...approval,academicProbationStatus:"ON_ACADEMIC_PROBATION"},"BLOCK","TERM_OVERLOAD_NOT_ALLOWED_ON_ACADEMIC_PROBATION"],
    ["Winter",5.26,approval,"BLOCK","TERM_CAPACITY_EXCEEDED"],
    ["May",2,approval,"BLOCK","TERM_CAPACITY_EXCEEDED"]
  ]) {
    const term = {termKey,courses:[{course:"MAT 217",units}],termLoadEvidence:evidence,tuitionPaid:true};
    const actual = evaluateTermLoad(term,{},bundle);
    assert.equal(actual.status,status);
    assert.equal(actual.reasonCode,reason);
    assert.equal(oracleEvaluateTermLoad(oracle,term).status,status);
    assert.equal(oracleEvaluateTermLoad(oracle,term).reasonCode,reason);
  }
});

test("missing overload evidence keeps normal solver capacity and returns More information needed in API and reports", async () => {
  for (const standing of ["senior","junior"]) {
    const student = {academicStanding:standing,planningPace:standing === "junior" ? "one_year_early" : "standard",planCreationDate:"2026-09-28",courses:completed(boundaryHistory),reservedCourseUnits:{"winter-2027":1}};
    const {data} = await post({student});
    const mapped = economics(data);
    const result = standing === "junior" ? mapped.economicsAcceleratedResult : mapped.economicsPlanResult;
    assert.equal(standing === "junior" ? result.status : result.conclusion,standing === "junior" ? "MORE_INFORMATION_NEEDED" : "UNKNOWN");
    if (standing === "senior") assert.equal(result.reason,"TERM_OVERLOAD_EVIDENCE_REQUIRED");
    assert.ok(!mapped.economicsPlans.some(plan => plan.terms.some(term => term.slotId === "winter-2027" && term.courses.length > 3)));
    const report = await buildEconomicsReportFromStudent(student,student.planCreationDate);
    assert.match(renderEconomicsHtml(report,template),/More information needed/);
  }
});

test("verified ECO 161-J and ECO 321-J conflict in Winter 2027 across validator, Oracle, move cards, API and reports", async () => {
  const schedule = normalizeEconomicsSchedule(runtimeEconomicsSchedule());
  const sections = ["ECO 161","ECO 321"].map(code => schedule.terms.Winter.find(section => section.course === code));
  assert.ok(sections.every(section => section.section === "J" && section.meeting.startMinutes === 740 && section.meeting.endMinutes === 845));
  assert.deepEqual(sections[0].meeting.days,["Tue","Thu"]);
  assert.deepEqual(sections[1].meeting.days,["Tue","Thu"]);
  assert.equal(meetingsConflict(...sections),true);
  const student = {academicStanding:"senior",customGraduationEnabled:true,customExpectedGraduationYear:"2028",planCreationDate:"2026-09-28",courses:completed(["ECO 113","ECO 114","ECO 213","ECO 214","MAT 113","MAT 217","BUSN 323","ECO 221","ECO 234"])};
  const {data} = await post({student});
  const mapped = economics(data);
  let plan = structuredClone(mapped.economicsPlans[0]);
  assert.ok(plan);
  // Select the two eligible electives explicitly; the solver may prefer other
  // electives. Future Winter uses a projection, never an invented section.
  const electiveIds = plan.terms.flatMap(term => term.courses).filter(course => course.requirementId.startsWith("eco-elective")).map(course => course.requirementId);
  assert.equal(electiveIds.length,2);
  for (const term of plan.terms) term.courses = term.courses.filter(course => !electiveIds.includes(course.requirementId));
  const place = (code,slotId,requirementId) => {
    const term = plan.terms.find(term => term.slotId === slotId);
    const section = schedule.terms.Winter.find(row => row.course === code);
    term.courses.push({...section,requirementId,slotId:term.slotId,source:"verified-offering",scheduleProvenance:"PUBLISHED_SCHEDULE",publicationStatus:"PUBLISHED_SCHEDULE",offeringStatus:"verified"});
  };
  place("ECO 161","winter-2027",electiveIds[0]);
  plan.terms.find(term => term.slotId === "winter-2028").courses.push({course:"ECO 321",units:1,title:bundle.indexes.coursesByCode["ECO 321"].title,requirementId:electiveIds[1],slotId:"winter-2028",source:"projected-offering",scheduleProvenance:"PLANNING_PROJECTION",publicationStatus:"PLANNING_PROJECTION",offeringStatus:"planning_projection",meeting:null,availability:null});
  const confirmed = await post({action:"validate-plan",student,plan,plans:[plan]});
  assert.equal(confirmed.response.status,200,JSON.stringify(confirmed.data));
  plan = confirmed.data.plan;
  assert.ok(plan.terms.every(term => !(term.courses.some(course => course.course === "ECO 161") && term.courses.some(course => course.course === "ECO 321"))));
  const source = plan.terms.find(term => term.slotId === "winter-2028");
  const row = source.courses.find(course => course.course === "ECO 321");
  assert.equal(row.moveDestinationOptions.find(option => option.id === "winter-2027").status,"BLOCKED");
  assert.match(row.moveDestinationOptions.find(option => option.id === "winter-2027").message,/conflict/);
  const rejected = await post({action:"validate-plan",student,plan,plans:[plan],edit:{type:"move",fromTermId:source.slotId,toTermId:"winter-2027",courseId:row.requirementId}});
  assert.equal(rejected.response.status,422);
  const forged = structuredClone(plan);
  forged.terms.find(term => term.slotId === source.slotId).courses = source.courses.filter(course => course.course !== "ECO 321");
  forged.terms.find(term => term.slotId === "winter-2027").courses.push({...sections[1],requirementId:row.requirementId,slotId:"winter-2027",source:"verified-offering",section:"J",scheduleProvenance:"PUBLISHED_SCHEDULE",publicationStatus:"PUBLISHED_SCHEDULE",offeringStatus:"verified"});
  const validation = validateGeneratedPlan(forged,{student,mapping:mappingFor(student),schedule:runtimeEconomicsSchedule(),prerequisites,context:resolvePlanningContext(student),policyBundle:bundle});
  assert.equal(validation.valid,false);
  assert.ok(validation.policyDecision.decisions.some(decision => decision.reasonCode === "AUTHORITATIVE_MEETING_CONFLICT"));
  assert.ok(oracleEvaluateCanonicalPlan(oracle,student,forged,mapped.planningContext).findings.some(decision => decision.reasonCode === "AUTHORITATIVE_MEETING_CONFLICT"));
  const invalidReport = await reportPost(new Request("http://localhost/api/reports/economics",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({student,preparedDate:student.planCreationDate,selectedPlan:forged,format:"json"})}));
  assert.equal(invalidReport.status,422);
});

test("move annotations, direct API edits and report rejection agree at every Winter overload boundary", async () => {
  const student = {academicStanding:"senior",customGraduationEnabled:true,customExpectedGraduationYear:"2028",planCreationDate:"2026-09-28",courses:completed(["ECO 113","ECO 114","ECO 213","ECO 214","MAT 113","MAT 217","BUSN 323","ECO 221","ECO 234"])};
  const generated = economics((await post({student})).data);
  const plan = structuredClone(generated.economicsPlans[0]);
  const schedule = normalizeEconomicsSchedule(runtimeEconomicsSchedule());
  const ids = plan.terms.flatMap(term => term.courses).filter(course => course.requirementId.startsWith("eco-elective")).map(course => course.requirementId);
  for (const term of plan.terms) term.courses = [];
  const place = (code,slotId,id) => {
    const term = plan.terms.find(term => term.slotId === slotId);
    const section = schedule.terms[term.termKey === "Spring" ? "May" : term.termKey].find(row => row.course === code);
    term.courses.push({...section,slotId,requirementId:id,source:"verified-offering",scheduleProvenance:"PUBLISHED_SCHEDULE",publicationStatus:"PUBLISHED_SCHEDULE",offeringStatus:"verified",...(code === "ECO 461" ? {residency:"hanover"} : {})});
  };
  place("ECO 461","winter-2027","eco-461");
  place("ECO 224","spring-2027",ids[0]);
  plan.terms.find(term => term.slotId === "winter-2028").courses.push({course:"ECO 321",units:1,requirementId:ids[1],slotId:"winter-2028",source:"projected-offering",scheduleProvenance:"PLANNING_PROJECTION",publicationStatus:"PLANNING_PROJECTION",offeringStatus:"planning_projection",meeting:null,availability:null});
  for (const [reserved,evidence,status,cardStatus,reason] of [
    [2,null,"ALLOW","ALLOWED","TERM_CAPACITY_AVAILABLE"],
    [2.25,null,"UNKNOWN","REVIEW_REQUIRED","TERM_OVERLOAD_EVIDENCE_REQUIRED"],
    [2.25,{advisorApproval:"APPROVED"},"UNKNOWN","REVIEW_REQUIRED","TERM_OVERLOAD_EVIDENCE_REQUIRED"],
    [3.25,approval,"CONDITIONAL","CONDITIONAL","TERM_OVERLOAD_APPROVED"],
    [2.25,{...approval,advisorApproval:"NOT_APPROVED"},"BLOCK","BLOCKED","TERM_OVERLOAD_APPROVAL_DENIED"],
    [2.25,{...approval,academicProbationStatus:"ON_ACADEMIC_PROBATION"},"BLOCK","BLOCKED","TERM_OVERLOAD_NOT_ALLOWED_ON_ACADEMIC_PROBATION"],
    [3.26,approval,"BLOCK","BLOCKED","TERM_CAPACITY_EXCEEDED"]
  ]) {
    const facts = {...student,reservedCourseUnits:{"winter-2027":reserved},termLoadOverrides:evidence ? {"winter-2027":evidence} : {},tuitionPaid:true};
    const mapped = mappingFor(facts), context = resolvePlanningContext(facts);
    const annotated = annotateEconomicsPlanChoices({plans:[plan],student:facts,mapping:mapped,schedule:runtimeEconomicsSchedule(),prerequisites,courseCatalog:catalog.economicsCourses,context,policyBundle:bundle})[0];
    const choice = annotated.terms.find(term => term.slotId === "winter-2028").courses.find(course => course.course === "ECO 321").moveDestinationOptions.find(option => option.id === "winter-2027");
    assert.equal(choice.loadDecision.status,status);
    assert.equal(choice.status,cardStatus,JSON.stringify(choice));
    const edited = await post({action:"validate-plan",student:facts,plan,plans:[plan],edit:{type:"move",fromTermId:"winter-2028",toTermId:"winter-2027",courseId:ids[1]}});
    assert.equal(edited.response.status,["ALLOW","CONDITIONAL"].includes(status) ? 200 : 422,JSON.stringify(edited.data.error));
    const validation = edited.data.plan?.validation || edited.data.validation;
    const decision = validation.policyDecision.decisions.find(item => item.subject.termId === "2027-WINTER" && item.ruleIds.includes("CAPACITY-WINTER"));
    assert.equal(decision.reasonCode,reason);
    const proposed = edited.data.plan || structuredClone(plan);
    if (!edited.data.plan) {
      proposed.terms.find(term => term.slotId === "winter-2028").courses = [];
      proposed.terms.find(term => term.slotId === "winter-2027").courses.push({...schedule.terms.Winter.find(row => row.course === "ECO 321"),requirementId:ids[1],slotId:"winter-2027",source:"verified-offering",scheduleProvenance:"PUBLISHED_SCHEDULE",publicationStatus:"PUBLISHED_SCHEDULE",offeringStatus:"verified"});
    }
    const audited = oracleEvaluateCanonicalPlan(oracle,facts,proposed,context);
    assert.equal(audited.findings.find(item => item.path === "$.terms[0]" && item.ruleIds.includes("CAPACITY-WINTER")).status,status);
    const reportResponse = await reportPost(new Request("http://localhost/api/reports/economics",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({student:facts,preparedDate:facts.planCreationDate,selectedPlan:proposed,plans:[proposed],format:"json"})}));
    assert.equal(reportResponse.status,["ALLOW","CONDITIONAL"].includes(status) ? 200 : 422);
    if (reportResponse.status === 200) {
      const report = await reportResponse.json();
      assert.equal(report.selectedPlan.validation.policyDecision.decisions.find(item => item.subject.termId === "2027-WINTER" && item.ruleIds.includes("CAPACITY-WINTER")).status,status);
    }
  }
});

test("future-dated January 11, 2027 Taking now ECO 161 conflicts with ECO 321; September intake stays separate", async () => {
  // This is a future Winter-day test, not the September 28 student's history.
  const student = {academicStanding:"senior",planCreationDate:"2027-01-11",courses:[...completed(["ECO 113","ECO 114","ECO 213","ECO 214","MAT 113","MAT 217","ECO 221","ECO 234","ECO 222"]),{code:"ECO 161",status:"in_progress",units:1}]};
  const {data} = await post({student});
  const mapped = economics(data);
  assert.equal(mapped.economicsPlans.length,0,"The fixed verified ECO 161 meeting must exclude ECO 321 from Winter generation");
  const term = {termKey:"Winter",academicYear:"2026/2027",slotId:"winter-2027",courses:[{course:"ECO 161",section:"J",fixedInProgress:true},{course:"ECO 321",section:"J",source:"verified-offering",requirementId:"finance"}]};
  const decision = evaluatePlan({terms:[term]},normalizeStudentFacts(student,bundle),{},bundle);
  assert.ok(decision.decisions.some(item=>item.reasonCode==="AUTHORITATIVE_MEETING_CONFLICT"));
  assert.ok(oracleEvaluateCanonicalPlan(oracle,student,{terms:[term]}).findings.some(item=>item.reasonCode==="AUTHORITATIVE_MEETING_CONFLICT"));
  const unknown = evaluatePlan({terms:[{...term,courses:[{course:"MAT 121",fixedInProgress:true}]}]},normalizeStudentFacts({...student,courses:[{code:"MAT 121",status:"in_progress"}]},bundle),{},bundle);
  assert.ok(unknown.reviewFindings.some(item=>item.reasonCode==="IN_PROGRESS_SECTION_MEETINGS_REVIEW"));
});
