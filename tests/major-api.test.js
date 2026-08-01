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

test("major mapper returns standing-limited candidate outcomes and distinct plans", async () => {
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
  assert.equal(economics.economicsPlans.length, 2);
  assert.equal(economics.economicsCandidateOutcomes.length, 4);
  assert.ok(economics.economicsPlans.some(plan => plan.id === "plan-c2"));
  assert.equal(economics.planningContext.expectedGraduationTerm, "Spring/May 2030");
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
  assert.equal(economics.economicsPlans.length, 0);
  assert.equal(economics.economicsCandidateOutcomes.length, 4);
  assert.ok(economics.economicsCandidateOutcomes.every(outcome => outcome.status === "NOT_FEASIBLE"));
});

test("edited plan validation recalculates only the submitted candidate plan", async () => {
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

  assert.equal(validationResponse.status, 200);
  assert.equal(validation.plan.id, originalPlan.id);
  assert.equal(validation.plan.validation.valid, false);
  assert.ok(validation.plan.validation.errors.some(error => /remains unscheduled/.test(error)));
  assert.equal(validation.planSetValidation.valid, false);
});
