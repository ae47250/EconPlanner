import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildEconomicsTermPlan, buildEconomicsTermPlans, validateGeneratedPlan, validatePlanSet } from "../lib/planning/economics.js";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { resolvePlanningContext } from "../lib/planning/horizon.js";
import { validateStudentPrerequisites } from "../lib/planning/prerequisiteValidation.js";
import {
  canonicalScheduleCode,
  normalizeEconomicsSchedule,
  selectConflictFreeOffering
} from "../lib/planning/scheduleProvider.js";

const schedule = JSON.parse(await readFile(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));
const prerequisites = JSON.parse(await readFile(new URL("../data/normalized/economics/prerequisites.json", import.meta.url), "utf8"));
const requirements = JSON.parse(await readFile(new URL("../data/normalized/economics/requirements.json", import.meta.url), "utf8"));

function validCurrentCoursesForFuturePrerequisite(rule, focus) {
  const statuses = new Map();
  for (const required of rule.all || []) {
    statuses.set(required, focus.type === "all" && focus.code === required ? "in_progress" : "completed");
  }
  for (const [groupIndex, group] of (rule.any || []).entries()) {
    const selected = focus.type === "any" && focus.groupIndex === groupIndex
      ? focus.code
      : group[0];
    statuses.set(selected, focus.type === "any" && focus.groupIndex === groupIndex ? "in_progress" : "completed");
  }

  const expanded = new Set();
  function addCompletedPrerequisites(code) {
    if (expanded.has(code)) return;
    expanded.add(code);
    const nestedRule = prerequisites[code];
    if (!nestedRule) return;
    const requiredCodes = [
      ...(nestedRule.all || []),
      ...(nestedRule.any || []).map(group => group[0])
    ];
    for (const required of requiredCodes) {
      if (!statuses.has(required)) statuses.set(required, "completed");
      addCompletedPrerequisites(required);
    }
  }

  for (const code of [...statuses.keys()]) addCompletedPrerequisites(code);
  return [...statuses].map(([code, status]) => ({ code, status }));
}

test("Economics term planner keeps prerequisite courses in earlier terms", () => {
  const student = {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    courses: [
      { code: "ECO 113", status: "completed" },
      { code: "ECO 114", status: "completed" },
      { code: "MAT 113", status: "completed" },
      { code: "ECO 214", status: "completed" }
    ]
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const plan = buildEconomicsTermPlan({
    student,
    mapping,
    schedule,
    prerequisites,
    planningMode: "graduation_priority"
  });
  const fall = plan.terms.find(term => term.term === "Fall 2026").courses.map(course => course.course);
  const winter = plan.terms.find(term => term.term === "Winter 2027").courses.map(course => course.course);

  assert.ok(fall.includes("ECO 213"));
  assert.ok(winter.includes("ECO 461"));
  assert.ok(!winter.includes("ECO 213"));
  assert.equal(plan.validation.valid, true);
});

test("dated freshman planning returns only the selected standard horizon", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-09-01",
    courses: []
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });

  assert.ok(result.plans.length >= 2 && result.plans.length <= 3);
  assert.ok(result.plans.some(plan => plan.label === "Plan A"));
  assert.ok(result.plans.every(plan => plan.label !== "Plan C-2"));
  assert.deepEqual(result.candidateOutcomes.map(outcome => outcome.label), ["Plan A", "Plan B", "Plan C"]);
  assert.equal(result.planSetValidation.valid, true);
  assert.equal(result.planSetValidation.uniquePlanCount, result.plans.length);
  const expectedDistributions = new Map([
    ["Plan A", [3, 3, 3, 3]],
    ["Plan B", [1, 2, 4, 5]],
    ["Plan C", [3, 3, 3, 3]]
  ]);
  for (const plan of result.plans) {
    assert.deepEqual(plan.distribution.targetYearCounts, expectedDistributions.get(plan.label));
    assert.deepEqual(plan.validation.distribution.actualYearCounts, expectedDistributions.get(plan.label));
    assert.equal(plan.validation.distribution.valid, true);
    assert.equal(plan.validation.distribution.exact, true);
  }
  assert.ok(result.plans.every(plan => plan.validation.valid));
  const exploreFirst = result.plans.find(plan => plan.label === "Plan C");
  assert.ok(exploreFirst.terms.filter(term => term.yearIndex === 0)
    .flatMap(term => term.courses)
    .some(course => course.course === "ECO 113"));
  assert.ok(exploreFirst.terms.filter(term => term.yearIndex === 0)
    .flatMap(term => term.courses)
    .some(course => course.course === "ECO 114"));
  assert.ok(exploreFirst.terms.filter(term => term.yearIndex === 0)
    .flatMap(term => term.courses)
    .some(course => [
      "MAT 113", "MAT 121", "MAT 217", "ECO 257", "PSY 217",
      "Mathematics cognate", "Statistics requirement"
    ].includes(course.course)));
  assert.ok(result.candidateOutcomes.every(outcome => outcome.candidatePool?.retainedDistinctSchedules >= 1));
  assert.equal(result.context.expectedGraduationTerm, "Spring/May 2030");
  assert.ok(result.plans.find(plan => !plan.isEarlyGraduation).terms.some(term => (
    term.term === "2029/2030 term to be confirmed" && term.termKey === "TBC"
  )));
  assert.equal(result.plans[0].terms[0].displayTerm, "Winter");
  assert.equal(result.plans[0].terms[0].academicYear, "2026/2027");
  assert.ok(result.plans.every(plan => plan.terms.every(term => !term.isSummer)));
  assert.ok(result.plans.every(plan => plan.terms.every(term => (
    term.termKey === "TBC" || term.courses.length <= (term.term.startsWith("Spring/May") ? 1 : 4)
  ))));

});

