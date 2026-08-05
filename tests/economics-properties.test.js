import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import fc from "fast-check";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  buildEconomicsTermPlans,
  classifyFeasibility,
  semanticPlanSignature
} from "../lib/planning/economics.js";
import { evaluatePlanPrerequisites } from "../lib/planning/prerequisiteEvaluator.js";
import { validateStudentPrerequisites } from "../lib/planning/prerequisiteValidation.js";
import { buildRequirementAllocation } from "../lib/planning/requirementAllocation.js";
import {
  meetingsConflict,
  normalizeEconomicsSchedule,
  scheduleOfferingDecision,
  scheduleOfferings,
  selectConflictFreeOffering
} from "../lib/planning/scheduleProvider.js";
import { auditExternalEconomicsPlanComplete } from "./oracle/audit-external-plan.js";
import { checkExternalEconomicsRequirements } from "./oracle/check-requirements.js";
import { checkExternalEconomicsScheduleAndHorizon } from "./oracle/check-schedule-and-horizon.js";
import { createExternalPlanSemanticSignature } from "./oracle/plan-signature.js";
import {
  fictionalEconomicsProfileArbitrary,
  generateFictionalEconomicsProfiles,
  independentPrerequisiteClosure
} from "./helpers/economics-generators.js";

const productionRequirements = JSON.parse(await readFile(
  new URL("../data/normalized/economics/requirements.json", import.meta.url),
  "utf8"
));
const productionPrerequisites = JSON.parse(await readFile(
  new URL("../data/normalized/economics/prerequisites.json", import.meta.url),
  "utf8"
));
const rawProductionSchedule = JSON.parse(await readFile(
  new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url),
  "utf8"
));
const oraclePolicy = JSON.parse(await readFile(
  new URL("./oracle/economics-policy.v1.json", import.meta.url),
  "utf8"
));
const oracleSchedule = JSON.parse(await readFile(
  new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url),
  "utf8"
));

const PROGRAM = Object.freeze({ id: "economics", name: "Economics" });
const PROPERTY_SEED = 20260803;
const PROPERTY_MODE = process.env.ECONOMICS_PROPERTY_MODE === "nightly" ? "nightly" : "small";
const PROPERTY_RUNS = PROPERTY_MODE === "nightly" ? 100 : 8;
const HEAVY_PROPERTY_RUNS = PROPERTY_MODE === "nightly" ? 25 : 3;
const TASK12_DISAGREEMENTS = Object.freeze([]);
const productionSchedule = normalizeEconomicsSchedule(rawProductionSchedule);
const generatedProfiles = generateFictionalEconomicsProfiles({
  seed: PROPERTY_SEED,
  manifest: oraclePolicy,
  verifiedSchedule: oracleSchedule
}).profiles;
const generatedProfileArbitrary = fictionalEconomicsProfileArbitrary({
  manifest: oraclePolicy,
  verifiedSchedule: oracleSchedule
});

const REQUIREMENT_COURSES = Object.freeze([
  "ECO 113",
  "ECO 114",
  "ECO 213",
  "ECO 214",
  "ECO 257",
  "MAT 217",
  "PSY 217",
  "ECO 321",
  "BUSN 323",
  "MAT 113",
  "MAT 121",
  "ECO 161",
  "ECO 221",
  "ECO 234",
  "PHI 234",
  "ECO 260",
  "ECO 333"
]);
const FINAL_YEAR_COMPLETED = Object.freeze([
  "ECO 113",
  "ECO 114",
  "ECO 213",
  "ECO 214",
  "MAT 217",
  "BUSN 323",
  "MAT 113",
  "ECO 161",
  "ECO 234",
  "ECO 260",
  "ECO 333"
]);
const FEASIBILITY_RANK = Object.freeze({
  NOT_FEASIBLE: 0,
  SEARCH_INCOMPLETE: 0,
  PRELIMINARY_ONLY: 1,
  CONDITIONALLY_FEASIBLE: 2,
  VERIFIED_FEASIBLE: 3
});

function canonicalCourse(value) {
  const code = String(value || "").trim().toUpperCase();
  return code === "PHI 234" ? "ECO 234" : code;
}

function completedCourses(codes, status = "completed") {
  return codes.map(code => ({ code, status, source: "student_record", units: 1 }));
}

