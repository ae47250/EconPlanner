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

test("major mapper asks for summer standing clarification instead of guessing", async () => {
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

  assert.equal(response.status, 409);
  assert.equal(data.requiresSummerClarification, true);
  assert.equal(
    data.error,
    "Will you be a freshman in Fall 2026, or were you a freshman during last May term?"
  );
});

test("major mapper returns three dated Economics plans", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      student: {
        academicStanding: "freshman",
        planCreationDate: "2025-09-01",
        courses: []
      }
    })
  }));
  const data = await response.json();
  const economics = data.programs.find(result => result.program?.id === "economics-base");

  assert.equal(response.status, 200);
  assert.equal(economics.economicsPlans.length, 3);
  assert.equal(economics.planningContext.expectedGraduationTerm, "Spring/May 2029");
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

test("missing entry catalog blocks when no earlier approved snapshot exists", async () => {
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

  assert.equal(response.status, 422);
  assert.equal(data.requestedCatalogYear, "2023-2024");
  assert.equal(data.selectedCatalogYear, null);
  assert.equal(data.catalogResolutionStatus, "unavailable");
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
