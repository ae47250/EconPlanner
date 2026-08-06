import { expect, test } from "./nightly-observability.js";

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function difference(expected, actual) {
  const expectedValues = unique(expected);
  const actualValues = unique(actual);
  return {
    expected: expectedValues.length,
    displayed: actualValues.length,
    missing: expectedValues.filter(value => !actualValues.includes(value)),
    extra: actualValues.filter(value => !expectedValues.includes(value))
  };
}

function feasibilityLabel(status) {
  return ({
    VERIFIED_FEASIBLE: "Verified feasible",
    CONDITIONALLY_FEASIBLE: "Conditionally feasible",
    PRELIMINARY_ONLY: "Preliminary only",
    SEARCH_INCOMPLETE: "Search incomplete - advisor review needed",
    NOT_FEASIBLE: "Not feasible"
  })[status] || "Status pending";
}

test("API and selected-plan UI retain material academic content", async ({ page }, testInfo) => {
  await page.goto("/?layout=apple");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.getByRole("group", { name: "Class standing" }).getByRole("button", { name: "Freshman" }).click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-07-30");

  const responsePromise = page.waitForResponse(response => (
    response.url().endsWith("/api/majors/map")
    && response.request().method() === "POST"
    && response.request().postDataJSON()?.action !== "validate-plan"
    && response.status() === 200
  ));
  await page.getByRole("button", { name: /Generate my plans/ }).click();
  const response = await responsePromise;
  const body = await response.json();
  const economics = body.programs.find(program => program.program?.id === "economics-base");
  const selectedPlan = economics.economicsPlans[0];
  await expect(page.getByRole("heading", { name: /Compare your plans|Your feasible plan/ })).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: new RegExp(`(?:Choose|Review selected) ${selectedPlan.label}`) }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Review ${selectedPlan.label}`) })).toBeVisible();

  const displayed = await page.evaluate(() => ({
    courses: [...document.querySelectorAll(".term-card .plan-course-summary > strong")].map(item => item.textContent.trim()),
    terms: [...document.querySelectorAll(".term-card")].map(item => `${item.dataset.academicYear}|${item.dataset.termKey}`),
    warnings: [...document.querySelectorAll(".plan-notes[role='status']:not(.planning-gaps) li")].map(item => item.textContent.trim()),
    advisorNotices: [...document.querySelectorAll(".advisor-attention-item > p")].map(item => item.textContent.trim()),
    approvals: [...document.querySelectorAll("[aria-label='Plan feasibility details'] li")].map(item => item.textContent.trim()),
    reviewItems: [...document.querySelectorAll(".planning-gaps li")].map(item => item.textContent.trim()),
    sourceLabels: [...document.querySelectorAll(".plan-source-note")].map(item => item.textContent.trim()),
    pageText: document.body.innerText
  }));
  const expectedApprovals = (selectedPlan.feasibility?.requiredApprovals || []).map(item => item.message);
  const expectedNotices = (selectedPlan.studentNotices || []).map(item => item.message);
  const expectedNoticeMessages = new Set(expectedNotices);
  const expectedReview = [...(selectedPlan.unscheduled || []), ...(economics.planningGaps || [])]
    .map(item => `${item.course ? `${item.course}: ` : ""}${item.reason || item.message}`);
  const expectedSource = `Published course schedule: ${String(selectedPlan.academicYear).replace("-", "/")}. Later unpublished schedules are shown as planning projections.`;
  const parity = {
    schemaVersion: 2,
    kind: "econplanner-api-ui-parity",
    planId: selectedPlan.id,
    courses: difference(selectedPlan.terms.flatMap(term => term.courses.map(course => course.course)), displayed.courses),
    terms: difference(selectedPlan.terms.map(term => `${term.academicYear || ""}|${term.termKey || ""}`), displayed.terms),
    status: {
      expected: selectedPlan.feasibilityStatus,
      displayed: displayed.pageText.includes(feasibilityLabel(selectedPlan.feasibilityStatus)),
      missing: displayed.pageText.includes(feasibilityLabel(selectedPlan.feasibilityStatus)) ? [] : [selectedPlan.feasibilityStatus],
      extra: []
    },
    warnings: difference((selectedPlan.studentMessages || []).filter(message => !expectedNoticeMessages.has(message)), displayed.warnings),
    advisorNotices: difference(expectedNotices, displayed.advisorNotices.filter(value => expectedNoticeMessages.has(value))),
    approvals: difference(expectedApprovals, displayed.approvals.filter(value => expectedApprovals.includes(value))),
    reviewItems: difference(expectedReview, displayed.reviewItems),
    sourceLabels: {
      expected: 1,
      displayed: displayed.sourceLabels.length,
      missing: displayed.sourceLabels.some(value => value.includes(expectedSource)) ? [] : [expectedSource],
      extra: []
    }
  };
  parity.materialMissingCount = Object.values(parity)
    .filter(value => value && Array.isArray(value.missing))
    .reduce((sum, value) => sum + value.missing.length, 0);
  parity.materialExtraCount = Object.values(parity)
    .filter(value => value && Array.isArray(value.extra))
    .reduce((sum, value) => sum + value.extra.length, 0);
  await testInfo.attach("econplanner-api-ui-parity.json", {
    body: Buffer.from(JSON.stringify(parity, null, 2)),
    contentType: "application/json"
  });
  expect(parity.materialMissingCount, JSON.stringify(parity)).toBe(0);
  expect(parity.materialExtraCount, JSON.stringify(parity)).toBe(0);
});
