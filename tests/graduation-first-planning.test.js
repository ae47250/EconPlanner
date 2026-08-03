import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  buildEconomicsTermPlans,
  buildEconomicsTermPlan,
  FEASIBILITY_STATUS,
  SEARCH_INCOMPLETE_MESSAGE,
  validateGeneratedPlan
} from "../lib/planning/economics.js";
import {
  buildEarlyGraduationContext,
  buildPlanningSlots,
  resolvePlanningContext
} from "../lib/planning/horizon.js";
import { validateStudentPrerequisites } from "../lib/planning/prerequisiteValidation.js";
import {
  availabilityIsStale,
  normalizeEconomicsSchedule,
  selectConflictFreeOffering
} from "../lib/planning/scheduleProvider.js";

const schedule = JSON.parse(await readFile(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));
const prerequisites = JSON.parse(await readFile(new URL("../data/normalized/economics/prerequisites.json", import.meta.url), "utf8"));
const requirements = JSON.parse(await readFile(new URL("../data/normalized/economics/requirements.json", import.meta.url), "utf8"));

const completed = codes => codes.map(code => ({ code, status: "completed" }));

function bundle(student, scheduleOverride = schedule, options = {}) {
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  return {
    mapping,
    result: buildEconomicsTermPlans({ student, mapping, schedule: scheduleOverride, prerequisites, ...options })
  };
}

function upcomingStudent(standing, codes) {
  return {
    academicStanding: standing,
    planCreationDate: "2026-07-30",
    courses: completed(codes)
  };
}

function extraOpenElective(course, section = "A") {
  return {
    course,
    section,
    title: "Verified elective test section",
    units: 1,
    instructor: "Department",
    days: "Tue",
    startTime: "6:00 PM",
    endTime: "7:00 PM",
    startDate: "2026-08-24",
    endDate: "2026-12-11",
    availability: { status: "open", seatsOpen: 10, capacity: 20, asOf: "2026-07-30" },
    verificationStatus: "verified"
  };
}

test("same remaining count produces coherent paths when ECO 213 versus ECO 214 is complete", () => {
  const common = ["ECO 113", "ECO 114", "MAT 113", "ECO 257", "BUSN 323", "ECO 221", "ECO 222", "ECO 234"];
  const with213 = bundle(upcomingStudent("senior", [...common, "ECO 213"]));
  const with214 = bundle(upcomingStudent("senior", [...common, "ECO 214"]));

  assert.equal(with213.mapping.strict.remainingUnits, with214.mapping.strict.remainingUnits);
  assert.equal(with213.result.plans.length, 1);
  assert.equal(with214.result.plans.length, 1);
  const with213Capstone = with213.result.plans[0].terms.flatMap(term => term.courses).find(course => course.course === "ECO 461");
  const with214Capstone = with214.result.plans[0].terms.flatMap(term => term.courses).find(course => course.course === "ECO 461");
  assert.ok(with213Capstone.approvalRequired.some(item => item.type === "department" && item.prerequisite === "ECO 214"));
  assert.equal(with214Capstone.approvalRequired, undefined);
});

test("sophomore C-2 evaluates 12, 11, 10, and 9 remaining through the full solver", () => {
  const profiles = [
    [],
    ["ECO 113"],
    ["ECO 113", "ECO 114"],
    ["ECO 113", "ECO 114", "MAT 113"]
  ];
  const statuses = profiles.map(codes => {
    const { mapping, result } = bundle(upcomingStudent("sophomore", codes));
    return {
      remaining: mapping.strict.remainingUnits,
      outcome: result.candidateOutcomes.find(item => item.id === "plan-c2"),
      plan: result.plans.find(item => item.id === "plan-c2")
    };
  });

  assert.deepEqual(statuses.map(item => item.remaining), [12, 11, 10, 9]);
  assert.deepEqual(statuses.map(item => item.outcome.status), [
    "PRELIMINARY_ONLY",
    "PRELIMINARY_ONLY",
    "PRELIMINARY_ONLY",
    "PRELIMINARY_ONLY"
  ]);
  assert.equal(statuses[0].plan.feasibility.search.complete, false);
  assert.equal(statuses[0].plan.feasibility.search.terminationReason, "SOLUTION_BUDGET");
  assert.ok(statuses[0].plan.feasibility.search.validSolutionCount >= 100);
  assert.notEqual(statuses[0].plan.feasibilityStatus, FEASIBILITY_STATUS.NOT_FEASIBLE);
});

