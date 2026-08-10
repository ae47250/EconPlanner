import { expect, test } from "./nightly-observability.js";
import {
  chooseStanding,
  continueToCourses,
  fixturePlan,
  inputBlockedFixture,
  openFixtureResult,
  plannerResultFixture,
  resetPlanner,
  setCourseStatus
} from "./cp7-helpers.js";

async function setFirstCustomTimeline(page) {
  await page.getByRole("button", { name: "My graduation timeline is different" }).click();
  await page.getByLabel("When do you expect to graduate?").selectOption({ index: 1 });
  await page.getByLabel("When did you first enroll at Hanover?").selectOption({ index: 1 });
}

const visualStates = [
  {
    id: "freshman-standard-intake",
    setup: async page => {
      await resetPlanner(page);
      await chooseStanding(page, "freshman");
      await expect(page.locator(".standing-feedback")).toBeVisible();
    }
  },
  {
    id: "sophomore-one-year-early",
    setup: async page => {
      await resetPlanner(page);
      await chooseStanding(page, "sophomore");
      await page.getByRole("button", { name: "Include a one-year-early plan" }).click();
      await expect(page.locator(".cp7-summary")).toContainText("One-year-early target");
    }
  },
  {
    id: "junior-intake",
    setup: async page => {
      await resetPlanner(page);
      await chooseStanding(page, "junior");
      await expect(page.getByRole("button", { name: "Include a one-year-early plan" })).toHaveCount(0);
    }
  },
  {
    id: "custom-timeline-expanded",
    setup: async page => {
      await resetPlanner(page);
      await chooseStanding(page, "sophomore");
      await setFirstCustomTimeline(page);
      await expect(page.locator(".custom-timeline-panel")).toBeVisible();
    }
  },
  {
    id: "long-course-selection",
    fullPage: true,
    setup: async page => {
      await resetPlanner(page);
      await chooseStanding(page, "freshman");
      await continueToCourses(page);
      await page.getByText("Other Economics courses", { exact: true }).click();
      expect(await page.locator(".course-row").count()).toBeGreaterThan(20);
    }
  },
  {
    id: "eco-213-prerequisite-follow-up",
    setup: async page => {
      await resetPlanner(page);
      await chooseStanding(page, "freshman");
      await continueToCourses(page);
      await setCourseStatus(page, "ECO 213", "Taking now");
      await page.locator("#course-eco-213").scrollIntoViewIfNeeded();
      await expect(page.locator("#course-eco-213 .inline-prerequisite")).toBeVisible();
    }
  },
  {
    id: "prerequisite-conflict",
    setup: async page => {
      await resetPlanner(page);
      await chooseStanding(page, "freshman");
      await continueToCourses(page);
      await setCourseStatus(page, "ECO 213", "Taking now");
      await setCourseStatus(page, "MAT 113", "Completed", "Status for prerequisite");
      await setCourseStatus(page, "ECO 113", "Not taken / not sure", "Status for prerequisite");
      await page.locator("#course-eco-213").scrollIntoViewIfNeeded();
      await expect(page.locator("#course-eco-213 .prerequisite-conflict")).toBeVisible();
    }
  },
  {
    id: "desktop-sticky-summary",
    setup: async (page, viewportName) => {
      await resetPlanner(page);
      await chooseStanding(page, "freshman");
      await continueToCourses(page);
      if (viewportName === "desktop") {
        await page.evaluate(() => window.scrollTo(0, 1100));
      } else {
        await page.locator(".cp7-summary").scrollIntoViewIfNeeded();
      }
      await expect(page.locator(".cp7-summary")).toBeVisible();
    }
  },
  {
    id: "mobile-inline-summary",
    setup: async page => {
      await resetPlanner(page);
      await chooseStanding(page, "sophomore");
      await continueToCourses(page);
      await setCourseStatus(page, "ECO 113", "Completed");
      await setCourseStatus(page, "ECO 114", "Taking now");
      await page.locator(".cp7-summary").scrollIntoViewIfNeeded();
      await expect(page.locator(".cp7-summary")).toContainText("ECO 113");
      await expect(page.locator(".cp7-summary")).toContainText("ECO 114");
    }
  },
  {
    id: "ordinary-results",
    setup: async page => {
      await openFixtureResult(page, plannerResultFixture());
      await expect(page.locator(".result-status-value")).toHaveText("Ready");
    }
  },
  {
    id: "input-blocked-results",
    setup: async page => {
      await openFixtureResult(page, inputBlockedFixture(), 422);
      await expect(page.locator(".no-plan-state")).toContainText("We need one more detail");
    }
  },
  {
    id: "conditional-advisor-results",
    setup: async page => {
      const plan = fixturePlan({
        readinessStatus: "ADVISOR_ACTION_REQUIRED",
        planDisposition: "COMPLETE_ADVISOR_ACTION_REQUIRED",
        conditions: [{ code: "CURRENT_COMPLETION", message: "Confirm successful completion of the current course." }],
        advisorActions: [{ code: "APPROVAL", message: "Meet with your advisor to confirm the required approval." }]
      });
      await openFixtureResult(page, plannerResultFixture({ plans: [plan] }));
      await expect(page.locator(".plan-conditions")).toBeVisible();
      await expect(page.locator(".plan-advisor-actions")).toBeVisible();
      await page.locator(".plan-conditions").scrollIntoViewIfNeeded();
    }
  }
];

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 }
]) {
  test.describe(`${viewport.name} CP7 visual evidence`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const state of visualStates) {
      test(`${state.id} at ${viewport.width}x${viewport.height}`, async ({ page, nightlyObservability }, testInfo) => {
        nightlyObservability.recordViewport(state.id);
        await state.setup(page, viewport.name);
        await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
        await page.evaluate(async () => {
          const animations = document.getAnimations().filter(animation => (
            Number.isFinite(animation.effect?.getComputedTiming().endTime)
          ));
          await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
        });

        const layout = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          bodyWidth: document.body.getBoundingClientRect().width
        }));
        expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.clientWidth);
        expect(layout.bodyWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.clientWidth);

        const screenshotPath = testInfo.outputPath(`${viewport.name}-${state.id}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: Boolean(state.fullPage) });
        await testInfo.attach(`${viewport.name}-${state.id}.png`, {
          path: screenshotPath,
          contentType: "image/png"
        });
      });
    }
  });
}
