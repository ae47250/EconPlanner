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