test("junior C-2 rejects a numerical ten-course fit and finds the valid nine-course sequence", () => {
  const tenStudent = upcomingStudent("junior", ["ECO 113", "ECO 114"]);
  const tenRemaining = bundle(tenStudent);
  assert.equal(tenRemaining.mapping.strict.remainingUnits, 10);
  assert.equal(tenRemaining.result.candidateOutcomes.find(item => item.id === "plan-c2").status, "NOT_FEASIBLE");
  const tenPlan = buildEconomicsTermPlan({
    student: tenStudent,
    mapping: tenRemaining.mapping,
    schedule,
    prerequisites,
    planningContext: buildEarlyGraduationContext(resolvePlanningContext(tenStudent)),
    planVariant: { id: "plan-c2", label: "Plan C-2", strategy: "early-graduation", description: "" },
    planningMode: "graduation_priority"
  });
  assert.equal(tenPlan.feasibilityStatus, FEASIBILITY_STATUS.NOT_FEASIBLE);
  assert.equal(tenPlan.feasibility.search.complete, true);
  assert.equal(tenPlan.feasibility.search.terminationReason, "COUNT_CAPACITY");

  const baseProfile = upcomingStudent("junior", ["ECO 113", "MAT 113", "ECO 213"]);
  const threeUsable = bundle(baseProfile);
  assert.equal(threeUsable.mapping.strict.remainingUnits, 9);
  assert.equal(threeUsable.result.candidateOutcomes.find(item => item.id === "plan-c2").status, "PRELIMINARY_ONLY");

  const fourUsableSchedule = structuredClone(schedule);
  const fourthElective = extraOpenElective("ECO 315", "A");
  fourthElective.days = "Wed";
  fourUsableSchedule.terms.Fall.push(extraOpenElective("ECO 224"), fourthElective);
  const fourUsable = bundle(baseProfile, fourUsableSchedule);
  assert.notEqual(fourUsable.result.candidateOutcomes.find(item => item.id === "plan-c2").status, "NOT_FEASIBLE");
});

test("J+3 C-2 uses BUSN 323 for Finance and ECO 321 for an elective without double counting", () => {
  const student = upcomingStudent("junior", ["ECO 113", "MAT 113", "ECO 213"]);
  const { mapping, result } = bundle(student);
  const plan = result.plans.find(item => item.id === "plan-c2");

  assert.ok(plan);
  assert.equal(plan.validation.valid, true);
  assert.equal(plan.feasibilityStatus, "PRELIMINARY_ONLY");
  assert.ok(plan.requirementAllocation.valid);
  assert.ok(plan.requirementAllocation.assignments.some(item => (
    item.slotId === "finance" && item.code === "BUSN 323" && item.source === "planned"
  )));
  assert.ok(plan.requirementAllocation.assignments.some(item => (
    String(item.slotId).startsWith("eco-elective") && item.code === "ECO 321"
  )));

  const electives = plan.terms.flatMap(term => term.courses)
    .filter(course => String(course.requirementId).startsWith("eco-elective"));
  assert.equal(electives.length, 4);
  assert.equal(new Set(electives.map(course => course.course)).size, 4);

  const fall = plan.terms.find(term => term.term === "Fall 2026");
  const winter = plan.terms.find(term => term.term === "Winter 2027");
  const may = plan.terms.find(term => term.term === "Spring/May 2027");
  assert.equal(fall.courses.length, 4);
  assert.equal(winter.courses.length, 4);
  assert.equal(may.courses.length, 1);
  assert.ok(fall.courses.some(course => course.course === "MAT 217"));
  assert.ok(winter.courses.some(course => course.course === "ECO 461"));
  const capstone = winter.courses.find(course => course.course === "ECO 461");
  assert.ok(capstone.approvalRequired.some(item => (
    item.type === "department" && item.prerequisite === "ECO 214"
  )));
  assert.equal(validateGeneratedPlan(plan, {
    student,
    mapping,
    schedule,
    prerequisites,
    context: result.context
  }).valid, true);
});

test("node-limited plans are search-incomplete rather than declared infeasible", () => {
  const student = upcomingStudent("junior", ["ECO 113", "MAT 113", "ECO 213"]);
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const context = buildEarlyGraduationContext(resolvePlanningContext(student));
  const plan = buildEconomicsTermPlan({
    student,
    mapping,
    schedule,
    prerequisites,
    planningContext: context,
    planVariant: { id: "plan-c2", label: "Plan C-2", strategy: "early-graduation", description: "" },
    planningMode: "graduation_priority",
    nodeLimit: 1
  });

  assert.equal(plan.validation.valid, false);
  assert.equal(plan.feasibilityStatus, FEASIBILITY_STATUS.SEARCH_INCOMPLETE);
  assert.equal(plan.feasibility.overallStatus, FEASIBILITY_STATUS.SEARCH_INCOMPLETE);
  assert.equal(plan.feasibility.search.complete, false);
  assert.equal(plan.feasibility.search.terminationReason, "NODE_LIMIT");
  assert.equal(plan.feasibility.search.validSolutionCount, 0);
  assert.equal(plan.feasibility.blockingReasons.length, 0);
  assert.ok(plan.studentMessages.includes(SEARCH_INCOMPLETE_MESSAGE));

  const limitedBundle = bundle(student, schedule, { nodeLimit: 1 }).result;
  const c2 = limitedBundle.candidateOutcomes.find(item => item.id === "plan-c2");
  assert.equal(c2.status, FEASIBILITY_STATUS.SEARCH_INCOMPLETE);
  assert.equal(c2.suppressionReason.code, "SEARCH_INCOMPLETE");
  assert.ok(limitedBundle.planningGaps.some(item => item.message === SEARCH_INCOMPLETE_MESSAGE));
});

