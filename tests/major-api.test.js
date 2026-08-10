import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/majors/map/route.js";

test("major mapper returns every captured program and Economics schedule", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student: { academicStanding: "freshman", planCreationDate: "2025-09-01", courses: [] } })
  }));
  const data = await response.json();
  const economics = data.programs.find(result => result.program?.id === "economics-base");

  assert.equal(response.status, 200);
  assert.ok(data.summary.programCount >= 37);
  assert.equal(data.summary.mappedProgramCount, 1);
  assert.deepEqual(data.catalog.evaluatedCatalogYears, ["2025-2026"]);
  assert.equal(data.catalog.basis, "entry_catalog_year_inferred_from_standing_and_plan_date");
  assert.equal(data.catalog.selectedCatalogYear, "2025-2026");
  assert.equal(data.catalog.requestedCatalogYear, "2025-2026");
  assert.equal(data.catalog.catalogResolutionStatus, "owner_designated_matches_incoming");
  assert.equal(data.catalog.comparisonStatus, "no_change");
  assert.equal(data.catalog.catalogApplicability.status, "OWNER_DESIGNATED_REQUIREMENTS_MATCH_INCOMING_CATALOG");
  assert.equal(data.catalog.governingMajorCatalogYear, "2025-2026");
  assert.ok(!data.catalog.advisorAttention.some(item => item.code === "FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE"));
  assert.equal(economics.economicsPlanResult.category, "PLANS_READY");
  assert.equal(economics.economicsPlanResult.reason, "VALIDATED_PLANS_RETURNED");
  assert.deepEqual(
    economics.economicsPlanResult.evidence.candidateOutcomes,
    economics.economicsCandidateOutcomes
  );
  assert.ok(economics.economicsPlans.every(plan => plan.publicationStatus === "PLANNING_PROJECTION"));
  assert.equal(economics.annualSchedule.academicYear, "2026-2027");
  assert.ok(economics.annualSchedule.terms.May.some(course => course.section === "S"));
});

test("major mapper treats summer standing as the upcoming Fall without clarification", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "freshman",
        planCreationDate: "2026-07-26",
        courses: []
      }
    })
  }));
  const data = await response.json();
  const economics = data.programs.find(result => result.program?.id === "economics-base");

  assert.equal(response.status, 200);
  assert.equal(economics.planningContext.requiresSummerClarification, false);
  assert.equal(economics.planningContext.standingBasis, "upcoming_fall");
  assert.equal(economics.planningContext.expectedGraduationTerm, "Spring/May 2030");
});

test("major mapper validates transfer graduation and Hanover entry years", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        isTransferStudent: true,
        transferExpectedGraduationYear: "2032",
        transferEntryAcademicYear: "2026-2027",
        planCreationDate: "2027-01-10",
        courses: []
      }
    })
  }));
  const data = await response.json();

  assert.equal(response.status, 422);
  assert.equal(data.code, "INVALID_TRANSFER_PLANNING_INPUT");
  assert.match(data.error, /2027 through 2031/);
});

test("major mapper asks the exact missing plan-date question", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student: { academicStanding: "freshman", courses: [] } })
  }));
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.equal(data.economicsPlanResult.category, "INPUT_BLOCKED");
  assert.deepEqual(data.economicsPlanResult.questions, [{
    field: "planCreationDate",
    prompt: "What date should this plan use?"
  }]);
  assert.deepEqual(data.economicsPlanResult.questions, data.inputResolution.questions);
});

test("a matching incoming catalog needs no SAC notification", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "freshman",
        planCreationDate: "2025-09-01",
        majorDeclarationCatalogYear: "2025-2026",
        courses: []
      }
    })
  }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.catalog.catalogApplicability.status, "OWNER_DESIGNATED_REQUIREMENTS_MATCH_INCOMING_CATALOG");
  assert.equal(data.catalog.governingMajorCatalogYear, "2025-2026");
  assert.equal(data.catalog.selectionAuthority, "OWNER_DESIGNATED_MOST_FLEXIBLE_ECONOMICS_MAJOR_REQUIREMENT_SET");
  assert.ok(!data.catalog.advisorAttention.some(item => item.code === "FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE"));
});

