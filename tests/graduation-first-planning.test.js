import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  buildEconomicsTermPlans,
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

function bundle(student, scheduleOverride = schedule) {
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  return {
    mapping,
    result: buildEconomicsTermPlans({ student, mapping, schedule: scheduleOverride, prerequisites })
  };
}

function upcomingStudent(standing, codes) {
  return {
    academicStanding: standing,
    planCreationDate: "2026-07-30",
    summerStandingConfirmed: "yes",
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
      outcome: result.candidateOutcomes.find(item => item.id === "plan-c2")
    };
  });

  assert.deepEqual(statuses.map(item => item.remaining), [12, 11, 10, 9]);
  assert.deepEqual(statuses.map(item => item.outcome.status), [
    "NOT_FEASIBLE",
    "NOT_FEASIBLE",
    "NOT_FEASIBLE",
    "PRELIMINARY_ONLY"
  ]);
});

test("junior C-2 rejects a numerical ten-course fit and needs four usable elective sections for nine", () => {
  const tenRemaining = bundle(upcomingStudent("junior", ["ECO 113", "ECO 114"]));
  assert.equal(tenRemaining.mapping.strict.remainingUnits, 10);
  assert.equal(tenRemaining.result.candidateOutcomes.find(item => item.id === "plan-c2").status, "NOT_FEASIBLE");

  const baseProfile = upcomingStudent("junior", ["ECO 113", "MAT 113", "ECO 213"]);
  const threeUsable = bundle(baseProfile);
  assert.equal(threeUsable.mapping.strict.remainingUnits, 9);
  assert.equal(threeUsable.result.candidateOutcomes.find(item => item.id === "plan-c2").status, "NOT_FEASIBLE");

  const fourUsableSchedule = structuredClone(schedule);
  const fourthElective = extraOpenElective("ECO 315", "A");
  fourthElective.days = "Wed";
  fourUsableSchedule.terms.Fall.push(extraOpenElective("ECO 224"), fourthElective);
  const fourUsable = bundle(baseProfile, fourUsableSchedule);
  assert.notEqual(fourUsable.result.candidateOutcomes.find(item => item.id === "plan-c2").status, "NOT_FEASIBLE");
});

test("one-year-early final Winter carries senior standing for ECO 461", () => {
  const context = buildEarlyGraduationContext(resolvePlanningContext(upcomingStudent("junior", [])));
  const finalWinter = buildPlanningSlots(context).find(slot => slot.termKey === "Winter");
  assert.equal(context.remainingYears, 1);
  assert.equal(finalWinter.absoluteStandingIndex, 3);
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
        { course: "ECO 224", section: "A", availability: { status: "closed", seatsOpen: 0, capacity: 20, asOf: "2026-07-30" } },
        { course: "ECO 224", section: "B", availability: { status: "waitlisted", seatsOpen: 0, capacity: 20, asOf: "2026-07-30" } },
        { course: "ECO 224", section: "C", availability: { status: "open", seatsOpen: 2, capacity: 20, asOf: "2026-07-30" } }
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
