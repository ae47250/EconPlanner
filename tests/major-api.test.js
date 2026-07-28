import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/majors/map/route.js";

test("major mapper returns every captured program and Economics schedule", async () => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ student: { entryCatalogYear: "2025-2026", courses: [] } })
  }));
  const data = await response.json();
  const economics = data.programs.find(result => result.program?.id === "economics-base");

  assert.equal(response.status, 200);
  assert.equal(data.summary.programCount, 37);
  assert.equal(data.summary.mappedProgramCount, 1);
  assert.deepEqual(data.catalog.evaluatedCatalogYears, ["2025-2026"]);
  assert.equal(data.catalog.basis, "entry_catalog_year_with_declaration_year_uncertain");
  assert.ok(data.catalog.uncertainty);
  assert.equal(economics.annualSchedule.academicYear, "2026-2027");
  assert.ok(economics.annualSchedule.terms.May.some(course => course.section === "S"));
});