test("confirmed one-year-early planning returns only the shortened horizon", () => {
  const student = {
    academicStanding: "freshman",
    planningPace: "one_year_early",
    planCreationDate: "2026-09-01",
    projectedSeniorStandingConfirmation: {
      status: "STUDENT_REPORTED_REGISTRAR_OR_ADVISOR_CONFIRMATION",
      academicYear: "2028/2029"
    },
    courses: []
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });

  assert.deepEqual(result.candidateOutcomes.map(outcome => outcome.label), ["Plan C-2"]);
  assert.equal(result.plans.length, 1);
  assert.deepEqual(result.plans[0].distribution.targetYearCounts, [4, 4, 4]);
  assert.equal(result.plans[0].isEarlyGraduation, true);
  assert.equal(result.plans[0].planningContext.expectedGraduationTerm, "Spring/May 2029");
  assert.equal(result.plans[0].feasibilityStatus, "PRELIMINARY_ONLY");
});

test("a proven prerequisite constraint records a validated distribution exception", () => {
  const unresolved = [{ requirementId: "eco-461", options: ["ECO 461"] }];
  const mapping = {
    requirements: [{ id: "eco-461", kind: "exact", label: "Senior Seminar", options: ["ECO 461"] }],
    assignments: [],
    optimistic: { unresolved },
    projectedAfterInProgress: { optimistic: { unresolved } }
  };
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-08-02",
    courses: ["ECO 113", "ECO 114", "MAT 113", "ECO 213", "ECO 214", "MAT 217"]
      .map(code => ({ code, status: "completed" }))
  };
  const plan = buildEconomicsTermPlan({ student, mapping, schedule, prerequisites });

  assert.deepEqual(plan.distribution.targetYearCounts, [1, 0, 0, 0]);
  assert.deepEqual(plan.validation.distribution.actualYearCounts, [0, 0, 0, 1]);
  assert.equal(plan.preferredDistributionException.code, "PREFERRED_DISTRIBUTION_EXCEPTION");
  assert.equal(plan.preferredDistributionException.allowedAnnualDistance, 2);
  assert.equal(plan.validation.distribution.valid, true);
  assert.equal(plan.validation.distribution.exact, false);
  assert.ok(plan.validation.warnings.some(message => /exact Balanced yearly distribution is not feasible/.test(message)));

  const unprovenException = structuredClone(plan);
  delete unprovenException.search.attempts;
  const validation = validateGeneratedPlan(unprovenException, {
    student,
    mapping,
    schedule,
    prerequisites,
    context: plan.planningContext
  });
  assert.equal(validation.valid, true);
  assert.equal(validation.distribution.valid, false);
  assert.ok(validation.warnings.some(message => /yearly distribution/.test(message)));
});

