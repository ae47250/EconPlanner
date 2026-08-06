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
  assert.equal(data.catalog.catalogResolutionStatus, "exact");
  assert.equal(data.catalog.comparisonStatus, "not_applicable");
  assert.equal(data.catalog.catalogApplicability.status, "AMBIGUOUS");
  assert.equal(data.catalog.governingMajorCatalogYear, null);
  assert.ok(data.catalog.advisorAttention.some(item => item.code === "CATALOG_APPLICABILITY_REVIEW"));
  assert.ok(economics.economicsPlans.every(plan => plan.readinessStatus === "ADVISOR_ACTION_REQUIRED"));
  assert.ok(economics.economicsPlans.every(plan => plan.validation.approved === false));
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

test("an available supplied major declaration year becomes the exact governing catalog", async () => {
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
  assert.equal(data.catalog.catalogApplicability.status, "EXACT");
  assert.equal(data.catalog.governingMajorCatalogYear, "2025-2026");
  assert.equal(data.catalog.selectionAuthority, "GOVERNING");
  assert.ok(!data.catalog.advisorAttention.some(item => item.code === "CATALOG_APPLICABILITY_REVIEW"));
});

test("major mapper rejects an unconfirmed or stale one-year-early pace", async () => {
  for (const projectedSeniorStandingConfirmation of [
    undefined,
    {
      status: "STUDENT_REPORTED_REGISTRAR_OR_ADVISOR_CONFIRMATION",
      academicYear: "2027/2028"
    }
  ]) {
    const response = await POST(new Request("http://localhost/api/majors/map", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        student: {
          academicStanding: "freshman",
          planningPace: "one_year_early",
          planCreationDate: "2026-07-26",
          projectedSeniorStandingConfirmation,
          courses: []
        }
      })
    }));
    const data = await response.json();
    assert.equal(response.status, 422);
    assert.equal(data.code, "INVALID_PLANNING_PACE");
    assert.match(data.error, /Registrar or your advisor/);
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
  assert.equal(compressedTransferResponse.status, 422);
  assert.equal(compressedTransfer.code, "INVALID_PLANNING_PACE");
  assert.match(compressedTransfer.error, /Registrar or your advisor/);

  const confirmedResponse = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "freshman",
        planningPace: "one_year_early",
        planCreationDate: "2026-07-26",
        projectedSeniorStandingConfirmation: {
          status: "STUDENT_REPORTED_REGISTRAR_OR_ADVISOR_CONFIRMATION",
          academicYear: "2028/2029"
        },
        courses: []
      }
    })
  }));
  const confirmed = await confirmedResponse.json();
  const economics = confirmed.programs.find(result => result.program?.id === "economics-base");
  assert.equal(confirmedResponse.status, 200);
  assert.equal(economics.planningContext.expectedGraduationTerm, "Spring/May 2029");
  assert.ok(economics.economicsCandidateOutcomes.every(outcome => outcome.id === "plan-c2"));
  assert.ok(economics.economicsPlans.every(plan => plan.planningContext.expectedGraduationTerm === "Spring/May 2029"));
  for (const plan of economics.economicsPlans) {
    const capstoneTerm = plan.terms.find(term => term.courses.some(course => course.course === "ECO 461"));
    assert.equal(capstoneTerm?.term, "2028/2029 term to be confirmed");
    assert.equal(capstoneTerm?.termKey, "TBC");
    assert.equal(capstoneTerm?.courses.find(course => course.course === "ECO 461")?.projectedTerm, "Winter");
    assert.equal(capstoneTerm?.seniorStandingBasis, "student_reported_registrar_or_advisor_confirmation");
  }
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
  assert.ok(economics.economicsCandidateOutcomes.every(outcome => outcome.id !== "plan-c2"));
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
  assert.ok(economics.economicsPlans.length >= 1 && economics.economicsPlans.length <= 3);
  assert.equal(economics.economicsCandidateOutcomes.length, 3);
  assert.ok(economics.economicsPlans.every(plan => plan.id !== "plan-c2"));
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
  assert.equal(data.catalog.comparisonStatus, "unavailable");
  assert.deepEqual(data.catalog.evaluatedCatalogYears, ["2025-2026"]);
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
  assert.equal(data.catalog.catalogResolutionStatus, "previous_year_fallback");
  assert.equal(data.catalog.advisorAttention[0].code, "CATALOG_PREVIOUS_YEAR_FALLBACK");
  assert.match(data.catalog.advisorAttention[0].message, /2026\/2027 Economics catalog was unavailable/);
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
  assert.equal(data.catalog.catalogResolutionStatus, "economics_provisional_fallback");
  assert.equal(data.catalog.scope, "economics_only_provisional");
  assert.equal(data.programs.length, 1);
  assert.equal(data.programs[0].program.id, "economics-base");
  const notice = data.catalog.advisorAttention.find(item => item.code === "ECONOMICS_PROVISIONAL_CATALOG_FALLBACK");
  assert.match(notice.message, /does not apply to any other major/);
});

test("major mapper returns graduation-priority senior plans and advisor warnings", async () => {
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
  assert.ok(economics.economicsPlans.every(plan => plan.planningMode === "graduation_priority"));
  assert.ok(economics.economicsPlans.every(plan => plan.validation.valid));
  assert.ok(data.catalog.advisorAttention.some(item => /more than two Economics courses/.test(item.message)));
  assert.ok(data.catalog.advisorAttention.some(item => /Schedule confirmation required/.test(item.message)));
  assert.equal(economics.economicsPlans[0].feasibilityStatus, "PRELIMINARY_ONLY");
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
  assert.equal(economics.economicsCandidateOutcomes.length, 3);
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

test("edited plan validation keeps future sequencing preliminary without hiding full-section review", async () => {
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
  assert.equal(validation.plan.validation.evidenceStatus, "REVIEW_REQUIRED");
  assert.ok(validation.plan.validation.policyDecision.decisions.some(decision => (
    decision.status === "PRELIMINARY" && decision.reasonCode === "UNPUBLISHED_OFFERING_TBC"
  )));
  assert.ok(validation.plan.validation.policyDecision.decisions.some(decision => (
    decision.status === "REVIEW_REQUIRED" && decision.reasonCode === "ENROLLMENT_FULL"
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
  const originalPlan = economics.economicsPlans.find(plan => plan.label === "Plan A");
  const editedPlan = structuredClone(originalPlan);
  const sourceTermIndex = editedPlan.terms.findLastIndex(term => (
    term.courses.some(course => course.course === "ECO elective")
  ));
  const sourceYearIndex = editedPlan.terms[sourceTermIndex].yearIndex;
  const targetTermIndex = editedPlan.terms.findIndex(term => (
    term.yearIndex > 0
    && term.yearIndex !== sourceYearIndex
    && term.termKey === "TBC"
  ));

  assert.ok(sourceTermIndex >= 0);
  assert.ok(targetTermIndex >= 0);
  const electiveIndex = editedPlan.terms[sourceTermIndex].courses.findIndex(course => course.course === "ECO elective");
  const [elective] = editedPlan.terms[sourceTermIndex].courses.splice(electiveIndex, 1);
  elective.projectedTerm = "Fall";
  elective.planningSequence = editedPlan.terms[targetTermIndex].courses
    .filter(course => course.projectedTerm === "Fall")
    .reduce((maximum, course) => Math.max(maximum, Number(course.planningSequence || 0)), -1) + 1;
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
  assert.match(validation.plan.validation.warnings.join(" | "), /Plan A no longer follows its Balanced yearly distribution/);
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
