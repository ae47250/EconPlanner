import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resetPlanner, chooseStanding, continueToCourses, setCourseStatus, generatePlans, visitPlan, reloadPlanner, openFixtureResult, plannerResultFixture } from './cp7-helpers.js';

const message = 'You may petition to count BUSN 323 as an Economics elective. This plan does not count it yet. Talk with your advisor about the petition.';

for (const device of ['desktop', 'mobile']) test(`${device}: finance correction survives generation, restoration and report rendering`, async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.setViewportSize(device === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  await resetPlanner(page);
  await chooseStanding(page, 'senior');
  await page.locator('details.more-details > summary').first().click();
  await page.getByLabel('Plan creation date', { exact: true }).fill('2026-07-30');
  await continueToCourses(page);
  for (const code of ['ECO 113', 'ECO 114', 'MAT 113', 'MAT 217', 'ECO 213', 'ECO 214', 'ECO 321', 'BUSN 323', 'ECO 221', 'ECO 234', 'ECO 260']) {
    await page.getByRole('searchbox', { name: 'Search courses', exact: true }).fill(code);
    await setCourseStatus(page, code, 'Completed');
  }
  await page.getByRole('searchbox', { name: 'Search courses', exact: true }).fill('');
  const response = await generatePlans(page);
  const payload = await response.json();
  const student = response.request().postDataJSON().student;
  const economics = payload.programs.find(item => item.program.id === 'economics-base');
  expect(economics.assignments.find(item => item.slotId === 'finance').code).toBe('ECO 321');
  expect(economics.assignments.filter(item => item.slotId.startsWith('eco-elective'))).toHaveLength(3);
  const plan = economics.economicsPlans[0];
  expect(plan).toBeTruthy();
  expect(plan.terms.flatMap(term => term.courses).some(course => course.requirementId?.startsWith('eco-elective') && ['ECO 321', 'BUSN 323'].includes(course.course))).toBe(false);
  const planCard = await visitPlan(page, plan.id);
  await expect(planCard.locator('[data-plan-conditions]')).toContainText(message);
  await reloadPlanner(page);
  await expect(page.getByRole('button', { name: 'Regenerate all plans', exact: true })).toBeEnabled();
  await expect(page.locator(`article.comparison-plan-card[data-plan-id="${plan.id}"] [data-plan-conditions]`)).toContainText(message);
  await page.screenshot({ path: testInfo.outputPath('finance-correction.png'), fullPage: true, animations: 'disabled' });

  if (device === 'desktop') {
    const body = { student, selectedPlan: plan, plans: economics.economicsPlans, preparedDate: '2026-07-30' };
    const htmlResponse = await page.request.post('/api/reports/economics', { data: body });
    expect(htmlResponse.status()).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain(message);
    const renderer = await page.context().newPage();
    try {
      await renderer.setContent(html, { waitUntil: 'load' });
      const pdf = await renderer.pdf({ path: testInfo.outputPath('finance-correction.pdf'), format: 'Letter', printBackground: true, preferCSSPageSize: true, tagged: true });
      const text = execFileSync(process.env.PDFTOTEXT || 'pdftotext', ['-', '-'], { input: pdf }).toString().replace(/\s+/g, ' ');
      expect(text).toContain(message);
      expect(text).toContain('ECO 321');
      expect(text).toContain('BUSN 323');
    } finally { await renderer.close(); }
  }
});

test('petition notice is visible even when no plan is available', async ({ page }) => {
  const report = plannerResultFixture({ plans: [], category: 'INFEASIBLE_PROVEN' });
  report.catalog = { advisorAttention: [{ code: 'BUSN_323_ELECTIVE_PETITION', category: 'ELECTIVE_PETITION', message }] };
  await openFixtureResult(page, report);
  await expect(page.locator('.no-plan-state')).toContainText(message);
});