function mappingForCourses(courses) {
  return mapStudentToProgram(PROGRAM, productionRequirements, { courses });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function compactCounterexample(value) {
  const profile = value?.profile || value;
  const remainder = value && typeof value === "object" && "profile" in value
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "profile"))
    : {};
  return {
    profile: {
      seed: profile?.seed ?? PROPERTY_SEED,
      profileId: profile?.profileId ?? "task12-property-case",
      axes: profile?.axes ?? null
    },
    case: stableValue(remainder)
  };
}

function caseSignature(value, plan = null) {
  if (plan) {
    return createExternalPlanSemanticSignature(plan, plan.planningContext || {});
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(stableValue(compactCounterexample(value))))
    .digest("hex");
  return `econ-property-case-v1:${digest}`;
}

function failureDetails(propertyName, propertySeed, value, error) {
  const profile = value?.profile || value;
  return {
    event: "TASK12_MINIMIZED_COUNTEREXAMPLE",
    property: propertyName,
    seed: profile?.seed ?? propertySeed,
    fastCheckSeed: propertySeed,
    profileId: profile?.profileId ?? "task12-property-case",
    semanticSignature: caseSignature(value, error?.semanticPlan),
    minimizedCounterexample: compactCounterexample(value),
    message: error?.message || String(error)
  };
}

function propertyInvariant(condition, message, semanticPlan = null) {
  if (condition) return;
  const error = new Error(message);
  error.semanticPlan = semanticPlan;
  throw error;
}

function fixedSeedProperty(name, arbitrary, predicate, { seedOffset = 0, heavy = false } = {}) {
  const seed = PROPERTY_SEED + seedOffset;
  const numRuns = heavy ? HEAVY_PROPERTY_RUNS : PROPERTY_RUNS;
  test(`${name} [${PROPERTY_MODE}; seed=${seed}; runs=${numRuns}]`, () => {
    let minimizedValue = null;
    let minimizedError = null;
    const property = fc.property(arbitrary, value => {
      try {
        predicate(value);
      } catch (error) {
        minimizedValue = value;
        minimizedError = error;
        throw error;
      }
    });
    try {
      fc.assert(property, { seed, numRuns, verbose: 2 });
    } catch (error) {
      const details = failureDetails(name, seed, minimizedValue, minimizedError || error);
      console.error(JSON.stringify(details));
      throw error;
    }
  });
}

function studentForFinalYear({ profileId, statuses = {}, usePhiCrossList = false }) {
  const codes = FINAL_YEAR_COMPLETED.map(code => (
    usePhiCrossList && code === "ECO 234" ? "PHI 234" : code
  ));
  return {
    seed: PROPERTY_SEED,
    profileId,
    student: {
      academicStanding: "senior",
      planCreationDate: "2026-07-30",
      courses: codes.map(code => ({
        code,
        status: statuses[canonicalCourse(code)] || "completed",
        source: "student_record"
      }))
    }
  };
}

function finalYearOracleCase(missingCourse, index) {
  return {
    seed: PROPERTY_SEED,
    profileId: `task12-verified-senior-${index}`,
    student: {
      academicStanding: "senior",
      planCreationDate: "2026-07-30",
      courses: completedCourses(FINAL_YEAR_COMPLETED.filter(code => code !== missingCourse))
    }
  };
}

const NO_REPEAT_CASES = Object.freeze([
  studentForFinalYear({ profileId: "task12-no-repeat-completed" }),
  studentForFinalYear({
    profileId: "task12-no-repeat-eco333-in-progress",
    statuses: { "ECO 333": "in_progress" }
  }),
  studentForFinalYear({
    profileId: "task12-no-repeat-eco260-in-progress",
    statuses: { "ECO 260": "in_progress" }
  }),
  studentForFinalYear({
    profileId: "task12-no-repeat-cross-list",
    usePhiCrossList: true
  })
]);
const ORACLE_FINAL_YEAR_CASES = Object.freeze([
  finalYearOracleCase(null, 1),
  finalYearOracleCase("ECO 333", 2),
  finalYearOracleCase("ECO 260", 3),
  finalYearOracleCase("ECO 234", 4)
]);

function generateBundle(student) {
  const mapping = mapStudentToProgram(PROGRAM, productionRequirements, student);
  const bundle = buildEconomicsTermPlans({
    student,
    mapping,
    schedule: rawProductionSchedule,
    prerequisites: productionPrerequisites
  });
  return { mapping, bundle };
}