test("major mapper accepts one-year-early plans without a senior-standing confirmation field", async () => {
  for (const legacyConfirmation of [undefined, {status: "STALE_LEGACY_INPUT", academicYear: "2027/2028"}]) {
    const response = await POST(new Request("http://localhost/api/majors/map", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        student: {
          academicStanding: "freshman",
          planningPace: "one_year_early",
          planCreationDate: "2026-07-26",
          ...(legacyConfirmation ? {projectedSeniorStandingConfirmation: legacyConfirmation} : {}),
          courses: []
        }
      })
    }));
    const data = await response.json();
    assert.equal(response.status, 200);
    const economics = data.programs.find(result => result.program?.id === "economics-base");
    assert.equal(economics.planningContext.expectedGraduationTerm, "Spring/May 2030");
    assert.ok(!Object.hasOwn(economics.planningContext, "projectedSeniorStandingConfirmation"));
    assert.ok(economics.economicsPlans.some(plan => plan.id === "balanced"));
    const accelerated = economics.economicsPlans.find(plan => plan.id === "one-year-early");
    assert.ok(accelerated);
    assert.equal(economics.economicsAcceleratedResult.status, "POSSIBLE");
    assert.equal(economics.economicsAcceleratedResult.standardTarget, "Spring/May 2030");
    assert.equal(economics.economicsAcceleratedResult.acceleratedTarget, "Spring/May 2029");
    assert.equal(accelerated.studentNotices.filter(notice => notice.code === "ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED").length, 1);
    const capstoneTerm = accelerated.terms.find(term => term.courses.some(course => course.course === "ECO 461"));
    assert.equal(capstoneTerm?.termKey, "Winter");
    assert.equal(capstoneTerm?.seniorStandingBasis, "accelerated_plan_assumes_senior_standing_in_final_year");
  }

  const compressedTransferResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        isTransferStudent: true,
        transferExpectedGraduationYear: "2027",
        transferEntryAcademicYear: "2026-2027",
        planCreationDate: "2027-01-10",
        courses: []
      }
    })
  }));
  const compressedTransfer = await compressedTransferResponse.json();
  assert.equal(compressedTransferResponse.status, 200);
  assert.equal(compressedTransfer.programs[0].planningContext.acceleratedPlanAssumesSeniorStanding, true);
});

test("major mapper evaluates Junior Graduate next year and normalizes Senior requests", async () => {
  for (const academicStanding of ["junior", "senior"]) {
    const response = await POST(new Request("http://localhost/api/majors/map", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        student: {
          academicStanding,
          planningPace: "one_year_early",
          planCreationDate: "2026-07-30",
          courses: []
        }
      })
    }));
    const data = await response.json();
    const economics = data.programs.find(result => result.program?.id === "economics-base");

    assert.equal(response.status, 200, academicStanding);
    assert.equal(economics.planningContext.planningPace, "standard", academicStanding);
    if (academicStanding === "junior") {
      assert.equal(economics.planningContext.earlyComparisonRequested, true);
      assert.equal(economics.planningContext.planningPaceNormalization, null);
      assert.ok(economics.economicsCandidateOutcomes.some(outcome => outcome.id === "one-year-early"));
      assert.equal(economics.economicsAcceleratedResult.label, "Graduate next year");
      assert.equal(economics.economicsAcceleratedResult.acceleratedTarget, "Spring/May 2027");
      assert.ok(["POSSIBLE", "NOT_POSSIBLE", "MORE_INFORMATION_NEEDED"].includes(economics.economicsAcceleratedResult.status));
    } else {
      assert.equal(economics.planningContext.earlyComparisonRequested, false);
      assert.equal(economics.planningContext.planningPaceNormalization.code, "ONE_YEAR_EARLY_NORMALIZED_TO_STANDARD");
      assert.ok(economics.economicsCandidateOutcomes.every(outcome => outcome.id !== "one-year-early"));
      assert.equal(economics.economicsAcceleratedResult, null);
    }
  }
});

test("major mapper accepts a custom graduation year without transfer identity", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "sophomore",
        customGraduationEnabled: true,
        customExpectedGraduationYear: "2030",
        planCreationDate: "2026-07-30",
        courses: []
      }
    })
  }));
  const data = await response.json();
  const economics = data.programs.find(result => result.program?.id === "economics-base");

  assert.equal(response.status, 200);
  assert.equal(economics.planningContext.isTransferStudent, false);
  assert.equal(economics.planningContext.customGraduationEnabled, true);
  assert.equal(economics.planningContext.expectedGraduationTerm, "Spring/May 2030");
  assert.equal(economics.planningContext.earlyComparisonRequested, false);
  assert.equal(economics.economicsAcceleratedResult, null);
  assert.equal(data.catalog.basis, "entry_catalog_year_inferred_from_standing_and_plan_date");
});