test("validated plans cover every required course, choice group, cognate, and elective slot", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-09-01",
    courses: []
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
  const requiredIds = new Set(requirements.requirementSlots.map(slot => slot.id));

  assert.equal(requiredIds.size, 12);
  for (const plan of result.plans) {
    const coveredIds = new Set([
      ...mapping.assignments.map(assignment => assignment.slotId),
      ...plan.terms.flatMap(term => term.courses.map(course => course.requirementId))
    ]);
    assert.deepEqual(coveredIds, requiredIds);
    assert.equal(plan.validation.valid, true);
  }
});

test("a used 100-level elective restricts every remaining elective to level 200 or above", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-09-01",
    courses: [{ code: "ECO 161", status: "in_progress" }]
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });

  assert.ok(mapping.assignments.some(assignment => assignment.slotId.startsWith("eco-elective") && assignment.code === "ECO 161"));
  assert.ok(result.plans.every(plan => plan.terms.every(term => term.courses.every(course => (
    course.course !== "ECO elective"
      || course.minimumLevel === 200
  )))));
  assert.ok(result.plans.every(plan => plan.validation.valid));

  const invalidPlan = structuredClone(result.plans[0]);
  const placeholder = invalidPlan.terms.flatMap(term => term.courses).find(course => course.course === "ECO elective");
  delete placeholder.minimumLevel;
  const validation = validateGeneratedPlan(invalidPlan, {
    student,
    mapping,
    schedule,
    prerequisites,
    context: result.context
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes("200 level or above")));
});

test("standing-specific candidate limits show only distinct feasible results", () => {
  const sophomore = {
    academicStanding: "sophomore",
    planCreationDate: "2026-09-01",
    courses: []
  };
  const sophomoreMapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, sophomore);
  const sophomorePlans = buildEconomicsTermPlans({ student: sophomore, mapping: sophomoreMapping, schedule, prerequisites });
  assert.ok(sophomorePlans.plans.length <= 3);
  assert.ok(sophomorePlans.candidateOutcomes.every(outcome => outcome.id !== "plan-c2"));
  assert.equal(sophomorePlans.candidateOutcomes.length, 3);

  const junior = {
    academicStanding: "junior",
    planCreationDate: "2026-07-30",
    courses: []
  };
  const juniorMapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, junior);
  const juniorPlans = buildEconomicsTermPlans({ student: junior, mapping: juniorMapping, schedule, prerequisites });
  assert.ok(juniorPlans.plans.length > 0 && juniorPlans.plans.length <= 2);
  assert.ok(juniorPlans.plans.every(plan => plan.validation.valid));
  assert.ok(juniorPlans.plans.every(plan => (
    plan.terms.flatMap(term => term.courses).some(course => course.course === "ECO 461")
  )));
});

test("named courses are not placed from a different academic year's schedule", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2027-09-01",
    courses: []
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });

  assert.ok(result.plans.every(plan => plan.terms.every(term => (
    term.termKey === "TBC"
      && term.isPlaceholder === true
      && term.courses.every(course => course.termToBeConfirmed === true && course.projectedTerm)
  ))));
  assert.ok(result.plans.every(plan => plan.feasibilityStatus === "PRELIMINARY_ONLY"));
});

test("generated-plan validation rejects a fabricated course", () => {
  const student = { academicStanding: "senior", courses: [] };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const validation = validateGeneratedPlan({
    terms: [{
      term: "Fall",
      termKey: "Fall",
      scheduleTerm: "Fall",
      academicYear: "2026/2027",
      courses: [{ course: "ECO 999", requirementId: "eco-113", source: "verified-offering" }]
    }]
  }, { student, mapping, schedule, prerequisites });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes("ECO 999")));
});