test("the solver backtracks from a conflicting Fall placement to a valid Winter alternative", () => {
  const conflictSchedule = structuredClone(schedule);
  conflictSchedule.terms.Winter = conflictSchedule.terms.Winter.filter(item => item.course !== "ECO 321");
  for (const offering of conflictSchedule.terms.Fall.filter(item => item.course === "ECO 114")) {
    offering.days = "Mon";
    offering.startTime = "10:00 AM";
    offering.endTime = "11:00 AM";
  }
  conflictSchedule.terms.Fall.push({
    course: "BUSN 323",
    section: "A",
    title: "Financial Management",
    units: 1,
    instructor: "Department",
    days: "Mon",
    startTime: "10:00 AM",
    endTime: "11:00 AM",
    startDate: "2026-08-24",
    endDate: "2026-12-11",
    availability: { status: "open", seatsOpen: 10, capacity: 20, asOf: "2026-07-30" },
    verificationStatus: "verified"
  });
  const student = upcomingStudent("senior", [
    "ECO 113", "MAT 113", "ECO 213", "ECO 214", "ECO 257", "ECO 461",
    "ECO 221", "ECO 222", "ECO 234", "ECO 333"
  ]);
  const { result } = bundle(student, conflictSchedule);
  const plan = result.plans[0];
  const fall = plan.terms.find(term => term.term === "Fall 2026");
  const winter = plan.terms.find(term => term.term === "Winter 2027");

  assert.equal(plan.validation.valid, true);
  assert.ok(fall.courses.some(course => course.course === "BUSN 323"));
  assert.ok(!fall.courses.some(course => course.course === "ECO 114"));
  assert.ok(winter.courses.some(course => course.course === "ECO 114"));
  assert.ok(plan.feasibility.search.nodesVisited > plan.feasibility.search.firstSolutionNode);
  assert.ok(plan.feasibility.search.completionAttempts > 1);
});

test("one-year-early final Winter carries senior standing for ECO 461", () => {
  const context = buildEarlyGraduationContext(resolvePlanningContext(upcomingStudent("junior", [])));
  const finalWinter = buildPlanningSlots(context).find(slot => slot.termKey === "Winter");
  assert.equal(context.remainingYears, 1);
  assert.equal(finalWinter.absoluteStandingIndex, 3);
});

test("transfer plans keep the selected graduation target and omit C-2", () => {
  const student = {
    isTransferStudent: true,
    transferExpectedGraduationYear: "2030",
    transferEntryAcademicYear: "2025-2026",
    planCreationDate: "2027-01-10",
    courses: []
  };
  const { result } = bundle(student);

  assert.equal(result.earlyGraduationContext, null);
  assert.ok(result.candidateOutcomes.every(outcome => outcome.id !== "plan-c2"));
  assert.ok(result.plans.every(plan => plan.planningContext.expectedGraduationTerm === "Spring/May 2030"));

  const fiveYear = bundle({
    ...student,
    transferExpectedGraduationYear: "2031"
  }).result;
  assert.equal(fiveYear.plans[0].distribution.targetYears.length, 5);
  assert.equal(fiveYear.plans[0].terms.at(-1).term, "Spring/May 2031");
});

test("PSY 217 unlocks ECO 461, while concurrent statistics remains blocked", () => {
  for (const statistics of ["ECO 257", "MAT 217", "PSY 217"]) {
    const validation = validateStudentPrerequisites([
      ...completed(["ECO 113", "ECO 114", "MAT 113", "ECO 213", "ECO 214", statistics]),
      { code: "ECO 461", status: "in_progress" }
    ], prerequisites);
    assert.equal(validation.valid, true, statistics);
  }

  const concurrent = validateStudentPrerequisites([
    ...completed(["ECO 113", "ECO 114", "MAT 113", "ECO 213", "ECO 214"]),
    { code: "PSY 217", status: "in_progress" },
    { code: "ECO 461", status: "in_progress" }
  ], prerequisites);
  assert.equal(concurrent.valid, false);
  assert.ok(concurrent.issues.some(item => item.course === "ECO 461"));
});

