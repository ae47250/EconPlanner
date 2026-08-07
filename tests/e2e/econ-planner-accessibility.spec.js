import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./nightly-observability.js";

const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 }
];
const FOLLOWUP_NOTICE_MESSAGES = [
  "This plan assumes you will have senior standing in your final year so you can take ECO 461. Please check this with your advisor as you get closer to that year.",
  "Courses later in your plan are best estimates because those schedules have not been published yet. Use this plan as a guide and update it with your advisor when new schedules become available.",
  "This plan uses the department’s current, more flexible Economics major requirements (2025–2026) instead of the student’s incoming catalog requirements (2024–2025). Please help the student submit the routine SAC petition so the newer requirements are recorded for the degree audit. The department treats this petition as a formality.",
  "This plan uses the department’s current, more flexible Economics major requirements (2025–2026). The student’s incoming catalog year is not known, so the advisor should confirm it for degree-audit records."
];

async function resetPlanner(page, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto("/?layout=apple");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
}

function courseStatus(page, code, status) {
  return page
    .getByRole("group", { name: `Status for ${code}` })
    .getByRole("button", { name: status, exact: true });
}

async function scanWcagAa(page, state) {
  // Automated axe checks cover only machine-testable WCAG rules. They are not
  // a substitute for manual screen-reader testing or certification.
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
  await test.info().attach(`axe-${state.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`, {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json"
  });
  const findings = results.violations.map(violation => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.flatMap(node => node.target)
  }));
  expect.soft(findings, `${state} has automated WCAG AA violations`).toEqual([]);
}

async function activeElementDetails(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return null;
    const group = element.closest('[role="group"]');
    const label = element.labels?.[0]?.innerText?.trim();
    return {
      tag: element.tagName.toLowerCase(),
      name: element.getAttribute("aria-label") || label || element.innerText?.trim() || element.value || "",
      group: group?.getAttribute("aria-label") || ""
    };
  });
}

async function tabTo(page, matcher, maximumTabs = 120) {
  for (let index = 0; index < maximumTabs; index += 1) {
    await page.keyboard.press("Tab");
    const active = await activeElementDetails(page);
    if (active && matcher(active)) return active;
  }
  throw new Error(`Keyboard focus did not reach the expected control after ${maximumTabs} Tab presses.`);
}

async function assertVisibleFocus(page, label) {
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { focusVisible: false, indicator: false };
    const style = window.getComputedStyle(element);
    const outlineVisible = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
    const shadowVisible = style.boxShadow !== "none";
    return {
      focusVisible: element.matches(":focus-visible"),
      indicator: outlineVisible || shadowVisible
    };
  });
  expect.soft(focus.focusVisible, `${label} should match :focus-visible`).toBe(true);
  expect.soft(focus.indicator, `${label} should have a visible outline or focus shadow`).toBe(true);
}

