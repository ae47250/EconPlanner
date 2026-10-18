import { visitPlan } from "./cp7-helpers.js";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./nightly-observability.js";
import {
  chooseStanding,
  continueToCourses,
  courseStatusGroup,
  openFixtureResult,
  plannerResultFixture,
  resetPlanner,
  setCourseStatus
} from "./cp7-helpers.js";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoAxeViolations(page) {
  await page.locator('main').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(result.violations).toEqual([]);
}

test("standing and One Year Early controls expose one keyboard-operable pressed state", async ({ page }) => {
  await resetPlanner(page);
  const freshman = await chooseStanding(page, "freshman");
  const standingGroup = page.getByRole("group", { name: "Class standing" });
  await expect(standingGroup.locator("[aria-pressed='true']")).toHaveCount(1);
  await expect(freshman.locator(".selection-check")).toHaveText("✓");

  const early = page.getByRole("button", { name: "I’d like to graduate one year early", exact: true });
  await early.focus();
  await expect(early).toBeFocused();
  await page.keyboard.press("Space");
  await expect(early).toHaveAttribute("aria-pressed", "true");
  await expect(early.locator(".selection-check")).toHaveText("✓");
  await page.keyboard.press("Space");
  await expect(early).toHaveAttribute("aria-pressed", "false");

  await expectNoAxeViolations(page);
});

test("course choices retain visible focus, non-color selection cues, and correct aria-pressed state", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);

  const group = courseStatusGroup(page, "ECO 113");
  const completed = group.getByRole("button", { name: "Completed" });
  const takingNow = group.getByRole("button", { name: "Taking now" });
  await completed.focus();
  await expect(completed).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(completed).toHaveAttribute("aria-pressed", "true");
  await expect(completed.locator(".selection-check")).toHaveText("✓");
  await expect(takingNow.locator(".selection-check")).toHaveText("");

  await expect(async () => {
    const styles = await page.evaluate(() => {
      const selected = document.querySelector("#course-eco-113 button[aria-pressed='true']");
      const unselected = document.querySelector("#course-eco-113 button[aria-pressed='false']");
      return {
        selectedBackground: getComputedStyle(selected).backgroundColor,
        unselectedBackground: getComputedStyle(unselected).backgroundColor,
        selectedBorderWidth: getComputedStyle(selected).borderTopWidth,
        unselectedBorderWidth: getComputedStyle(unselected).borderTopWidth,
        outlineStyle: getComputedStyle(selected).outlineStyle
      };
    });
    expect(styles.selectedBackground).not.toBe(styles.unselectedBackground);
    expect(styles.selectedBorderWidth).toBe(styles.unselectedBorderWidth);
    expect(styles.outlineStyle).not.toBe("none");
  }).toPass({ timeout: 3000 });

  await page.keyboard.press("Enter");
  await expect(completed).toHaveAttribute("aria-pressed", "false");
  await expectNoAxeViolations(page);
});

test("a prerequisite error sends keyboard focus to the unresolved dependent row", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);
  await setCourseStatus(page, "ECO 213", "Taking now");
  await setCourseStatus(page, "MAT 113", "Completed", "Status for prerequisite");
  await setCourseStatus(page, "ECO 113", "Taking now", "Status for prerequisite");

  await expect(page.getByRole("button", { name: "Generate my plans" })).toBeDisabled();
  await page.locator("form").evaluate(form => form.requestSubmit());
  await expect(page.locator("#course-eco-213")).toBeFocused();
  const alert = page.locator("#course-eco-213 .prerequisite-conflict [role='alert']");
  await expect(alert).toBeVisible();
  expect((await alert.innerText()).length).toBeLessThan(220);
  await expect(page.locator("#course-eco-213 .prerequisite-conflict")).not.toHaveAttribute("role", "alert");
});

test("the desktop summary is sticky, bounded, and does not overlap the course column", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);
  await page.evaluate(() => window.scrollTo(0, 1000));

  const geometry = await page.evaluate(() => {
    const left = document.querySelector(".cp7-left").getBoundingClientRect();
    const summary = document.querySelector(".cp7-summary").getBoundingClientRect();
    return {
      position: getComputedStyle(document.querySelector(".cp7-summary")).position,
      leftRight: left.right,
      summaryLeft: summary.left,
      summaryTop: summary.top,
      summaryBottom: summary.bottom,
      viewportHeight: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth
    };
  });
  expect(geometry.position).toBe("sticky");
  expect(geometry.leftRight).toBeLessThanOrEqual(geometry.summaryLeft);
  expect(geometry.summaryTop).toBeGreaterThanOrEqual(0);
  expect(geometry.summaryBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
});

test("the mobile summary is inline, non-sticky, and causes no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await resetPlanner(page);
  await chooseStanding(page, "sophomore");
  await continueToCourses(page);
  await page.locator(".cp7-summary").scrollIntoViewIfNeeded();

  const geometry = await page.evaluate(() => {
    const summary = document.querySelector(".cp7-summary").getBoundingClientRect();
    const generate = document.querySelector(".generate-button").getBoundingClientRect();
    return {
      position: getComputedStyle(document.querySelector(".cp7-summary")).position,
      summaryLeft: summary.left,
      summaryRight: summary.right,
      generateLeft: generate.left,
      generateRight: generate.right,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth
    };
  });
  expect(geometry.position).toBe("static");
  expect(geometry.summaryLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.summaryRight).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.generateLeft).toBeGreaterThanOrEqual(geometry.summaryLeft);
  expect(geometry.generateRight).toBeLessThanOrEqual(geometry.summaryRight);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
});

test("a single returned plan has an accessible named region and results pass axe", async ({ page }) => {
  await openFixtureResult(page, plannerResultFixture());
  await expect(page.locator(".result-status-value")).toHaveText("Ready to plan");
  await visitPlan(page, "balanced");
  await expect(page.getByRole("region", { name: "Balanced plan" })).toBeVisible();
  await expectNoAxeViolations(page);
});
