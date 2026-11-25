import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../../lib/assignment/solve.js";
import { buildEconomicsTermPlans } from "../../lib/planning/economics.js";
import { buildEconomicsReport } from "../../lib/reports/economics.js";
import { renderEconomicsHtml } from "../../lib/reports/economics-html.js";
import { summerLastResortNote } from "../../lib/planning/summer-note.js";
import { openFixtureResult, fixturePlan, plannerResultFixture } from "./cp7-helpers.js";

const schedule = JSON.parse(await readFile(new URL("../../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));
const requirements = JSON.parse(await readFile(new URL("../../data/normalized/economics/requirements.json", import.meta.url), "utf8"));
const prerequisites = JSON.parse(await readFile(new URL("../../data/normalized/economics/prerequisites.json", import.meta.url), "utf8"));
const template = await readFile(new URL("../../templates/econplannertemplate.html", import.meta.url), "utf8");

function summerPlan(plan) {
  return {
    ...plan,
    terms: [...plan.terms, {
      slotId: "summer-2027",
      academicYear: "2026-2027",
      termKey: "Summer",
      term: "Summer 2027",
      displayTerm: "Summer 2027",
      isSummer: true,
      courses: [{ course: "ECO 113", title: "Principles of Microeconomics", section: "S", source: "summer-last-resort" }]
    }]
  };
}

test("a Summer last-resort course shows its approved note in comparison and PDF HTML", async ({ page }) => {
  const plan = fixturePlan();
  plan.terms.push({
    slotId: "summer-2027",
    academicYear: "2026-2027",
    termKey: "Summer",
    term: "Summer 2027",
    displayTerm: "Summer 2027",
    isSummer: true,
    courses: [{ course: "ECO 113", title: "Principles of Microeconomics", section: "S", source: "summer-last-resort" }]
  });
  await openFixtureResult(page, plannerResultFixture({ plans: [plan] }));
  const comparisonCourse = page.locator('[data-term-id="summer-2027"] .comparison-editable-course');
  await expect(comparisonCourse).toContainText("ECO 113-S");
  await expect(comparisonCourse).toContainText(summerLastResortNote());

  const student = { academicStanding: "freshman", planCreationDate: "2026-07-30", courses: [] };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const planBundle = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
  const summerPlanResult = summerPlan(structuredClone(planBundle.plans[0]));
  const report = buildEconomicsReport({ student, mapping, schedule, economicsPlan: summerPlanResult, planBundle, preparedDate: "2026-07-30" });
  const html = renderEconomicsHtml(report, template);
  expect(html.match(new RegExp(summerLastResortNote(), "g")) || []).toHaveLength(1);
  expect(html).toContain(`<span class="meta summer-term-note">${summerLastResortNote()}</span>`);
});