test("major mapper uses transfer entry catalog and keeps the selected graduation target", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        isTransferStudent: true,
        transferExpectedGraduationYear: "2030",
        transferEntryAcademicYear: "2025-2026",
        planCreationDate: "2027-01-10",
        courses: []
      }
    })
  }));
  const data = await response.json();
  const economics = data.programs.find(result => result.program?.id === "economics-base");

  assert.equal(response.status, 200);
  assert.equal(data.catalog.requestedCatalogYear, "2025-2026");
  assert.equal(data.catalog.basis, "transfer_hanover_entry_academic_year");
  assert.equal(economics.planningContext.isTransferStudent, true);
  assert.equal(economics.planningContext.expectedGraduationTerm, "Spring/May 2030");
  assert.ok(economics.economicsCandidateOutcomes.every(outcome => outcome.id !== "one-year-early"));
});

test("major mapper returns only the selected planning horizon", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "freshman",
        planCreationDate: "2026-09-01",
        courses: []
      }
    })
  }));
  const data = await response.json();
  const economics = data.programs.find(result => result.program?.id === "economics-base");

  assert.equal(response.status, 200);
  assert.ok(economics.economicsPlans.length >= 1 && economics.economicsPlans.length <= 2);
  assert.equal(economics.economicsCandidateOutcomes.length, 2);
  assert.ok(economics.economicsCandidateOutcomes.some(outcome => (
    outcome.id === "explore-first" && outcome.label === "Explore the Major"
  )));
  assert.ok(economics.economicsPlans.filter(plan => plan.id === "explore-first").every(plan => plan.label === "Explore the Major"));
  assert.ok(economics.economicsPlans.every(plan => plan.id !== "one-year-early"));
  assert.equal(economics.planningContext.expectedGraduationTerm, "Spring/May 2030");
});

test("major mapper generation continues to enforce authoritative reserved term capacity", async () => {
  const baseStudent = {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    courses: [
      "ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323"
    ].map(code => ({ code, status: "completed" }))
  };

  async function generate(reservedCourseUnits = {}) {
    const response = await POST(new Request("http://localhost/api/majors/map", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ student: { ...baseStudent, reservedCourseUnits } })
    }));
    const data = await response.json();
    const economics = data.programs.find(result => result.program?.id === "economics-base");
    assert.equal(response.status, 200, JSON.stringify(data));
    return economics;
  }

  const unreserved = await generate();
  assert.equal(unreserved.economicsPlans[0].terms.find(term => term.slotId === "fall-2026").courses.length, 2);

  const threeFallSpacesReserved = await generate({ "fall-2026": 3 });
  assert.ok(threeFallSpacesReserved.economicsPlans.length > 0);
  assert.ok(threeFallSpacesReserved.economicsPlans.every(plan => (
    plan.validation.valid
    && plan.terms.find(term => term.slotId === "fall-2026").courses.length <= 1
  )));

  const springSpaceReserved = await generate({ "spring-2027": 1 });
  assert.ok(springSpaceReserved.economicsPlans.length > 0);
  assert.ok(springSpaceReserved.economicsPlans.every(plan => (
    plan.validation.valid
    && plan.terms.find(term => term.slotId === "spring-2027").courses.length === 0
  )));
});

test("major mapper reports proven infeasibility only with exhaustive bounded-search evidence", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "junior",
        planningPace: "standard",
        planCreationDate: "2027-02-15",
        courses: [
          { code: "ECO 114", status: "completed" },
          { code: "ECO 257", status: "completed" }
        ],
        reservedCourseUnits: {
          "spring-2027": 1,
          "fall-2027": 1,
          "winter-2028": 1,
          "spring-2028": 1
        }
      }
    })
  }));
  const data = await response.json();
  const economics = data.programs.find(result => result.program?.id === "economics-base");
  const planResult = economics.economicsPlanResult;

  assert.equal(response.status, 200);
  assert.equal(economics.economicsPlans.length, 0);
  assert.equal(planResult.category, "INFEASIBLE_PROVEN");
  assert.equal(planResult.conclusion, "PROVEN_INFEASIBLE");
  assert.equal(planResult.reason, "COUNT_CAPACITY");
  assert.ok(planResult.evidence.strategyAttempts.length > 0);
  assert.ok(planResult.evidence.strategyAttempts.every(attempt => attempt.exhaustive));
  assert.ok(planResult.evidence.searchAttempts.length > 0);
  assert.ok(planResult.evidence.searchAttempts.every(attempt => attempt.failure === "COUNT_CAPACITY"));
  assert.deepEqual(planResult.evidence.planningGaps, economics.economicsPlanningGaps);
});