function currentTermCondition(plan, course, term) {
  return (plan.feasibility?.enrollmentConditions || []).some(condition => (
    condition.type === "stale_availability"
    && condition.course === course.course
    && condition.term === term.term
  ));
}

function oracleCourse(course, term, plan) {
  const value = {
    ...course,
    canonicalCrossListIdentity: [course.course, ...(course.crossListedAs || [])],
    availability: {
      ...course.availability,
      ...(currentTermCondition(plan, course, term) ? { freshness: "stale" } : {})
    },
    provenance: {
      verificationDate: course.provenance?.humanVerifiedOn
        ?? course.provenance?.verifiedOn
        ?? course.provenance?.screenshotRetrievedOn
        ?? null,
      sourceReference: course.provenance?.sourceFiles?.[0] ?? null
    },
    ...(course.course === "ECO 461" && course.residency === "hanover"
      ? { institution: "Hanover College" }
      : {})
  };
  if (!value.section) delete value.section;
  return value;
}

function externalOracleInput(student, plan) {
  const active = student.courses.filter(course => ["completed", "in_progress"].includes(course.status));
  return {
    student: {
      academicStanding: student.academicStanding,
      completedCourses: active.map(course => ({
        course: course.code,
        ...(course.status === "in_progress" ? { projectedCompletion: true } : {})
      })),
      inProgressCourses: active
        .filter(course => course.status === "in_progress")
        .map(course => ({ course: course.code }))
    },
    expectedContext: plan.planningContext,
    plan: {
      id: plan.id,
      terms: plan.terms.map(term => ({
        ...term,
        courses: term.courses.map(course => oracleCourse(course, term, plan))
      })),
      requirementClaims: []
    },
    policy: oraclePolicy,
    verifiedSchedule: oracleSchedule
  };
}

function deterministicBundleView(bundle) {
  return {
    candidateSignatures: bundle.plans.map(plan => semanticPlanSignature(plan)),
    ranking: bundle.plans.map(plan => ({ id: plan.id, label: plan.label })),
    suppressionReasons: bundle.candidateOutcomes.map(outcome => ({
      id: outcome.id,
      displayed: outcome.displayed,
      status: outcome.status,
      suppressionReason: outcome.suppressionReason || null,
      candidatePool: outcome.candidatePool || null
    })),
    searchDiagnostics: bundle.plans.map(plan => ({
      id: plan.id,
      search: plan.feasibility?.search || plan.search || null
    })),
    convergences: bundle.convergences,
    planningGaps: bundle.planningGaps
  };
}

function eligibleOfferings(schedule, slot, code, selectedCourses = []) {
  return scheduleOfferings(schedule, slot, code).filter(offering => (
    offering.verificationStatus === "verified"
    && offering.availability?.status !== "closed"
    && !selectedCourses.some(course => meetingsConflict(offering, course))
  ));
}

function oneCourseFeasibility(offering, availabilityStatus) {
  const planCreationDate = "2026-07-30T12:00:00Z";
  const course = structuredClone(offering);
  course.source = "verified-offering";
  course.availability = {
    ...course.availability,
    status: availabilityStatus,
    asOf: planCreationDate
  };
  const plan = {
    validation: { valid: true },
    terms: [{ term: "Fall 2026", courses: [course] }]
  };
  return {
    plan,
    status: classifyFeasibility(plan, { planCreationDate })
  };
}

function simpleTerm(termKey, courses) {
  const calendarYear = termKey === "Fall" ? 2026 : 2027;
  return {
    slotId: `${termKey.toLowerCase()}-${calendarYear}`,
    term: termKey === "Spring" ? "Spring/May 2027" : `${termKey} ${calendarYear}`,
    termKey,
    scheduleTerm: termKey === "Spring" ? "May" : termKey,
    academicYear: "2026/2027",
    yearIndex: 0,
    absoluteStandingIndex: 3,
    courses
  };
}

function prerequisiteOrderPlan(orderCase, movedAfter) {
  const prerequisiteCourse = { course: orderCase.prerequisite };
  const dependentCourse = {
    course: orderCase.dependent,
    ...(orderCase.dependent === "ECO 461" ? { residency: "hanover" } : {})
  };
  return {
    terms: movedAfter
      ? [simpleTerm("Fall", []), simpleTerm("Winter", [dependentCourse]), simpleTerm("Spring", [prerequisiteCourse])]
      : [simpleTerm("Fall", [prerequisiteCourse]), simpleTerm("Winter", [dependentCourse]), simpleTerm("Spring", [])]
  };
}

