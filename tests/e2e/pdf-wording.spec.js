import { expect, test } from "@playwright/test";
import { chooseStanding, continueToCourses, generatePlans, resetPlanner, setCourseStatus, visitPlan } from "./cp7-helpers.js";

test("intake shows the older-catalog explanation only for junior and senior years", async ({ page }) => {
  for (const [standing, expected] of [
    ["freshman", []], ["sophomore", []], ["junior", ["BUSN 323"]],
    ["senior", ["BUSN 323", "PSY 217", "comprehensive evaluation"]]
  ]) {
    await resetPlanner(page);
    await chooseStanding(page, standing);
    await page.locator("details.more-details > summary").first().click();
    await page.getByLabel("Plan creation date", { exact: true }).fill("2026-11-21");
    const note = page.locator(".catalog-planning-note");
    if (!expected.length) await expect(note).toHaveCount(0);
    else {
      await expect(note).toContainText("This plan uses the current Economics major requirements.");
      for (const term of expected) await expect(note).toContainText(term);
    }
  }
});

test("freshman completed-course and catalog-year advice appears under Check with your advisor", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-11-21");
  await continueToCourses(page);
  await setCourseStatus(page, "ECO 214", "Completed");
  await setCourseStatus(page, "ECO 114", "Taking now");
  await generatePlans(page);
  const card = await visitPlan(page, "balanced");
  await card.locator("summary").filter({ hasText: "Things to keep in mind" }).click();
  const notes = card.locator("[data-plan-conditions]");
  const historyBullets = notes.locator("li").filter({ hasText: "ECO 214 is marked completed" });
  await expect(historyBullets).toHaveCount(1);
  await expect(historyBullets).toHaveText("ECO 214 is marked completed, but MAT 113 or MAT 121 is not marked, and ECO 114 is marked Taking now. Fix these, or your advisor will check.");
  await expect(notes).not.toContainText("Your answers do not show ECO 114");
  await expect(notes.locator("h3").filter({ hasText: "Check with your advisor" })).toBeVisible();
  await expect(notes).not.toContainText("Based on your class year, your catalog year is likely");
  await expect(notes).not.toContainText("Ask your advisor whether a catalog petition is needed.");
});

test("freshman ECO 213 Taking now with an unmarked prerequisite stays in the plan and the PDF", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-11-21");
  await continueToCourses(page);
  await setCourseStatus(page, "ECO 113", "Completed");
  await setCourseStatus(page, "ECO 213", "Taking now");
  await expect(page.getByRole("button", { name: "Generate my plans", exact: true })).toBeEnabled();
  await expect(page.locator("#course-eco-213")).toContainText("Taking now");
  const response = await generatePlans(page);
  const mapped = (await response.json()).programs.find(item => item.program?.id === "economics-base");
  const plan = mapped.economicsPlans.find(item => item.id === "balanced");
  const reason = "ECO 213 needs MAT 113 or MAT 121 first. Mark it Completed or Taking now, or your advisor will check.";
  await expect(page.locator(".result-status-value")).toHaveText("Needs advisor attention");
  await expect(page.locator(".result-status-reason").last()).toContainText(reason);
  const card = await visitPlan(page, "balanced");
  await card.locator("summary").filter({ hasText: "Things to keep in mind" }).click();
  await expect(card.locator("[data-plan-conditions]")).toContainText(reason);
  const report = await page.request.post("/api/reports/economics", { data: {
    student: response.request().postDataJSON().student,
    selectedPlan: plan,
    plans: mapped.economicsPlans,
    format: "html"
  } });
  expect(report.status()).toBe(200);
  expect(await report.text()).toContain(`<li data-plan-warning>${reason}</li>`);
});

test("freshman and sophomore plans have no catalog note with ECO 113 Taking now", async ({ page }) => {
  for (const standing of ["freshman", "sophomore"]) {
    await resetPlanner(page);
    await chooseStanding(page, standing);
    await page.locator("details.more-details > summary").first().click();
    await page.getByLabel("Plan creation date", { exact: true }).fill("2026-11-21");
    await continueToCourses(page);
    await setCourseStatus(page, "ECO 113", "Taking now");
    await generatePlans(page);
    const card = await visitPlan(page, "balanced");
    await card.locator("summary").filter({ hasText: "Things to keep in mind" }).click();
    const notes = card.locator("[data-plan-conditions]");
    await expect(notes).not.toContainText("Based on your class year, your catalog year is likely");
    await expect(notes).not.toContainText("This plan uses the current Economics major requirements.");
    const current = card.locator('[data-term-id="fall-2026"]');
    await expect(current).toContainText("ECO 113");
    await expect(current).toContainText("Taking now");
  }
});

test("early sophomore abroad plan shows consistent prerequisite and approval sentences", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "sophomore");
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-11-21");
  await page.getByRole("button", { name: "I’d like to graduate one year early", exact: true }).click();
  await page.locator("details.more-details > summary").filter({ hasText: "Adjust your schedule" }).click();
  await page.getByRole("button", { name: "I plan to study abroad during my junior year" }).click();
  await page.getByLabel("Study-abroad term").selectOption("fall-2027");
  await continueToCourses(page);
  await setCourseStatus(page, "ECO 113", "Completed");
  await setCourseStatus(page, "ECO 114", "Taking now");
  await generatePlans(page);
  const card = await visitPlan(page, "one-year-early");
  await card.locator("summary").filter({ hasText: "Things to keep in mind" }).click();
  const notes = card.locator("[data-plan-conditions]");
  await expect(notes).toContainText("Taking ECO 213 and ECO 461 together in Winter 2028 needs approval from the ECO 461 instructor before you register.");
  await expect(notes).toContainText("Before taking ECO 214 in Winter 2027 and ECO 222 in May 2027, finish ECO 114.");
  await expect(notes).toContainText("Winter 2028 has 3 Economics courses. The department recommends no more than 2.");
  await expect(notes).not.toContainText("Complete ECO 114 before taking");
  await expect(notes).not.toContainText("This plan uses the current Economics major requirements.");
  await expect(notes).not.toContainText("Ask your advisor whether a catalog petition is needed.");
});

