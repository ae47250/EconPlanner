import {test, expect} from './nightly-observability.js';
import AxeBuilder from '@axe-core/playwright';
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resetPlanner, chooseStanding, continueToCourses, generatePlans, setCourseStatus} from './cp7-helpers.js';

// These journeys establish reachability using ordinary controls. Only PDF transport
// failures are simulated. Export JSON/HTML requests replay the actual UI request.
async function intake(page, standing, early = false) {
  await resetPlanner(page);
  await chooseStanding(page, standing);
  await page.locator('details.more-details > summary').first().click();
  await page.getByLabel('Plan creation date', {exact:true}).fill('2026-09-23');
  if (early) await page.getByRole('button', {name: standing === 'junior' ? 'I’d like to graduate next year' : 'I’d like to graduate one year early', exact:true}).click();
  await continueToCourses(page);
}

async function move(page, course, destination, status = 200) {
  const menu = page.getByRole('combobox', {name:`Move ${course} to another term`, exact:true});
  const response = page.waitForResponse(r => r.url().endsWith('/api/majors/map') && r.request().postDataJSON()?.action === 'validate-plan');
  await menu.selectOption(destination);
  const result = await response;
  const body = await result.json();
  expect(result.status(), JSON.stringify(body)).toBe(status);
  if (status !== 200) {
    await expect(menu).toBeFocused();
    await expect(page.locator('.plan-edit-status')).toHaveAttribute('role','status');
  } else await expect(page.locator('.plan-edit-status')).toContainText('updated and remains valid');
  return body;
}

async function exportLocalPdf(page, browser, testInfo, name, expectedTarget, {failFirst = false} = {}) {
  let attempt = 0;
  const requests = [];
  let report;
  await page.route('**/api/reports/economics', async route => {
    const actual = route.request().postDataJSON();
    requests.push(actual);
    if (failFirst && ++attempt === 1) {
      await route.fulfill({status:504, contentType:'application/json', body:JSON.stringify({error:'PDF creation timed out. Please try again.'})});
      return;
    }
    const json = await page.request.post('/api/reports/economics', {data:{...actual, format:'json'}});
    expect(json.status()).toBe(200);
    expect(json.headers()['cache-control']).toBe('no-store');
    report = await json.json();
    const htmlResponse = await page.request.post('/api/reports/economics', {data:{...actual, format:'html'}});
    expect(htmlResponse.status()).toBe(200);
    const html = await htmlResponse.text();
    expect(report.student.expectedGraduationTerm).toBe(expectedTarget);
    expect(report.terms.map(t => t.courses.map(c => c.code))).toEqual(actual.selectedPlan.terms.map(t => t.courses.map(c => c.course)));
    expect(report.planningHorizon).toContain(actual.selectedPlan.terms.at(-1).term);
    expect(html).toContain('Selected plan horizon');
    expect(html).not.toContain('Balanced planning horizon');
    const renderer = await browser.newPage();
    await renderer.setContent(html, {waitUntil:'load'});
    const bytes = await renderer.pdf({format:'Letter', printBackground:true,
      margin:{top:'0.42in',right:'0.42in',bottom:'0.42in',left:'0.42in'}});
    await renderer.close();
    const text = execFileSync(process.env.PDFTOTEXT || 'pdftotext', ['-','-'], {input:bytes}).toString().replace(/\s+/g,' ');
    expect(text).toContain(expectedTarget);
    expect(text).toMatch(/selected plan horizon/i);
    expect(text).toContain(report.planningHorizon);
    expect(text).toContain('ECO 461');
    for (const term of report.terms) for (const course of term.courses) expect(text).toContain(course.code);
    await writeFile(testInfo.outputPath(`${name}.json`), JSON.stringify(report,null,2));
    await writeFile(testInfo.outputPath(`${name}.html`), html);
    await writeFile(testInfo.outputPath(`${name}.txt`), text);
    await route.fulfill({contentType:'application/pdf', body:bytes});
  });
  const button = page.getByRole('button', {name:'Download PDF', exact:true});
  if (failFirst) {
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.pdf-download-status')).toContainText('PDF creation took too long');
    await expect(button).toBeEnabled();
    await expect(button).toBeFocused();
  }
  const download = page.waitForEvent('download');
  await button.click();
  await (await download).saveAs(testInfo.outputPath(`${name}.pdf`));
  await expect(page.locator('.pdf-download-status')).toHaveText('PDF ready. Download started.');
  await expect(page.locator('.pdf-download-status')).toHaveAttribute('aria-live','polite');
  if (failFirst) expect(requests[0]).toEqual(requests[1]);
  await page.unroute('**/api/reports/economics');
  return report;
}