function fullRequirementPlan({ statistics = "ECO 257", eco257ElectiveSlot = null }) {
  const electiveSlots = ["eco-elective-1", "eco-elective-2", "eco-elective-3", "eco-elective-4"];
  const otherElectives = ["ECO 221", "ECO 234", "ECO 260", "ECO 333"];
  const electiveAssignments = eco257ElectiveSlot
    ? [
        ["ECO 257", eco257ElectiveSlot],
        ...electiveSlots
          .filter(slot => slot !== eco257ElectiveSlot)
          .map((slot, index) => [otherElectives[index], slot])
      ]
    : otherElectives.map((course, index) => [course, electiveSlots[index]]);
  const assignments = [
    ["ECO 113", "eco-113"],
    ["ECO 114", "eco-114"],
    ["ECO 213", "eco-213"],
    ["ECO 214", "eco-214"],
    [statistics, "statistics"],
    ["BUSN 323", "finance"],
    ["ECO 461", "eco-461"],
    ["MAT 113", "cognate"],
    ...electiveAssignments
  ];
  return {
    terms: [{
      slotId: "fall-2026",
      term: "Fall 2026",
      termKey: "Fall",
      academicYear: "2026/2027",
      courses: assignments.map(([course, requirementId]) => ({
        course,
        requirementId,
        units: 1,
        ...(course === "ECO 461" ? { institution: "Hanover College" } : {})
      }))
    }]
  };
}

const openOfferingCases = Object.values(productionSchedule.terms).flat()
  .filter(offering => offering.verificationStatus === "verified" && offering.availability?.status === "open")
  .map(offering => ({ term: offering.term, course: offering.course, section: offering.section }));
const meetingCompleteOfferingCases = Object.values(productionSchedule.terms).flat()
  .filter(offering => offering.verificationStatus === "verified"
    && offering.meeting?.days?.length
    && Number.isFinite(offering.meeting.startMinutes)
    && Number.isFinite(offering.meeting.endMinutes))
  .map(offering => ({ term: offering.term, course: offering.course, section: offering.section }));

const prerequisiteRemovalCases = Object.freeze([
  { dependent: "ECO 213", remove: "ECO 113" },
  { dependent: "ECO 213", removeGroup: ["MAT 113", "MAT 121"] },
  { dependent: "ECO 214", remove: "ECO 114" },
  { dependent: "ECO 214", removeGroup: ["MAT 113", "MAT 121"] },
  { dependent: "ECO 331", remove: "ECO 213" },
  { dependent: "ECO 461", removeGroup: ["ECO 257", "MAT 217", "PSY 217"] }
]);
const prerequisiteOrderCases = Object.freeze([
  { prerequisite: "ECO 113", dependent: "ECO 213", completed: ["MAT 113"] },
  { prerequisite: "ECO 114", dependent: "ECO 214", completed: ["MAT 113"] },
  { prerequisite: "ECO 114", dependent: "ECO 321", completed: ["ECO 113"] },
  { prerequisite: "MAT 217", dependent: "ECO 461", completed: ["ECO 213", "ECO 214"] }
]);

test("Task 12 property modes and failure diagnostics are explicit", () => {
  assert.ok(["small", "nightly"].includes(PROPERTY_MODE));
  assert.equal(PROPERTY_RUNS, PROPERTY_MODE === "nightly" ? 100 : 8);
  assert.equal(HEAVY_PROPERTY_RUNS, PROPERTY_MODE === "nightly" ? 25 : 3);
  const sample = generatedProfiles[0];
  const details = failureDetails("diagnostic-contract", PROPERTY_SEED, { profile: sample }, new Error("example"));
  assert.equal(details.seed, sample.seed);
  assert.equal(details.profileId, sample.profileId);
  assert.match(details.semanticSignature, /^econ-property-case-v1:/u);
  assert.ok(details.minimizedCounterexample);
});

test("Task 12 does not silently accept unregistered production/oracle disagreements", () => {
  for (const disagreement of TASK12_DISAGREEMENTS) {
    assert.ok(disagreement.propertyId);
    assert.ok(disagreement.ruleId);
    assert.ok(disagreement.productionResult);
    assert.ok(disagreement.oracleResult);
    assert.ok(disagreement.followUp);
  }
});

