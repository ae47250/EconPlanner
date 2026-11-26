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
  await expect(notes).toContainText("Before taking ECO 214 in Winter 2027 and ECO 222 in Spring/May 2027, finish ECO 114.");
  await expect(notes).toContainText("This plan has 3 Economics courses in Winter 2028. The department recommends no more than 2 per term, but the term is still within the normal course load.");
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