test("major mapper uses the inferred entry catalog and reports an unavailable newer catalog", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "sophomore",
        planCreationDate: "2027-01-10",
        courses: []
      }
    })
  }));
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.catalog.selectedCatalogYear, "2025-2026");
  assert.equal(data.catalog.comparisonCatalogYear, "2026-2027");
  assert.equal(data.catalog.comparisonStatus, "no_change");
  assert.deepEqual(data.catalog.evaluatedCatalogYears, ["2025-2026"]);
  assert.deepEqual(data.catalog.candidateCatalogYears, ["2025-2026"]);
});

test("missing 2026-2027 entry catalog uses 2025-2026 and returns Advisor Attention", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "freshman",
        planCreationDate: "2026-09-01",
        courses: []
      }
    })
  }));
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.catalog.requestedCatalogYear, "2026-2027");
  assert.equal(data.catalog.selectedCatalogYear, "2025-2026");
  assert.equal(data.catalog.catalogResolutionStatus, "owner_designated_flexible_requirements");
  assert.equal(data.catalog.advisorAttention[0].code, "FLEXIBLE_MAJOR_REQUIREMENTS_INCOMING_YEAR_UNKNOWN");
  assert.equal(data.catalog.catalogApplicability.latestAvailableCatalogYear, "2025-2026");
  assert.ok(data.catalog.catalogApplicability.candidateCatalogYears.includes("2026-2027"));
});

test("missing historical entry catalog uses an Economics-only provisional fallback", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "senior",
        planCreationDate: "2026-09-01",
        courses: []
      }
    })
  }));
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.catalog.requestedCatalogYear, "2023-2024");
  assert.equal(data.catalog.selectedCatalogYear, "2025-2026");
  assert.equal(data.catalog.catalogResolutionStatus, "owner_designated_flexible_requirements");
  assert.equal(data.catalog.scope, "economics_only_provisional");
  assert.equal(data.programs.length, 1);
  assert.equal(data.programs[0].program.id, "economics-base");
  const notice = data.catalog.advisorAttention.find(item => item.code === "FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE");
  assert.match(notice.message, /routine SAC petition/);
});

test("major mapper retains a standard senior plan above the Economics load preference with advisor warnings", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "senior",
        planCreationDate: "2026-07-30",
        courses: ["ECO 113", "ECO 114", "MAT 113", "ECO 214"].map(code => ({ code, status: "completed" }))
      }
    })
  }));
  const data = await response.json();
  const economics = data.programs[0];

  assert.equal(response.status, 200);
  assert.equal(economics.economicsPlans.length, 1);
  assert.ok(economics.economicsPlans.every(plan => plan.planningMode === "standard"));
  assert.ok(economics.economicsPlans.every(plan => plan.validation.valid));
  assert.ok(data.catalog.advisorAttention.some(item => /more than two Economics courses/.test(item.message)));
  assert.ok(data.catalog.advisorAttention.some(item => /MAT 217 requires advisor review \(ENROLLMENT_FULL\)/.test(item.message)));
  assert.equal(economics.economicsPlans[0].feasibilityStatus, "VERIFIED_FEASIBLE");
});

test("Finance uses BUSN 323 and leaves ECO 321 available as an elective", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "freshman",
        planCreationDate: "2025-09-01",
        courses: [
          { code: "ECO 113", status: "completed" },
          { code: "ECO 114", status: "completed" },
          { code: "ECO 321", status: "completed" },
          { code: "BUSN 323", status: "completed" }
        ]
      }
    })
  }));
  const data = await response.json();
  const economics = data.programs.find(result => result.program?.id === "economics-base");

  assert.equal(response.status, 200);
  assert.equal(economics.assignments.find(item => item.slotId === "finance").code, "BUSN 323");
  assert.ok(economics.assignments.some(item => item.slotId.startsWith("eco-elective") && item.code === "ECO 321"));
});

test("a completed or current 100-level elective produces Advisor Attention", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "freshman",
        planCreationDate: "2025-09-01",
        courses: [{ code: "ECO 161", status: "in_progress" }]
      }
    })
  }));
  const data = await response.json();
  const notice = data.catalog.advisorAttention.find(item => item.code === "ONE_HUNDRED_LEVEL_ELECTIVE_USED");

  assert.equal(response.status, 200);
  assert.match(notice.message, /ECO 161 is being used/);
  assert.match(notice.message, /other three Economics electives must be at the 200 level or above/);
});