fixedSeedProperty(
  "adding a verified completed requirement never increases remaining requirements",
  fc.record({
    profile: generatedProfileArbitrary,
    present: fc.uniqueArray(fc.constantFrom(...REQUIREMENT_COURSES), { maxLength: 10 }),
    addition: fc.constantFrom(...REQUIREMENT_COURSES)
  }),
  ({ present, addition }) => {
    const withoutAddition = present.filter(code => canonicalCourse(code) !== canonicalCourse(addition));
    const before = mappingForCourses(completedCourses(withoutAddition));
    const after = mappingForCourses(completedCourses([...withoutAddition, addition]));
    propertyInvariant(
      after.strict.remainingUnits <= before.strict.remainingUnits,
      `Remaining requirements increased from ${before.strict.remainingUnits} to ${after.strict.remainingUnits}.`
    );
  },
  { seedOffset: 1 }
);

fixedSeedProperty(
  "removing a prerequisite never makes a dependent course easier to schedule",
  fc.record({
    profile: generatedProfileArbitrary,
    removal: fc.constantFrom(...prerequisiteRemovalCases)
  }),
  ({ profile, removal }) => {
    const closure = independentPrerequisiteClosure(removal.dependent, oraclePolicy, profile.seed);
    const removedCourse = removal.remove
      || closure.find(course => removal.removeGroup.includes(course));
    const baselineCourses = [
      ...completedCourses(closure),
      { code: removal.dependent, status: "in_progress", source: "student_record" }
    ];
    const baseline = validateStudentPrerequisites(baselineCourses, productionPrerequisites);
    const afterRemoval = validateStudentPrerequisites(
      baselineCourses.filter(course => course.code !== removedCourse),
      productionPrerequisites
    );
    propertyInvariant(baseline.valid, `Independent closure did not create a valid ${removal.dependent} baseline.`);
    propertyInvariant(!afterRemoval.valid, `Removing ${removedCourse} left ${removal.dependent} valid.`);
  },
  { seedOffset: 2 }
);

fixedSeedProperty(
  "changing an open section to closed never improves section feasibility",
  fc.record({
    profile: generatedProfileArbitrary,
    offeringCase: fc.constantFrom(...openOfferingCases)
  }),
  ({ offeringCase }) => {
    const slot = { academicYear: productionSchedule.academicYear, scheduleTerm: offeringCase.term };
    const before = eligibleOfferings(productionSchedule, slot, offeringCase.course);
    const closedSchedule = structuredClone(productionSchedule);
    const row = closedSchedule.terms[offeringCase.term].find(offering => (
      offering.course === offeringCase.course && offering.section === offeringCase.section
    ));
    row.availability.status = "closed";
    const after = eligibleOfferings(closedSchedule, slot, offeringCase.course);
    propertyInvariant(after.length <= before.length, "Closing an open section increased eligible offerings.");
    propertyInvariant(
      Number(Boolean(selectConflictFreeOffering(closedSchedule, slot, offeringCase.course)))
        <= Number(Boolean(selectConflictFreeOffering(productionSchedule, slot, offeringCase.course))),
      "Closing an open section improved section selection feasibility."
    );
  },
  { seedOffset: 3 }
);

fixedSeedProperty(
  "changing a waitlisted section to open cannot worsen verification",
  fc.record({
    profile: generatedProfileArbitrary,
    offeringCase: fc.constantFrom(...meetingCompleteOfferingCases)
  }),
  ({ offeringCase }) => {
    const offering = productionSchedule.terms[offeringCase.term].find(row => (
      row.course === offeringCase.course && row.section === offeringCase.section
    ));
    const waitlisted = oneCourseFeasibility(offering, "waitlisted");
    const open = oneCourseFeasibility(offering, "open");
    propertyInvariant(
      FEASIBILITY_RANK[open.status] >= FEASIBILITY_RANK[waitlisted.status],
      `Opening the section worsened ${waitlisted.status} to ${open.status}.`,
      open.plan
    );
  },
  { seedOffset: 4 }
);