test("verified-year planning uses verified named courses and rejects generic or named placeholders", () => {
  const student = {
    academicStanding: "junior",
    planCreationDate: "2026-07-30",
    courses: [
      { code: "ECO 113", status: "completed" },
      { code: "ECO 114", status: "completed" },
      { code: "MAT 113", status: "completed" },
      { code: "ECO 213", status: "completed" },
      { code: "ECO 214", status: "completed" },
      { code: "MAT 217", status: "completed" }
    ]
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
  const verifiedYearCourses = result.plans.flatMap(plan => plan.terms
    .filter(term => term.academicYear.replace("/", "-") === schedule.academicYear)
    .flatMap(term => term.courses));

  assert.ok(result.plans.length > 0);
  assert.ok(verifiedYearCourses.length > 0);
  assert.ok(verifiedYearCourses.every(course => course.course !== "ECO elective"));
  assert.ok(verifiedYearCourses.every(course => course.source !== "requirement-placeholder"));
  assert.ok(verifiedYearCourses.every(course => (
    course.source === "verified-offering" || course.source === "summer-last-resort"
  )));

  for (const course of [
    { course: "ECO elective", requirementId: "eco-elective-1", source: "projected-offering" },
    { course: "BUSN 323", requirementId: "finance", source: "requirement-placeholder" }
  ]) {
    const validation = validateGeneratedPlan({
      terms: [{
        term: "Fall 2026",
        termKey: "Fall",
        scheduleTerm: "Fall",
        academicYear: schedule.academicYear,
        courses: [course]
      }]
    }, { student, mapping, schedule, prerequisites });
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(error => /verified schedule/.test(error)), course.course);
  }
});

test("plan-set validation rejects duplicate placements", () => {
  const plan = { id: "plan-1", label: "Plan A", terms: [{ term: "Fall", courses: [{ course: "ECO elective" }] }] };
  const validation = validatePlanSet([plan, { ...plan, id: "plan-2", label: "Plan B" }, { ...plan, id: "plan-3", label: "Plan C" }]);

  assert.equal(validation.valid, false);
  assert.equal(validation.uniquePlanCount, 1);
  assert.equal(validation.pairwise.every(pair => pair.different === false), true);
});

test("ECO 113 avoids Summer when a regular future placement remains feasible", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-09-01",
    courses: []
  };
  const noRegularECO113Schedule = structuredClone(schedule);
  noRegularECO113Schedule.terms.Fall = noRegularECO113Schedule.terms.Fall.filter(course => course.course !== "ECO 113");
  noRegularECO113Schedule.terms.Winter = noRegularECO113Schedule.terms.Winter.filter(course => course.course !== "ECO 113");
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({
    student,
    mapping,
    schedule: noRegularECO113Schedule,
    prerequisites
  });
  assert.ok(result.plans.length > 0);
  assert.ok(result.plans.every(plan => plan.terms.every(term => !term.isSummer || term.courses.length === 0)));
  assert.ok(result.plans.every(plan => plan.terms.some(term => (
    !term.isSummer && term.courses.some(course => course.course === "ECO 113")
  ))));
  assert.ok(result.plans.every(plan => plan.summerFallbacks.length === 0));
});

test("ECO 307 does not satisfy one of the four full-unit elective slots", () => {
  const mapping = mapStudentToProgram(
    { id: "economics", name: "Economics" },
    requirements,
    { courses: [{ code: "ECO 307", status: "completed", units: 0.5 }] }
  );

  assert.equal(mapping.strict.assignments.some(item => item.code === "ECO 307"), false);
  assert.equal(mapping.strict.remainingUnits, 12);
});

test("ECO 461 remains required and Hanover-only in the normalized requirements", () => {
  const capstone = requirements.requirementSlots.find(slot => slot.id === "eco-461");

  assert.equal(capstone.options[0], "ECO 461");
  assert.equal(capstone.residency, "hanover");
});