test("major mapper rejects an in-progress course with missing prerequisites", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "sophomore",
        planCreationDate: "2027-02-01",
        courses: [{ code: "ECO 213", status: "in_progress" }]
      }
    })
  }));
  const data = await response.json();

  assert.equal(response.status, 422);
  assert.equal(data.code, "INVALID_STUDENT_PREREQUISITES");
  assert.ok(data.prerequisiteIssues.some(issue => issue.course === "ECO 213"));
  assert.equal(data.economicsPlanResult.category, "INPUT_BLOCKED");
  assert.equal(data.economicsPlanResult.reason, "INVALID_INPUT");
  assert.deepEqual(data.economicsPlanResult.questions, data.inputResolution.questions);
  assert.equal(data.economicsPlanResult.evidence.inputResolution.issueCode, "INVALID_STUDENT_PREREQUISITES");
});

test("major mapper reports instructor approval for current concurrent math", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "sophomore",
        planCreationDate: "2027-02-01",
        courses: [
          { code: "ECO 113", status: "completed" },
          { code: "MAT 113", status: "in_progress" },
          { code: "ECO 213", status: "in_progress" }
        ]
      }
    })
  }));
  const data = await response.json();
  const economics = data.programs.find(result => result.program?.id === "economics-base");
  const notice = data.catalog.advisorAttention.find(item => item.title === "Concurrent enrollment approval");

  assert.equal(response.status, 200);
  assert.match(notice.message, /MAT 113/);
  assert.match(notice.message, /ECO 213 instructor/);
  assert.ok(economics.economicsPlans.length > 0);
  assert.equal(economics.economicsCandidateOutcomes.length, 2);
  assert.ok(economics.economicsPlans.every(plan => plan.validation.valid));
});

test("edited plan validation rejects an incomplete submitted candidate", async () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-09-01",
    courses: []
  };
  const generatedResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student })
  }));
  const generated = await generatedResponse.json();
  const economics = generated.programs.find(result => result.program?.id === "economics-base");
  const originalPlan = economics.economicsPlans[0];
  const firstCourseTerm = originalPlan.terms.find(term => term.courses.length > 0);
  const editedPlan = {
    ...originalPlan,
    terms: originalPlan.terms.map(term => term === firstCourseTerm
      ? { ...term, courses: term.courses.slice(1) }
      : term)
  };

  const validationResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "validate-plan",
      student,
      plan: editedPlan,
      plans: economics.economicsPlans.map(plan => plan.id === editedPlan.id ? editedPlan : plan)
    })
  }));
  const validation = await validationResponse.json();

  assert.equal(validationResponse.status, 422);
  assert.equal(validation.code, "INVALID_PLAN_EDIT");
  assert.equal(validation.validation.valid, false);
  assert.ok(validation.validation.errors.some(error => /remains unscheduled/.test(error)));
  assert.equal(validation.plan, undefined);
});

test("edited plan validation keeps future sequencing nonblocking with open selected sections", async () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-08-02",
    courses: []
  };
  const generatedResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student })
  }));
  const generated = await generatedResponse.json();
  const economics = generated.programs.find(result => result.program?.id === "economics-base");
  const originalPlan = economics.economicsPlans[0];
  const editedPlan = structuredClone(originalPlan);
  const mathTermIndex = editedPlan.terms.findIndex(term => term.courses.some(course => (
    course.course === "MAT 113" || course.course === "MAT 121"
  )));
  assert.ok(mathTermIndex >= 0);
  const mathCourseIndex = editedPlan.terms[mathTermIndex].courses.findIndex(course => (
    course.course === "MAT 113" || course.course === "MAT 121"
  ));
  editedPlan.terms[mathTermIndex].courses[mathCourseIndex].planningSequence = 999;

  const validationResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "validate-plan",
      student,
      plan: editedPlan,
      plans: economics.economicsPlans.map(plan => plan.id === editedPlan.id ? editedPlan : plan)
    })
  }));
  const validation = await validationResponse.json();

  assert.equal(validationResponse.status, 200);
  assert.equal(validation.plan.validation.valid, true);
  assert.equal(validation.plan.validation.evidenceStatus, "VERIFIED");
  assert.ok(validation.plan.validation.policyDecision.decisions.some(decision => (
    decision.status === "ALLOW" && decision.reasonCode === "FUTURE_SCHEDULE_PLANNING_PROJECTION"
  )));
  assert.ok(validation.plan.validation.policyDecision.decisions.some(decision => (
    decision.status === "ALLOW" && decision.reasonCode === "ENROLLMENT_OPEN" && decision.subject?.course === "ECO 113"
  )));
});