test('freshman early selection, persistence, evidence-aware moves, rollback and local PDF parity', async ({page,browser}, testInfo) => {
  await intake(page, 'freshman', true);
  const response = await generatePlans(page);
  const payload = await response.json();
  const plans = payload.programs.find(p => p.program.id === 'economics-base').economicsPlans;
  expect(plans.map(p => p.id)).toEqual(['balanced','explore-first','one-year-early']);
  await expect(page.getByText('Same degree requirements; compare pace, course placement and graduation target.')).toBeVisible();
  await page.getByRole('button',{name:/^(Choose|Review selected) One Year Early$/}).click();
  const target = page.locator('.comparison-course-status p').filter({hasText:'Graduation target'});
  await expect(target).toContainText('Spring/May 2029');
  await expect(page.getByText('Future course offerings are projected and must be confirmed.')).toBeVisible();
  await page.reload();
  await expect(target).toContainText('Spring/May 2029');
  await page.getByRole('button',{name:'← Back to plan comparison',exact:true}).click();
  await page.getByRole('button',{name:/^(Choose|Review selected) One Year Early$/}).click();
  await expect(target).toContainText('Spring/May 2029');
  await exportLocalPdf(page,browser,testInfo,'early','Spring/May 2029',{failFirst:true});
  const valid = await move(page,'MAT 217','winter-2027');
  const statistics = valid.plan.terms.find(t => t.slotId === 'winter-2027').courses.find(c => c.course === 'MAT 217');
  expect(['J','K','L','M']).toContain(statistics.section);
  expect(statistics.source).toBe('verified-offering');
  const invalid = await move(page,'MAT 217','winter-2029',422);
  expect(invalid.error).toMatch(/prerequisite|statistics/i);
  expect(invalid.error).not.toMatch(/Fall 2028|projected standing/);
  await expect(page.getByRole('combobox',{name:'Move MAT 217 to another term',exact:true})).toHaveValue('winter-2027');
  await expect(page.getByText('ECO 222 is typically offered only in Spring/May. A different term needs a published schedule confirming it.')).toBeVisible();
  const eco222MoveOptions = await page.getByRole('combobox',{name:'Move ECO 222 to another term',exact:true})
    .locator('option').evaluateAll(options => options.map(option => option.value));
  expect(eco222MoveOptions.length).toBeGreaterThan(1);
  expect(eco222MoveOptions.every(termId => termId.startsWith('spring-') || termId.startsWith('may-'))).toBe(true);
  await expect(page.locator('.pdf-download-status')).toHaveCount(0);
  await exportLocalPdf(page,browser,testInfo,'early-edited','Spring/May 2029');
  await page.getByRole('button',{name:'← Back to plan comparison',exact:true}).click();
  await page.getByRole('button',{name:/^(Choose|Review selected) Balanced$/}).click();
  await expect(target).toContainText('Spring/May 2030');
  await expect(page.locator('.pdf-download-status')).toHaveCount(0);
  const balanced = await exportLocalPdf(page,browser,testInfo,'balanced','Spring/May 2030');
  expect(balanced.inputSummary).toContain('Planning pace: standard');
  expect(balanced.inputSummary).not.toContain('one year early');
  await page.screenshot({path:testInfo.outputPath('balanced-review.png'),fullPage:true,animations:'disabled'});
});

test('required controls explain restrictions while mobile elective editing and keyboard flows remain usable', async ({page},testInfo) => {
  await page.setViewportSize({width:390,height:844});
  await intake(page,'freshman');
  await page.getByRole('button',{name:'Generate my plans',exact:true}).focus();
  const response = page.waitForResponse(r=>r.url().endsWith('/api/majors/map')&&r.status()===200);
  await page.keyboard.press('Enter');
  await response;
  await page.getByRole('button',{name:/^(Choose|Review selected) Balanced$/}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'Review Balanced',exact:true})).toBeFocused();
  await expect(page.getByRole('button',{name:'Remove ECO 113',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Remove BUSN 323',exact:true})).toHaveCount(0);
  await expect(page.locator('.required-course-note').first()).toBeVisible();
  const menu = page.getByRole('combobox',{name:'Move ECO elective to another term',exact:true}).last();
  const edited = page.waitForResponse(r=>r.url().endsWith('/api/majors/map')&&r.request().postDataJSON()?.action==='validate-plan');
  await menu.selectOption('fall-2029');
  expect((await edited).status()).toBe(200);
  await expect(page.locator('.plan-edit-status')).toContainText('remains valid');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.locator('main').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('mobile-edited.png'),fullPage:true,animations:'disabled'});
});