fixedSeedProperty(
  "increasing reserved outside-course units cannot increase planner capacity",
  fc.record({
    profile: generatedProfileArbitrary,
    term: fc.constantFrom(
      { termKey: "Fall", max: 4 },
      { termKey: "Winter", max: 4 },
      { termKey: "Spring/May", max: 1 }
    ),
    firstReserved: fc.integer({ min: 0, max: 4 }),
    secondReserved: fc.integer({ min: 0, max: 4 }),
    plannedUnits: fc.integer({ min: 0, max: 4 })
  }),
  ({ term, firstReserved, secondReserved, plannedUnits }) => {
    const lowerReserved = Math.min(firstReserved, secondReserved, term.max);
    const higherReserved = Math.min(Math.max(firstReserved, secondReserved), term.max);
    const planned = Math.min(plannedUnits, term.max);
    const availableBefore = Math.max(0, term.max - lowerReserved);
    const availableAfter = Math.max(0, term.max - higherReserved);
    propertyInvariant(availableAfter <= availableBefore, "More reserved units increased arithmetic capacity.");

    function capacityAudit(reservedOutsideCourseUnits) {
      const plan = {
        terms: [{
          slotId: `${term.termKey.toLowerCase()}-2028`,
          term: term.termKey === "Spring/May" ? "Spring/May 2028" : `${term.termKey} 2027`,
          termKey: term.termKey,
          academicYear: "2027/2028",
          reservedOutsideCourseUnits,
          courses: Array.from({ length: planned }, (_, index) => ({
            course: `ECO elective ${index + 1}`,
            units: 1,
            source: "future-placeholder",
            availability: { status: "unknown" },
            meeting: { days: [] }
          }))
        }]
      };
      return checkExternalEconomicsScheduleAndHorizon({
        policy: oraclePolicy,
        verifiedSchedule: oracleSchedule,
        expectedContext: { startYear: 2027, expectedGraduationYear: 2028 },
        requirementAllocation: { allocation: Array.from({ length: 12 }, () => ({})) },
        plan
      });
    }

    const before = capacityAudit(lowerReserved);
    const after = capacityAudit(higherReserved);
    const beforeExceeded = before.violations.some(item => item.code === "CAPACITY_EXCEEDED");
    const afterExceeded = after.violations.some(item => item.code === "CAPACITY_EXCEEDED");
    propertyInvariant(!beforeExceeded || afterExceeded, "Increasing reserved units removed a capacity violation.");
  },
  { seedOffset: 5 }
);

fixedSeedProperty(
  "an ungoverned injected section cannot change authoritative section options",
  fc.record({
    profile: generatedProfileArbitrary,
    offeringCase: fc.constantFrom(...meetingCompleteOfferingCases)
  }),
  ({ profile, offeringCase }) => {
    const slot = { academicYear: productionSchedule.academicYear, scheduleTerm: offeringCase.term };
    const selectedCourses = [productionSchedule.terms[offeringCase.term][0]];
    const before = eligibleOfferings(productionSchedule, slot, offeringCase.course, selectedCourses);
    const expandedSchedule = structuredClone(productionSchedule);
    expandedSchedule.terms[offeringCase.term].push({
      course: offeringCase.course,
      section: `P${String(profile.profileId).slice(-6)}`,
      title: "Fictional property-test section",
      units: 1,
      instructor: "Fictional Instructor",
      academicYear: productionSchedule.academicYear,
      term: offeringCase.term,
      meeting: {
        days: ["Sat"],
        startTime: "8:00 AM",
        endTime: "9:00 AM",
        startMinutes: 480,
        endMinutes: 540,
        startDate: "2026-08-24",
        endDate: "2026-12-11"
      },
      availability: { status: "open", seatsOpen: 10, capacity: 20, asOf: "2026-07-30" },
      verificationStatus: "verified",
      provenance: { sourceType: "fictional-property-test" }
    });
    const after = eligibleOfferings(expandedSchedule, slot, offeringCase.course, selectedCourses);
    const injected = scheduleOfferings(expandedSchedule, slot, offeringCase.course)
      .find(offering => offering.section?.startsWith("P"));
    propertyInvariant(Boolean(injected), "The injected test section was not present in the supplied schedule.");
    propertyInvariant(
      scheduleOfferingDecision(injected, slot).status === "BLOCK",
      "An injected section was treated as bundle-authoritative."
    );
    propertyInvariant(after.length >= before.length, "The local schedule view lost an existing option.");
  },
  { seedOffset: 6 }
);