test("edited plan validation preserves the selected plan's yearly design", async () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-08-02",
    courses: []
  };
  const generatedResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student })
  }));
  const generated = await generatedResponse.json();
  const economics = generated.programs.find(result => result.program?.id === "economics-base");
  const originalPlan = economics.economicsPlans.find(plan => plan.id === "balanced");
  const editedPlan = structuredClone(originalPlan);
  const sourceTermIndex = editedPlan.terms.findLastIndex(term => (
    term.courses.some(course => course.course === "ECO elective")
  ));
  const sourceYearIndex = editedPlan.terms[sourceTermIndex].yearIndex;
  const targetTermIndex = editedPlan.terms.findIndex(term => (
    term.yearIndex > 0
    && term.yearIndex !== sourceYearIndex
    && ["Fall", "Winter"].includes(term.termKey)
  ));

  assert.ok(sourceTermIndex >= 0);
  assert.ok(targetTermIndex >= 0);
  const electiveIndex = editedPlan.terms[sourceTermIndex].courses.findIndex(course => course.course === "ECO elective");
  const [elective] = editedPlan.terms[sourceTermIndex].courses.splice(electiveIndex, 1);
  editedPlan.terms[targetTermIndex].courses.push(elective);

  const validationResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "validate-plan",
      student,
      plan: editedPlan,
      plans: economics.economicsPlans.map(plan => plan.id === editedPlan.id ? editedPlan : plan)
    })
  }));
  const validation = await validationResponse.json();

  assert.equal(validationResponse.status, 200);
  assert.equal(validation.plan.validation.valid, true);
  assert.equal(validation.plan.validation.distribution.valid, false);
  assert.match(validation.plan.validation.warnings.join(" | "), /Balanced no longer follows its Balanced yearly distribution/);
});

test("edited plan validation rejects canonical schedule tampering and post-graduation terms", async () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-08-02",
    courses: []
  };
  const generatedResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student })
  }));
  const generated = await generatedResponse.json();
  const economics = generated.programs.find(result => result.program?.id === "economics-base");
  const originalPlan = economics.economicsPlans[0];

  const tamperedSchedule = structuredClone(originalPlan);
  const verifiedCourse = tamperedSchedule.terms
    .flatMap(term => term.courses)
    .find(course => course.source === "verified-offering" && Number.isFinite(course.availability?.seatsOpen));
  assert.ok(verifiedCourse);
  verifiedCourse.availability.seatsOpen += 7;
  const scheduleResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "validate-plan", student, plan: tamperedSchedule, plans: [tamperedSchedule] })
  }));
  const scheduleResult = await scheduleResponse.json();
  assert.equal(scheduleResponse.status, 422);
  assert.equal(scheduleResult.validation.valid, false);
  assert.ok(scheduleResult.validation.errors.some(error => /canonical verified schedule/.test(error)));

  const afterGraduation = structuredClone(originalPlan);
  const graduationYear = economics.planningContext.expectedGraduationYear;
  const finalTerm = afterGraduation.terms.at(-1);
  finalTerm.academicYear = `${graduationYear}/${graduationYear + 1}`;
  finalTerm.yearIndex = economics.planningContext.remainingYears;
  finalTerm.term = `Fall ${graduationYear}`;
  finalTerm.displayTerm = "Fall";
  finalTerm.termKey = "Fall";
  finalTerm.scheduleTerm = "Fall";
  finalTerm.slotId = `fall-${graduationYear}`;
  const horizonResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "validate-plan", student, plan: afterGraduation, plans: [afterGraduation] })
  }));
  const horizonResult = await horizonResponse.json();
  assert.equal(horizonResponse.status, 422);
  assert.ok(horizonResult.validation.errors.some(error => /graduation planning horizon/.test(error)));

  const forgedStanding = structuredClone(originalPlan);
  forgedStanding.terms[0].absoluteStandingIndex = 3;
  forgedStanding.terms[0].seniorStandingBasis = "student_reported_registrar_or_advisor_confirmation";
  const standingResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "validate-plan", student, plan: forgedStanding, plans: [forgedStanding] })
  }));
  const standingResult = await standingResponse.json();
  assert.equal(standingResponse.status, 422);
  assert.ok(standingResult.validation.errors.some(error => /authoritative projected standing/.test(error)));
});