test("a legacy non-Hanover ECO 461 record does not suppress the required senior-Winter placement", () => {
  const student = {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    summerStandingConfirmed: "yes",
    courses: [
      { code: "ECO 113", status: "completed" },
      { code: "ECO 114", status: "completed" },
      { code: "ECO 213", status: "completed" },
      { code: "ECO 214", status: "completed" },
      { code: "ECO 257", status: "completed" },
      { code: "MAT 113", status: "completed" },
      { code: "BUSN 323", status: "completed" },
      { code: "ECO 221", status: "completed" },
      { code: "ECO 222", status: "completed" },
      { code: "ECO 234", status: "completed" },
      { code: "ECO 333", status: "completed" },
      { code: "ECO 461", status: "transfer", source: "transfer" }
    ]
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const plan = buildEconomicsTermPlan({ student, mapping, schedule, prerequisites });
  const winter = plan.terms.find(term => term.term === "Winter 2027");

  assert.ok(winter.courses.some(course => course.course === "ECO 461"));
});

test("an ungoverned supporting-course schedule cannot create concurrent-math authority", () => {
  const student = {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    summerStandingConfirmed: "yes",
    courses: [
      { code: "ECO 113", status: "completed" },
      { code: "ECO 114", status: "completed" },
      { code: "ECO 214", status: "completed" },
      { code: "ECO 257", status: "completed" },
      { code: "BUSN 323", status: "completed" },
      { code: "ECO 221", status: "completed" },
      { code: "ECO 222", status: "completed" },
      { code: "ECO 223", status: "completed" },
      { code: "ECO 224", status: "completed" },
      { code: "ECO 461", status: "completed" }
    ]
  };
  const concurrentSchedule = structuredClone(schedule);
  concurrentSchedule.terms.Fall.push({
    course: "MAT 113",
    section: "A",
    title: "Mathematics cognate",
    verificationStatus: "verified"
  });
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const strictPlan = buildEconomicsTermPlan({
    student,
    mapping,
    schedule: concurrentSchedule,
    prerequisites,
    allowConcurrentMath: false
  });
  const fallbackPlan = buildEconomicsTermPlan({
    student,
    mapping,
    schedule: concurrentSchedule,
    prerequisites,
    allowConcurrentMath: true
  });

  assert.equal(strictPlan.validation.valid, false);
  assert.equal(fallbackPlan.validation.valid, false);
  assert.ok(fallbackPlan.unscheduled.some(item => ["cognate", "eco-213"].includes(item.requirementId)));
});

test("an in-progress prerequisite unlocks a dependent course only after the current term", () => {
  const student = {
    academicStanding: "sophomore",
    planCreationDate: "2027-02-01",
    courses: [
      { code: "ECO 213", status: "completed" },
      { code: "ECO 257", status: "in_progress" },
      { code: "MAT 121", status: "completed" }
    ]
  };
  const context = resolvePlanningContext(student);
  const mapping = {
    requirements: [{ id: "eco-335-test", kind: "exact", options: ["ECO 335"] }],
    assignments: [],
    optimistic: {
      unresolved: [{ requirementId: "eco-335-test", options: ["ECO 335"] }]
    }
  };
  const futureTerm = {
    term: "Term to be confirmed",
    termKey: "TBC",
    academicYear: "2027/2028",
    yearIndex: 1,
    absoluteStandingIndex: 2,
    seniorStandingBasis: null,
    isPlaceholder: true,
    inProgressPrerequisitesAvailable: true,
    courses: [{
      course: "ECO 335",
      requirementId: "eco-335-test",
      source: "future-placeholder"
    }]
  };
  const currentTerm = {
    ...futureTerm,
    inProgressPrerequisitesAvailable: false
  };

  const currentValidation = validateGeneratedPlan({ terms: [currentTerm] }, {
    student,
    mapping,
    schedule,
    prerequisites,
    context
  });
  const futureValidation = validateGeneratedPlan({ terms: [futureTerm] }, {
    student,
    mapping,
    schedule,
    prerequisites,
    context
  });

  assert.equal(currentValidation.valid, false);
  assert.ok(currentValidation.errors.some(error => /ECO 335 is missing prerequisites: ECO 257/.test(error)));
  assert.equal(futureValidation.valid, true);
});

test("every prerequisite option marked in progress unlocks its dependent course in a later term", () => {
  const threePartPrerequisiteCourses = Object.entries(prerequisites)
    .filter(([, rule]) => (rule.all || []).length + (rule.any || []).length >= 3)
    .map(([code]) => code);

  assert.deepEqual(threePartPrerequisiteCourses, ["ECO 335", "ECO 461", "ECO 471"]);

  let checkedScenarioCount = 0;

  for (const [code, rule] of Object.entries(prerequisites)) {
    const scenarios = [
      ...(rule.all || []).map(required => ({ type: "all", code: required })),
      ...(rule.any || []).flatMap((group, groupIndex) => (
        group.map(option => ({ type: "any", groupIndex, code: option }))
      ))
    ];

    for (const focus of scenarios) {
      const student = {
        academicStanding: "sophomore",
        planCreationDate: "2027-02-01",
        courses: validCurrentCoursesForFuturePrerequisite(rule, focus)
      };
      const inputValidation = validateStudentPrerequisites(student.courses, prerequisites);
      const requirementId = ({
        "ECO 113": "eco-113",
        "ECO 114": "eco-114",
        "ECO 213": "eco-213",
        "ECO 214": "eco-214",
        "ECO 257": "statistics",
        "ECO 321": "finance",
        "ECO 461": "eco-461"
      })[code] || "eco-elective-1";
      const mapping = {
        requirements: [{
          id: requirementId,
          kind: "exact",
          label: code,
          options: [code]
        }],
        assignments: [],
        optimistic: {
          unresolved: [{ requirementId, options: [code] }]
        }
      };
      const plan = buildEconomicsTermPlan({
        student,
        mapping,
        schedule,
        prerequisites,
        allowConcurrentMath: false
      });
      const placement = plan.terms
        .flatMap(term => term.courses.map(course => ({ course, term })))
        .find(item => item.course.course === code);
      const scenario = `${code} with ${focus.code} in progress`;

      assert.equal(inputValidation.valid, true, `${scenario} must be a valid current-course record`);
      assert.equal(plan.validation.valid, true, `${scenario}: ${plan.validation.errors.join(" | ")}`);
      assert.ok(placement, `${scenario} must be scheduled`);
      assert.notEqual(placement.term.term, "Winter 2027", `${scenario} cannot be placed in the running term`);
      assert.ok(
        placement.term.yearIndex > 0
          || placement.term.termKey === "Spring"
          || placement.term.inProgressPrerequisitesAvailable === true,
        `${scenario} must be placed after the current term`
      );
      if (code === "ECO 222" && focus.code === "ECO 114") {
        assert.equal(placement.term.term, "Spring/May 2027");
      }
      if (code === "ECO 357") {
        assert.ok(placement.course.approvalRequired.some(approval => (
          approval.type === "department" && approval.prerequisite === null
        )), `${scenario} retains its separate department-permission condition`);
      } else {
        assert.equal(placement.course.approvalRequired, undefined, `${scenario} is sequential, not concurrent`);
      }
      checkedScenarioCount += 1;
    }
  }

  assert.equal(checkedScenarioCount, 36);
});

test("normal plans do not use concurrent math when prerequisite-first placement is available", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-09-01",
    courses: []
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });

  assert.ok(result.plans.length > 0);
  assert.ok(result.plans.filter(plan => !plan.isEarlyGraduation).every(plan => (
    plan.terms.every(term => term.courses.every(course => !course.approvalRequired))
  )));
});