test("ECO 114 in Fall unlocks ECO 321 in Winter", () => {
  const student = upcomingStudent("senior", [
    "ECO 113", "MAT 113", "ECO 214", "ECO 257",
    "ECO 221", "ECO 222", "ECO 234", "ECO 333"
  ]);
  const { result } = bundle(student);
  const plan = result.plans[0];
  const fall = plan.terms.find(term => term.term === "Fall 2026");
  const winter = plan.terms.find(term => term.term === "Winter 2027");
  assert.ok(fall.courses.some(course => course.course === "ECO 114"));
  assert.ok(winter.courses.some(course => course.course === "ECO 321"));
});

test("department approval metadata is required for an intermediate concurrent with ECO 461", () => {
  const student = upcomingStudent("senior", [
    "ECO 113", "ECO 114", "MAT 113", "ECO 213", "ECO 257", "BUSN 323",
    "ECO 221", "ECO 222", "ECO 234"
  ]);
  const { mapping, result } = bundle(student);
  const approved = result.plans[0];
  const capstone = approved.terms.flatMap(term => term.courses).find(course => course.course === "ECO 461");
  assert.ok(capstone.approvalRequired.some(item => item.type === "department"));

  const unapproved = structuredClone(approved);
  delete unapproved.terms.flatMap(term => term.courses).find(course => course.course === "ECO 461").approvalRequired;
  const validation = validateGeneratedPlan(unapproved, {
    student,
    mapping,
    schedule,
    prerequisites,
    context: result.context
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(message => /Economics Department/.test(message)));
});

test("every ECO 260 special-topics course counts as an Economics elective", () => {
  const { mapping } = bundle({ courses: [{ code: "ECO 260", status: "completed" }] });
  assert.ok(mapping.assignments.some(item => item.code === "ECO 260" && item.slotId.startsWith("eco-elective")));
});

test("availability distinguishes open, waitlisted, closed, stale, and schema-v1 unknown sections", () => {
  const raw = {
    schemaVersion: 2,
    academicYear: "2026-2027",
    lastVerifiedAt: "2026-07-30T12:00:00-04:00",
    terms: {
      Fall: [
        { course: "ECO 224", section: "A", verificationStatus: "verified", availability: { status: "closed", seatsOpen: 0, capacity: 20, asOf: "2026-07-30" } },
        { course: "ECO 224", section: "B", verificationStatus: "verified", availability: { status: "waitlisted", seatsOpen: 0, capacity: 20, asOf: "2026-07-30" } },
        { course: "ECO 224", section: "C", verificationStatus: "verified", availability: { status: "open", seatsOpen: 2, capacity: 20, asOf: "2026-07-30" } }
      ]
    }
  };
  const normalized = normalizeEconomicsSchedule(raw);
  const selected = selectConflictFreeOffering(normalized, { academicYear: "2026/2027", scheduleTerm: "Fall" }, "ECO 224");
  assert.equal(selected.section, "C");
  assert.equal(availabilityIsStale(selected.availability, "2026-07-30"), false);
  assert.equal(availabilityIsStale(selected.availability, "2026-08-02"), true);

  raw.terms.Fall = raw.terms.Fall.filter(item => item.availability.status !== "open");
  assert.equal(selectConflictFreeOffering(raw, { academicYear: "2026/2027", scheduleTerm: "Fall" }, "ECO 224").availability.status, "waitlisted");
  raw.terms.Fall = raw.terms.Fall.filter(item => item.availability.status === "closed");
  assert.equal(selectConflictFreeOffering(raw, { academicYear: "2026/2027", scheduleTerm: "Fall" }, "ECO 224"), null);

  const legacy = normalizeEconomicsSchedule({ academicYear: "2026-2027", terms: { Fall: [{ course: "ECO 224", section: "A" }] } });
  assert.equal(legacy.provider.schemaVersion, 1);
  assert.equal(legacy.terms.Fall[0].availability.status, "unknown");
});

test("converged pacing labels are reported instead of duplicate plan cards", () => {
  const student = upcomingStudent("sophomore", [
    "ECO 113", "ECO 114", "MAT 113", "ECO 213", "ECO 214", "ECO 257", "BUSN 323",
    "ECO 221", "ECO 222", "ECO 234", "ECO 333"
  ]);
  const { result } = bundle(student);
  assert.ok(result.convergences.some(item => item.keptLabel === "Plan A" && ["Plan B", "Plan C"].includes(item.convergedLabel)));
  assert.equal(new Set(result.plans.map(plan => JSON.stringify(plan.terms))).size, result.plans.length);
});