async function generatePlans(page) {
  const responsePromise = page.waitForResponse(response => (
    response.url().endsWith("/api/majors/map") && response.request().method() === "POST"
  ));
  await page.getByRole("button", { name: /Generate my plans/ }).click();
  await expect(page.getByRole("status")).toContainText("Building your economics plan");
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /Compare your plans|Your feasible plan/ })).toBeVisible({ timeout: 15_000 });
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} accessibility`, () => {
    test("input, transfer, validation, and prerequisite dialog states support accessible keyboard use", async ({ page }) => {
      test.setTimeout(90_000);
      await resetPlanner(page, viewport);

      await expect(page.getByRole("group", { name: "Class standing" })).toBeVisible();
      await expect.soft(page.getByRole("textbox", { name: "Student name (optional)" })).toHaveAccessibleName("Student name (optional)");
      await expect.soft(page.getByLabel("Plan creation date", { exact: true })).toHaveAccessibleName("Plan creation date");
      await expect.soft(page.getByLabel("Expected graduation", { exact: true })).toHaveAccessibleName("Expected graduation");
      await expect.soft(page.getByRole("searchbox")).toHaveAccessibleName(/search/i);
      await scanWcagAa(page, `${viewport.name}-initial-input-page`);

      await page.evaluate(() => document.activeElement?.blur());
      await tabTo(page, active => active.name === "Transfer students: Change graduation year");
      await assertVisibleFocus(page, `${viewport.name} transfer-student trigger`);
      await page.keyboard.press("Enter");

      const transferRegion = page.getByRole("region", { name: "Transfer student planning" });
      await expect(transferRegion).toBeVisible();
      await expect(page.getByRole("group", { name: "When do you expect to graduate?" })).toBeVisible();
      await expect(page.getByLabel("When did you first enroll at Hanover?")).toBeVisible();
      const transferAlert = transferRegion.getByRole("alert");
      await expect(transferAlert).toContainText("Choose an expected graduation year");
      await expect(transferAlert).toContainText("Choose when you first enrolled at Hanover");
      await scanWcagAa(page, `${viewport.name}-transfer-student-form`);
      await scanWcagAa(page, `${viewport.name}-validation-errors`);

      await tabTo(page, active => active.name === "Use regular class-year choices");
      await assertVisibleFocus(page, `${viewport.name} regular-standing trigger`);
      await page.keyboard.press("Space");
      await expect(transferRegion).toHaveCount(0);

      const inProgress213 = courseStatus(page, "ECO 213", "In progress");
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo(page, active => active.name === "In progress" && active.group === "Status for ECO 213");
      await expect(inProgress213).toBeFocused();
      await assertVisibleFocus(page, `${viewport.name} ECO 213 In progress button`);
      await page.keyboard.press("Space");

      const dialog = page.getByRole("dialog", { name: "Confirm prerequisites for ECO 213" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toBeFocused();
      await expect(dialog).toHaveAccessibleName("Confirm prerequisites for ECO 213");
      await scanWcagAa(page, `${viewport.name}-prerequisite-dialog`);

      await page.keyboard.press("Tab");
      expect.soft(await dialog.evaluate(element => element.contains(document.activeElement)), "Tab should move inside the prerequisite dialog").toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect.soft(await dialog.evaluate(element => element.contains(document.activeElement)), "The inline non-modal dialog should allow backward keyboard exit").toBe(false);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(inProgress213).toBeFocused();

      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      const focusableCount = await dialog.locator('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])').count();
      for (let index = 0; index <= focusableCount; index += 1) await page.keyboard.press("Tab");
      expect.soft(await dialog.evaluate(element => element.contains(document.activeElement)), "The inline non-modal dialog must not create a keyboard trap").toBe(false);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(inProgress213).toBeFocused();
    });

    test("plan comparison, advisor warnings, and selected-plan tabs remain accessible", async ({ page }) => {
      test.setTimeout(120_000);
      await resetPlanner(page, viewport);
      await page.route("**/api/majors/map", async route => {
        await new Promise(resolve => setTimeout(resolve, 300));
        const response = await route.fetch();
        const data = await response.json();
        data.catalog = data.catalog || {};
        data.catalog.advisorAttention = FOLLOWUP_NOTICE_MESSAGES.map((message, index) => ({
          code: `CP4B_B_ACCESSIBILITY_NOTICE_${index + 1}`,
          title: "Planning information",
          severity: "info",
          message
        }));
        await route.fulfill({ response, json: data });
      });
      await generatePlans(page);

      await expect(page.getByRole("heading", { name: "Compare your plans" })).toBeVisible();
      const advisorAttention = page.locator(".advisor-attention");
      await expect(advisorAttention.getByRole("heading", { name: "Advisor Attention" })).toBeVisible();
      await expect(advisorAttention).toHaveAttribute("aria-live", "polite");
      for (const message of FOLLOWUP_NOTICE_MESSAGES) {
        await expect(advisorAttention.getByText(message, { exact: true })).toBeVisible();
      }
      await scanWcagAa(page, `${viewport.name}-plan-comparison`);
      await scanWcagAa(page, `${viewport.name}-advisor-warnings`);

      const reviewPlanA = page.getByRole("button", { name: "Review selected Plan A" });
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo(page, active => active.name === "Review selected Plan A");
      await expect(reviewPlanA).toBeFocused();
      await assertVisibleFocus(page, `${viewport.name} selected-plan review button`);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Review Plan A" })).toBeVisible();

      const tablist = page.getByRole("tablist", { name: "Generated plans" });
      await expect(tablist).toBeVisible();
      const tabs = tablist.getByRole("tab");
      expect(await tabs.count()).toBeGreaterThan(1);
      for (const tab of await tabs.all()) {
        const controls = await tab.getAttribute("aria-controls");
        const tabId = await tab.getAttribute("id");
        expect.soft(controls, "Every plan tab needs aria-controls").toBeTruthy();
        expect.soft(tabId, "Every plan tab needs an id").toBeTruthy();
        if (controls) {
          const panel = page.locator(`[role="tabpanel"]#${controls}`);
          expect.soft(await panel.count(), `${await tab.innerText()} should reference an existing tabpanel`).toBe(1);
          if (await panel.count()) expect.soft(await panel.getAttribute("aria-labelledby")).toBe(tabId);
        }
      }

      const planB = tablist.getByRole("tab", { name: "Plan B" });
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo(page, active => active.name === "Plan B");
      await expect(planB).toBeFocused();
      await assertVisibleFocus(page, `${viewport.name} Plan B tab`);
      await page.keyboard.press("Space");
      await expect(planB).toHaveAttribute("aria-selected", "true");
      const planBPanel = page.getByRole("tabpanel", { name: "Plan B" });
      await expect(planBPanel).toBeVisible();
      await page.keyboard.press("Shift+Tab");
      expect.soft((await activeElementDetails(page))?.name).not.toBe("Plan B");
      await page.keyboard.press("Tab");
      await expect(planB).toBeFocused();
      await scanWcagAa(page, `${viewport.name}-selected-plan-review`);
    });

    test("empty no-valid-plan result remains perceivable and keyboard reachable", async ({ page }) => {
      test.setTimeout(90_000);
      await resetPlanner(page, viewport);
      await page.route("**/api/majors/map", async route => {
        const response = await route.fetch();
        const data = await response.json();
        const economics = data.programs?.find(program => program.program?.id === "economics-base");
        if (economics) {
          economics.economicsPlans = [];
          economics.economicsPlan = null;
        }
        await route.fulfill({ response, json: data });
      });
      await page.getByRole("button", { name: /Generate my plans/ }).click();
      const emptyState = page.getByText("No validated plan can be displayed for this profile.", { exact: true });
      await expect(emptyState).toBeVisible({ timeout: 15_000 });
      await scanWcagAa(page, `${viewport.name}-empty-no-valid-plan`);

      const backButton = page.getByRole("button", { name: /Back to course selection/ });
      await page.evaluate(() => document.activeElement?.blur());
      await tabTo(page, active => active.name.includes("Back to course selection"));
      await expect(backButton).toBeFocused();
      await assertVisibleFocus(page, `${viewport.name} empty-state back button`);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
    });
  });
}