function upcomingSenior(codes) {
  return {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    summerStandingConfirmed: "yes",
    courses: codes.map(code => ({ code, status: "completed" }))
  };
}

test("graduation priority uses verified Economics offerings plus an explicit supporting placeholder", () => {
  const student = upcomingSenior(["ECO 113", "ECO 114", "MAT 113", "ECO 214"]);
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });

  assert.equal(result.plans.length, 1);
  assert.equal(result.planSetValidation.valid, true);
  assert.equal(result.planSetValidation.uniquePlanCount, 1);

  for (const plan of result.plans) {
    assert.equal(plan.planningMode, "graduation_priority");
    assert.equal(plan.validation.valid, true);
    const fall = plan.terms.find(term => term.term === "Fall 2026");
    const winter = plan.terms.find(term => term.term === "Winter 2027");
    const may = plan.terms.find(term => term.term === "Spring/May 2027");
    assert.deepEqual(fall.courses.map(course => course.course), ["ECO 213", "ECO 234", "ECO 333", "Statistics requirement"]);
    assert.deepEqual(winter.courses.map(course => course.course), ["ECO 221", "ECO 321", "ECO 461"]);
    assert.ok(["ECO 222", "ECO 260"].includes(may.courses[0].course));
    assert.ok(plan.validation.warnings.some(warning => /more than two Economics courses/.test(warning)));
    assert.ok(plan.validation.warnings.some(warning => /confirm whether MAT 217, ECO 257, or PSY 217/.test(warning)));
    assert.ok(plan.terms.every(term => term.courses.length <= (term.termKey === "May" ? 1 : 4)));
    assert.ok(plan.terms.flatMap(term => term.courses).filter(course => course.course.startsWith("ECO ")).every(course => (
      ["verified-offering", "summer-last-resort"].includes(course.source)
    )));
  }
});