fixedSeedProperty(
  "completed or in-progress courses never reappear in a future displayed plan",
  fc.constantFrom(...NO_REPEAT_CASES),
  propertyCase => {
    const { bundle } = generateBundle(structuredClone(propertyCase.student));
    const unavailable = new Set(propertyCase.student.courses
      .filter(course => ["completed", "in_progress"].includes(course.status))
      .map(course => canonicalCourse(course.code)));
    propertyInvariant(bundle.plans.length > 0, "The final-year no-repeat fixture generated no displayed plan.");
    for (const plan of bundle.plans) {
      const repeated = plan.terms.flatMap(term => term.courses)
        .map(course => canonicalCourse(course.course))
        .filter(course => unavailable.has(course));
      propertyInvariant(repeated.length === 0, `Future plan repeated ${repeated.join(", ")}.`, plan);
    }
  },
  { seedOffset: 7, heavy: true }
);

fixedSeedProperty(
  "ECO 234 and PHI 234 receive equivalent requirement treatment",
  fc.record({
    profile: generatedProfileArbitrary,
    otherCourses: fc.uniqueArray(
      fc.constantFrom(...REQUIREMENT_COURSES.filter(code => !["ECO 234", "PHI 234"].includes(code))),
      { maxLength: 8 }
    )
  }),
  ({ otherCourses }) => {
    const economics = mappingForCourses(completedCourses([...otherCourses, "ECO 234"]));
    const philosophy = mappingForCourses(completedCourses([...otherCourses, "PHI 234"]));
    const assignmentView = mapping => mapping.strict.assignments
      .map(item => ({ slotId: item.slotId, code: canonicalCourse(item.code), unitsApplied: item.unitsApplied }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    propertyInvariant(economics.strict.remainingUnits === philosophy.strict.remainingUnits,
      "Cross-list aliases changed the remaining requirement count.");
    propertyInvariant(JSON.stringify(assignmentView(economics)) === JSON.stringify(assignmentView(philosophy)),
      "Cross-list aliases changed requirement assignments.");
  },
  { seedOffset: 8 }
);

fixedSeedProperty(
  "moving a prerequisite after its dependent cannot preserve validity",
  fc.record({
    profile: generatedProfileArbitrary,
    orderCase: fc.constantFrom(...prerequisiteOrderCases)
  }),
  ({ orderCase }) => {
    const student = { courses: completedCourses(orderCase.completed) };
    const validPlan = prerequisiteOrderPlan(orderCase, false);
    const movedPlan = prerequisiteOrderPlan(orderCase, true);
    const baseline = evaluatePlanPrerequisites({
      plan: validPlan,
      student,
      prerequisites: productionPrerequisites
    });
    const moved = evaluatePlanPrerequisites({
      plan: movedPlan,
      student,
      prerequisites: productionPrerequisites
    });
    propertyInvariant(baseline.valid, `The ordered ${orderCase.prerequisite}/${orderCase.dependent} baseline was invalid.`, validPlan);
    propertyInvariant(!moved.valid, `Moving ${orderCase.prerequisite} after ${orderCase.dependent} stayed valid.`, movedPlan);
  },
  { seedOffset: 9 }
);

fixedSeedProperty(
  "interchangeable elective-slot IDs do not change semantic plan identity",
  fc.record({
    profile: generatedProfileArbitrary,
    firstCourse: fc.constantFrom("ECO 221", "ECO 234", "ECO 260", "ECO 333"),
    secondCourse: fc.constantFrom("ECO 161", "ECO 222", "ECO 315", "ECO 337")
  }),
  ({ firstCourse, secondCourse }) => {
    const first = {
      feasibilityStatus: "PRELIMINARY_ONLY",
      planningContext: { expectedGraduationTerm: "Spring/May 2028" },
      terms: [{
        slotId: "fall-2027",
        courses: [
          { course: firstCourse, requirementId: "eco-elective-1", source: "projected-offering" },
          { course: secondCourse, requirementId: "eco-elective-2", source: "projected-offering" }
        ]
      }]
    };
    const swapped = structuredClone(first);
    swapped.terms[0].courses[0].requirementId = "eco-elective-2";
    swapped.terms[0].courses[1].requirementId = "eco-elective-1";
    propertyInvariant(
      semanticPlanSignature(first) === semanticPlanSignature(swapped),
      "Swapping interchangeable elective-slot IDs changed semantic identity.",
      swapped
    );
  },
  { seedOffset: 10 }
);

fixedSeedProperty(
  "the same input and seed reproduce candidates, ranking, suppression, and search diagnostics",
  fc.constantFrom(...ORACLE_FINAL_YEAR_CASES),
  propertyCase => {
    const first = generateBundle(structuredClone(propertyCase.student)).bundle;
    const second = generateBundle(structuredClone(propertyCase.student)).bundle;
    propertyInvariant(
      JSON.stringify(deterministicBundleView(first)) === JSON.stringify(deterministicBundleView(second)),
      "Repeated deterministic generation changed candidate output.",
      second.plans[0] || null
    );
  },
  { seedOffset: 11, heavy: true }
);

fixedSeedProperty(
  "every displayed plan for a fully verified final-year profile passes the independent oracle",
  fc.constantFrom(...ORACLE_FINAL_YEAR_CASES),
  propertyCase => {
    const { bundle } = generateBundle(structuredClone(propertyCase.student));
    propertyInvariant(bundle.plans.length > 0, "The verified final-year fixture generated no displayed plan.");
    for (const plan of bundle.plans) {
      const audit = auditExternalEconomicsPlanComplete(externalOracleInput(propertyCase.student, plan));
      propertyInvariant(
        audit.valid && audit.violations.length === 0
          && audit.reviewItems.filter(item => item.code !== "RULE_FAMILY_NOT_CHECKED").length === 0,
        `Independent oracle rejected ${plan.id}: ${audit.violations.map(item => item.code).join(", ")}.`,
        plan
      );
    }
  },
  { seedOffset: 12, heavy: true }
);

fixedSeedProperty(
  "ECO 257 is allocated only to the statistics requirement",
  fc.record({
    profile: generatedProfileArbitrary,
    status: fc.constantFrom("completed", "in_progress"),
    otherCourses: fc.uniqueArray(
      fc.constantFrom("ECO 113", "ECO 114", "MAT 113", "ECO 161", "ECO 221", "ECO 234", "ECO 260"),
      { maxLength: 5 }
    )
  }),
  ({ status, otherCourses }) => {
    const mapping = mappingForCourses([
      ...completedCourses(otherCourses),
      { code: "ECO 257", status, source: "student_record", units: 1 }
    ]);
    const allocations = mapping.assignments.filter(item => item.code === "ECO 257");
    propertyInvariant(allocations.length === 1, "ECO 257 did not receive exactly one requirement assignment.");
    propertyInvariant(allocations[0].slotId === "statistics", `ECO 257 was assigned to ${allocations[0].slotId}.`);
  },
  { seedOffset: 13 }
);

fixedSeedProperty(
  "assigning ECO 257 to any Economics elective slot makes production allocation invalid",
  fc.record({
    profile: generatedProfileArbitrary,
    electiveSlot: fc.constantFrom("eco-elective-1", "eco-elective-2", "eco-elective-3", "eco-elective-4")
  }),
  ({ electiveSlot }) => {
    const allocation = buildRequirementAllocation({
      requirements: productionRequirements.requirementSlots,
      plan: {
        terms: [{ courses: [{ course: "ECO 257", requirementId: electiveSlot, units: 1 }] }]
      }
    });
    propertyInvariant(!allocation.valid, `Production accepted ECO 257 in ${electiveSlot}.`);
    propertyInvariant(allocation.errors.some(error => error.includes("ECO 257 is not a valid course")),
      "Production rejected ECO 257 for an unrelated reason only.");
  },
  { seedOffset: 14 }
);

fixedSeedProperty(
  "MAT 217 or PSY 217 satisfying statistics never makes ECO 257 elective-eligible",
  fc.record({
    profile: generatedProfileArbitrary,
    statistics: fc.constantFrom("MAT 217", "PSY 217"),
    electiveSlot: fc.constantFrom("eco-elective-1", "eco-elective-2", "eco-elective-3", "eco-elective-4")
  }),
  ({ statistics, electiveSlot }) => {
    const plan = fullRequirementPlan({ statistics, eco257ElectiveSlot: electiveSlot });
    const production = buildRequirementAllocation({
      requirements: productionRequirements.requirementSlots,
      plan
    });
    const oracle = checkExternalEconomicsRequirements({
      policy: oraclePolicy,
      student: {},
      plan
    });
    propertyInvariant(!production.valid, `Production accepted ECO 257 in ${electiveSlot} with ${statistics} as statistics.`, plan);
    propertyInvariant(!oracle.valid, `Independent oracle accepted ECO 257 in ${electiveSlot} with ${statistics} as statistics.`, plan);
    propertyInvariant(
      oracle.violations.some(item => item.code === "ELECTIVE-ECO-257-STATISTICS-ONLY"),
      "Independent oracle did not return the confirmed ECO 257 invariant.",
      plan
    );
  },
  { seedOffset: 15 }
);