test("junior plan notes name the catalog difference instead of the generic petition text", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "junior");
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-11-21");
  await continueToCourses(page);
  await setCourseStatus(page, "BUSN 323", "Completed");
  await generatePlans(page);
  const card = await visitPlan(page, "balanced");
  await card.locator("summary").filter({ hasText: "Things to keep in mind" }).click();
  const notes = card.locator("[data-plan-conditions]");
  await expect(notes).toContainText("This plan uses the current Economics major requirements.");
  await expect(notes).toContainText("Your plan counts BUSN 323. Your 2024–25 catalog does not accept it.");
  await expect(notes).toContainText("Ask your advisor to help you file a routine petition with the Student Academic Assistance Committee.");
  await expect(notes).not.toContainText("Forms are at");
  await expect(notes).not.toContainText("Please help the student submit the routine SAC petition");
});

// Final sweep, 2026-11-26: on screen, the plan table and the checklist tag the same courses "Approval needed".
// (The PDF grid is checked against the shared rule in tests/screen-pdf-consistency.test.js.)
for (const [label, setup] of [
  ["junior early with planned approval pairs", async page => {
    await chooseStanding(page, "junior");
    await page.getByRole("button", { name: "I’d like to graduate next year", exact: true }).click();
    await continueToCourses(page);
    await setCourseStatus(page, "ECO 113", "Completed");
    await setCourseStatus(page, "MAT 217", "Completed");
  }],
  ["ECO 213 and MAT 121 taken now", async page => {
    await chooseStanding(page, "sophomore");
    await continueToCourses(page);
    for (const code of ["ECO 113", "ECO 114"]) await setCourseStatus(page, code, "Completed");
    await setCourseStatus(page, "ECO 213", "Taking now");
    await setCourseStatus(page, "MAT 121", "Taking now", "Status for prerequisite");
  }]
]) test(`screen plan table and checklist tag the same courses 'Approval needed': ${label}`, async ({ page }) => {
  await resetPlanner(page);
  await setup(page);
  const response = await generatePlans(page);
  const plans = (await response.json()).programs.find(item => item.program.id === "economics-base").economicsPlans;
  let compared = 0;
  for (const plan of plans) {
    const card = await visitPlan(page, plan.id);
    const table = await card.locator(".compact-schedule .comparison-editable-course").evaluateAll(nodes => nodes
      .filter(node => [...node.querySelectorAll(".plan-course-approval")].some(item => item.textContent.trim() === "Approval needed"))
      .map(node => (node.querySelector("button[aria-label^='Change ']")?.getAttribute("aria-label").replace(/^Change /, "") || node.querySelector(".comparison-fixed-course > strong")?.textContent || "").trim().replace(/-[A-Z]$/, "")));
    const checklist = await card.locator("[data-requirement-checklist-id]").evaluateAll(rows => rows
      .filter(row => [...row.querySelectorAll(".checklist-marker")].some(item => item.textContent.trim() === "Approval needed"))
      .map(row => row.querySelector("td strong")?.textContent.trim()));
    expect([...new Set(table)].sort(), plan.id).toEqual([...new Set(checklist)].sort());
    compared += checklist.length;
  }
  expect(compared).toBeGreaterThan(0);
});

// Owner report 2026-11-26: "Graduation target" was indented, and the orange checklist note was squeezed
// into the narrow status column.
test("PDF header lines start at the same edge and a checklist sentence gets its own line", async ({ page }) => {
  const c = (code, status = "completed") => ({ code, status });
  const student = { displayName: "Test Student", academicStanding: "sophomore", planCreationDate: "2026-11-26", courses: [c("ECO 113"), c("MAT 113"), c("ECO 214", "in_progress")] };
  const map = await (await page.request.post("/api/majors/map", { data: { student } })).json();
  const plans = map.programs.find(item => item.economicsPlans).economicsPlans;
  const html = await (await page.request.post("/api/reports/economics", { data: { student, preparedDate: "2026-11-26", selectedPlan: plans[0], plans, format: "html" } })).text();
  await page.setViewportSize({ width: 816, height: 1056 });
  await page.setContent(html);
  const layout = await page.evaluate(() => {
    const status = [...document.querySelectorAll(".plan-details h2")].find(node => /^Status:/.test(node.textContent.trim()));
    const target = document.querySelector(".plan-details li");
    const note = document.querySelector('.checklist-note-row[data-checklist-note-for="eco-214"] .checklist-marker');
    const statusCell = document.querySelector('[data-requirement-checklist-id="eco-214"] td:last-child');
    return { statusLeft: status.getBoundingClientRect().left, targetLeft: target.getBoundingClientRect().left,
      noteText: note?.textContent || "", noteWidth: note?.getBoundingClientRect().width || 0, statusCellWidth: statusCell.getBoundingClientRect().width };
  });
  expect(Math.abs(layout.targetLeft - layout.statusLeft)).toBeLessThan(1);
  expect(layout.noteText).toContain("ECO 114 isn’t marked completed, and ECO 214 needs it first.");
  expect(layout.noteWidth).toBeGreaterThan(layout.statusCellWidth * 1.5);
});