test("one intermediate may share Winter with ECO 461, while both missing remains blocking", () => {
  const approvedStudent = upcomingSenior(["ECO 113", "ECO 114", "MAT 113", "ECO 213"]);
  const approvedMapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, approvedStudent);
  const approved = buildEconomicsTermPlans({ student: approvedStudent, mapping: approvedMapping, schedule, prerequisites });
  assert.equal(approved.plans.length, 1);
  const winter461 = approved.plans[0].terms
    .flatMap(term => term.courses)
    .find(course => course.course === "ECO 461");
  assert.ok(winter461.approvalRequired.some(item => item.type === "department" && item.prerequisite === "ECO 214"));

  const blockedStudent = upcomingSenior(["ECO 113", "ECO 114", "MAT 113"]);
  const blockedMapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, blockedStudent);
  const blocked = buildEconomicsTermPlans({ student: blockedStudent, mapping: blockedMapping, schedule, prerequisites });
  assert.equal(blocked.plans.length, 0);
  assert.ok(blocked.planningGaps.some(gap => gap.requirementId === "eco-461" || /ECO 461/.test(gap.message || "")));
});

test("graduation overload is a warning, while a fifth total course remains blocking", () => {
  const student = upcomingSenior(["ECO 113", "ECO 114", "MAT 113", "ECO 214"]);
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
  const overloaded = structuredClone(result.plans[0]);
  const fall = overloaded.terms.find(term => term.term === "Fall 2026");

  assert.equal(overloaded.validation.valid, true);
  assert.ok(overloaded.validation.warnings.some(warning => /more than two Economics courses/.test(warning)));
  fall.courses.push({
    course: "ECO 260",
    title: "Special Topics",
    requirementId: "eco-elective-4",
    source: "verified-offering"
  });
  const validation = validateGeneratedPlan(overloaded, {
    student,
    mapping,
    schedule,
    prerequisites,
    context: result.context
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => /exceeds the total course limit/.test(error)));
});

test("generic statistics placement does not satisfy an ECO 257-specific prerequisite", () => {
  const student = upcomingSenior(["ECO 113", "ECO 114", "MAT 121", "ECO 213", "ECO 214"]);
  const mapping = {
    requirements: [
      { id: "statistics", kind: "choice", options: ["MAT 217", "ECO 257", "PSY 217"] },
      { id: "eco-335-test", kind: "exact", options: ["ECO 335"] }
    ],
    assignments: [],
    optimistic: { unresolved: [
      { requirementId: "statistics", options: ["MAT 217", "ECO 257", "PSY 217"] },
      { requirementId: "eco-335-test", options: ["ECO 335"] }
    ] }
  };
  const plan = {
    planningMode: "graduation_priority",
    terms: [
      {
        term: "Fall 2026",
        termKey: "Fall",
        academicYear: "2026/2027",
        courses: [{
          course: "Statistics requirement",
          requirementId: "statistics",
          source: "requirement-placeholder",
          offeringStatus: "schedule_confirmation_required",
          options: ["MAT 217", "ECO 257", "PSY 217"]
        }]
      },
      {
        term: "Term to be confirmed",
        termKey: "TBC",
        academicYear: "2026/2027",
        isPlaceholder: true,
        inProgressPrerequisitesAvailable: true,
        courses: [{ course: "ECO 335", requirementId: "eco-335-test", source: "future-placeholder" }]
      }
    ]
  };
  const validation = validateGeneratedPlan(plan, { student, mapping, schedule, prerequisites });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => /ECO 335 is missing prerequisites: ECO 257/.test(error)));
});