test('course cards limit move terms and explain a rejected prerequisite move beside the course', async ({page}) => {
  await intake(page, 'freshman', true);
  await generatePlans(page);
  await page.getByRole('button',{name:/^(Choose|Review selected) One Year Early$/}).click();
  const coreMove = page.getByRole('combobox',{name:'Move ECO 113 to another term',exact:true});
  await expect(coreMove.locator('option[value^="spring-"]')).toHaveCount(0);
  await expect(page.getByRole('combobox',{name:'Move ECO 222 to another term',exact:true})).toHaveCount(0);
  await expect(page.getByText('ECO 222 is typically offered only in Spring/May. A different term needs a published schedule confirming it.')).toBeVisible();
  await expect(page.getByRole('combobox',{name:'Move ECO 461 to another term',exact:true})).toHaveCount(0);
  await expect(page.getByText(/ECO 461 stays in senior Winter/)).toBeVisible();
  const response = page.waitForResponse(r => r.url().endsWith('/api/majors/map') && r.request().postDataJSON()?.action === 'validate-plan');
  await coreMove.selectOption('fall-2027');
  expect((await response).status()).toBe(422);
  const coreCard = page.locator('.term-card li').filter({has:page.getByRole('combobox',{name:'Move ECO 113 to another term',exact:true})});
  await expect(coreCard.getByRole('alert')).toContainText('ECO 213 is missing prerequisites: ECO 113');
  await expect(coreMove).toHaveValue('winter-2027');
});

test('senior statistics blocker is causal and saved answers survive revisiting', async ({page},testInfo) => {
  await intake(page,'senior');
  await page.getByText('Other Economics courses',{exact:true}).click();
  for(const code of ['ECO 113','ECO 114','MAT 113','MAT 217','ECO 213','ECO 214','BUSN 323','ECO 161','ECO 221','ECO 222','ECO 234']) await setCourseStatus(page,code,'Completed');
  const ready = await (await generatePlans(page)).json();
  expect(ready.programs.find(p=>p.program.id==='economics-base').economicsPlans.length).toBeGreaterThan(0);
  await page.getByRole('button',{name:'← Back to course selection',exact:true}).click();
  await setCourseStatus(page,'MAT 217','Completed');
  await generatePlans(page);
  await expect(page.locator('.result-status-value')).toHaveText('No complete plan');
  await page.locator('details.result-diagnostics > summary').click();
  await expect(page.locator('details.result-diagnostics')).toContainText('Your available planning terms start in Winter 2027');
  await expect(page.locator('details.result-diagnostics')).toContainText('statistics (ECO 257 / MAT 217 / PSY 217) must be completed before that term');
  await expect(page.locator('details.result-diagnostics li')).toHaveCount(1);
  await page.screenshot({path:testInfo.outputPath('senior-blocker.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'← Back to course selection',exact:true}).click();
  await expect(page.getByRole('group',{name:'Status for MAT 217',exact:true}).getByRole('button',{name:'Completed',exact:true})).toHaveAttribute('aria-pressed','false');
  await expect(page.getByRole('group',{name:'Status for ECO 213',exact:true}).getByRole('button',{name:'Completed',exact:true})).toHaveAttribute('aria-pressed','true');
});

test('junior prerequisite correction preserves choices and explains next-year outcome', async ({page}) => {
  await intake(page,'junior');
  await setCourseStatus(page,'ECO 213','Taking now');
  await page.getByRole('button',{name:'Generate my plans',exact:true}).click();
  await expect(page.locator('#course-eco-213')).toBeFocused();
  await setCourseStatus(page,'ECO 113','Completed','Status for prerequisite');
  await setCourseStatus(page,'MAT 113','Completed','Status for prerequisite');
  await page.getByRole('button',{name:'Back to about you',exact:true}).click();
  await page.getByRole('button',{name:'I’d like to graduate next year',exact:true}).click();
  await continueToCourses(page);
  const result = await (await generatePlans(page)).json();
  const economics = result.programs.find(p=>p.program.id==='economics-base');
  expect(economics.economicsPlans[0].planningContext.expectedGraduationTerm).toBe('Spring/May 2028');
  expect(economics.economicsPlans.some(p=>p.isEarlyGraduation)).toBe(false);
  await expect(page.getByRole('heading',{name:'Your feasible plan',exact:true})).toBeFocused();
  await expect(page.getByRole('heading',{name:'Graduate next year: Not possible',exact:true})).toBeVisible();
});
