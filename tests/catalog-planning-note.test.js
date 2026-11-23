import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planningRequirementsNote } from "../lib/catalog/planning-requirements-note.js";
import { resolvePlanningContext } from "../lib/planning/horizon.js";
import { POST } from "../app/api/majors/map/route.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";

const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
const date = "2026-11-21";

test("catalog note follows the derived or entered year for regular, transfer, and custom timelines", () => {
  const expected = [
    ["freshman", null],
    ["sophomore", null],
    ["junior", ["BUSN 323"]],
    ["senior", ["BUSN 323", "PSY 217", "comprehensive evaluation"]]
  ];
  for (const [standing, terms] of expected) {
    const context = resolvePlanningContext({ academicStanding: standing, planCreationDate: date });
    const note = planningRequirementsNote(context);
    if (!terms) assert.equal(note, null);
    else {
      assert.equal(note.heading, "This plan uses the current Economics major requirements.");
      for (const term of terms) assert.ok(`${note.heading} ${note.details.join(" ")}`.includes(term));
    }
  }
  const junior = resolvePlanningContext({ academicStanding: "junior", planCreationDate: date });
  assert.equal(planningRequirementsNote({ ...junior, majorDeclarationCatalogYear: "2025-2026" }), null);
  assert.match(planningRequirementsNote({ ...junior, majorDeclarationCatalogYear: "2023-2024" }).details[0], /BUSN 323 or PSY 217/);
  assert.match(planningRequirementsNote({ ...junior, majorDeclarationCatalogYear: "I_DO_NOT_KNOW" }).details[0], /BUSN 323/);
  const custom = resolvePlanningContext({ academicStanding: "junior", customGraduationEnabled: true, customExpectedGraduationYear: "2029", planCreationDate: date });
  assert.match(planningRequirementsNote(custom).details[0], /BUSN 323/);
  const transfer = resolvePlanningContext({ isTransferStudent: true, transferEntryAcademicYear: "2024-2025", transferExpectedGraduationYear: "2028", planCreationDate: date });
  assert.match(planningRequirementsNote(transfer).details[0], /BUSN 323/);
});

test("API plan and PDF explain older catalogs once and omit the box for recent catalogs", async () => {
  for (const [standing, expected] of [
    ["freshman", []], ["sophomore", []], ["junior", ["BUSN 323"]], ["senior", ["BUSN 323", "PSY 217", "comprehensive evaluation"]]
  ]) {
    const student = { academicStanding: standing, planCreationDate: standing === "senior" ? "2026-07-30" : date,
      courses: standing === "senior" ? ["ECO 113", "ECO 114", "MAT 113", "ECO 214", "BUSN 323", "PSY 217"].map(code => ({ code, status: "completed" }))
        : standing === "junior" ? [{ code: "BUSN 323", status: "completed" }]
          : standing === "freshman" ? [{ code: "ECO 113", status: "in_progress" }] : [] };
    const response = await POST(new Request("http://localhost/api/majors/map", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student })
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    const plans = body.programs.find(item => item.program?.id === "economics-base").economicsPlans;
    const plan = plans[0];
    const note = planningRequirementsNote(plan.planningContext, plan);
    const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, plans);
    const html = renderEconomicsHtml(report, template);
    if (!expected.length) {
      assert.equal(note, null);
      assert.doesNotMatch(html, /This plan uses the current Economics major requirements/);
      assert.doesNotMatch(html, /Based on your class year, your catalog year is likely/);
      assert.doesNotMatch(html, /Please help the student submit the routine SAC petition/);
    } else {
      assert.ok(note);
      assert.equal(html.split(note.heading).length - 1, 1);
      const studentSection = html.match(/<section class="year-block plan-conditions"[\s\S]*?<\/section>/)?.[0] || "";
      assert.ok(studentSection.includes("<h3>Check with your advisor</h3>"));
      for (const term of expected) assert.ok(studentSection.includes(term));
      assert.doesNotMatch(html, /Please help the student submit the routine SAC petition/);
      assert.match(studentSection, /Student Academic Assistance Committee\. Forms are at the Registrar&#39;s Office\./);
      if (standing === "senior") assert.match(studentSection, /comprehensive evaluation in Economics\. Ask your advisor whether you still need to take it\./);
    }
  }
});

test("an entered declaration year overrides the derived year in the plan and PDF", async () => {
  const student = { academicStanding: "sophomore", majorDeclarationCatalogYear: "2023-2024", planCreationDate: date, courses: [] };
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student })
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  const plans = body.programs.find(item => item.program?.id === "economics-base").economicsPlans;
  const note = planningRequirementsNote(plans[0].planningContext, plans[0]);
  assert.match(note.details.join(" "), /comprehensive evaluation in Economics/);
  const report = await buildEconomicsReportFromStudent(student, date, plans[0], plans);
  const html = renderEconomicsHtml(report, template);
  assert.ok(html.includes(note.details[0].replaceAll("'", "&#39;")));
  assert.equal(html.split(note.heading).length - 1, 1);
});

test("older-catalog wording names only the courses the plan actually counts", () => {
  const context = resolvePlanningContext({ academicStanding: "senior", planCreationDate: date });
  const onlyPsychology = { validation: { requirementAllocation: { assignments: [{ slotId: "statistics", code: "PSY 217" }] } } };
  const note = planningRequirementsNote(context, onlyPsychology);
  assert.match(note.details[0], /^Your plan counts PSY 217\. Your 2023–24 catalog does not accept it\./);
  assert.doesNotMatch(note.details[0], /BUSN 323|\bSAC\b|;/);
  assert.match(note.details[0], /Ask your advisor to help you file a petition with the Student Academic Assistance Committee\. Forms are at the Registrar's Office\./);
  assert.equal(note.details[1], "Your 2023–24 catalog also required a comprehensive evaluation in Economics. Ask your advisor whether you still need to take it.");
});