test("standard mode remains preferred when it can finish the senior plan", () => {
  const student = upcomingSenior([
    "ECO 113", "ECO 114", "MAT 113", "ECO 213", "ECO 214", "ECO 257", "BUSN 323",
    "ECO 234", "ECO 333", "ECO 221", "ECO 222"
  ]);
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
  assert.ok(result.plans.length > 0);
  assert.ok(result.plans.every(plan => plan.planningMode === "standard"));
});

test("schedule provider normalizes provenance, cross-lists, and meeting conflicts", () => {
  const normalized = normalizeEconomicsSchedule(schedule);
  const winter = { academicYear: "2026/2027", scheduleTerm: "Winter" };
  const eco321 = selectConflictFreeOffering(normalized, winter, "ECO 321");

  assert.equal(normalized.provider.schemaVersion, 2);
  assert.equal(normalized.provider.verifiedOn, null);
  assert.equal(normalized.provider.repositoryIngestedOn, "2026-07-28");
  assert.equal(normalized.provider.availabilityAsOf, null);
  assert.equal(canonicalScheduleCode(normalized, "PHI 234"), "ECO 234");
  assert.equal(selectConflictFreeOffering(normalized, winter, "ECO 161", [eco321]), null);
  assert.ok(eco321.meeting.startMinutes < eco321.meeting.endMinutes);
});

test("verified schedule facts and the graduation horizon are authoritative", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-07-30",
    courses: []
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
  const plan = result.plans[0];
  const verifiedCourse = plan.terms
    .flatMap(term => term.courses)
    .find(course => course.source === "verified-offering"
      && course.meeting?.startTime
      && Number.isFinite(course.availability?.seatsOpen));

  assert.ok(verifiedCourse);
  assert.equal(validateGeneratedPlan(plan, {
    student,
    mapping,
    schedule,
    prerequisites,
    context: result.context
  }).valid, true, "unmodified canonical meeting and availability data must pass");

  const falsifiedMeeting = structuredClone(plan);
  const meetingCourse = falsifiedMeeting.terms
    .flatMap(term => term.courses)
    .find(course => course.course === verifiedCourse.course && course.section === verifiedCourse.section);
  meetingCourse.meeting.startTime = "1:00 PM";
  meetingCourse.meeting.startMinutes = 780;
  const meetingValidation = validateGeneratedPlan(falsifiedMeeting, {
    student, mapping, schedule, prerequisites, context: result.context
  });
  assert.equal(meetingValidation.valid, true, "client-supplied meeting metadata is ignored and reconstructed from the bundle");

  const falsifiedAvailability = structuredClone(plan);
  const availabilityCourse = falsifiedAvailability.terms
    .flatMap(term => term.courses)
    .find(course => course.course === verifiedCourse.course && course.section === verifiedCourse.section);
  availabilityCourse.availability.seatsOpen += 7;
  const availabilityValidation = validateGeneratedPlan(falsifiedAvailability, {
    student, mapping, schedule, prerequisites, context: result.context
  });
  assert.equal(availabilityValidation.valid, true, "client-supplied seat counts are ignored and reconstructed from the bundle");

  const afterGraduation = structuredClone(plan);
  const finalTerm = afterGraduation.terms.at(-1);
  finalTerm.academicYear = `${result.context.expectedGraduationYear}/${result.context.expectedGraduationYear + 1}`;
  finalTerm.yearIndex = result.context.remainingYears;
  finalTerm.term = `Fall ${result.context.expectedGraduationYear}`;
  finalTerm.displayTerm = "Fall";
  finalTerm.termKey = "Fall";
  finalTerm.scheduleTerm = "Fall";
  finalTerm.slotId = `fall-${result.context.expectedGraduationYear}`;
  const horizonValidation = validateGeneratedPlan(afterGraduation, {
    student, mapping, schedule, prerequisites, context: result.context
  });
  assert.equal(horizonValidation.valid, false);
  assert.ok(horizonValidation.errors.some(error => /authoritative graduation planning horizon/.test(error)));
  assert.ok(plan.terms.some(term => (
    term.academicYear === `${result.context.expectedGraduationYear - 1}/${result.context.expectedGraduationYear}`
    && term.termKey === "TBC"
  )), "the final academic year must remain present as a term-to-be-confirmed control");
});
