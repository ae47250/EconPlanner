import { loadCanonicalPolicy, oracleEvaluateCanonicalPlan, oracleEvaluateOffering } from "../oracle/load-canonical-policy.js";
import { selectedPlanCard, visitPlan } from "./cp7-helpers.js";
import {test, expect} from './nightly-observability.js';
import AxeBuilder from '@axe-core/playwright';
import {writeFile, readFile} from 'node:fs/promises';
import { auditExternalEconomicsPlanComplete } from '../oracle/audit-external-plan.js';
import {execFileSync} from 'node:child_process';
import {resetPlanner, reloadPlanner, chooseStanding, continueToCourses, generatePlans, setCourseStatus} from './cp7-helpers.js';

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
  if (status !== 200) {
    const body = await page.evaluate(({course,destination}) => {
      const session = JSON.parse(sessionStorage.getItem('econ-planner-generated-session'));
      const plans = session.report.programs.find(item => item.economicsPlans).economicsPlans;
      const plan = plans.find(item => item.id === session.selectedPlanId);
      const term = plan.terms.find(item => item.courses.some(item => item.course === course));
      return {action:'validate-plan', student:session.formData, plan, plans,
        edit:{type:'move',fromTermId:term.slotId,toTermId:destination,courseId:term.courses.find(item=>item.course===course).requirementId}};
    }, {course,destination});
    // Use the original intake request's student data, not presentation storage.
    body.student = JSON.parse(await page.evaluate(()=>localStorage.getItem('econ-planner-ui-state'))).formData;
    body.student.courses = body.student.courses.filter(course=>['completed','transfer','in_progress'].includes(course.status));
    const result = await page.request.post('/api/majors/map',{data:body});
    const data = await result.json();
    expect(result.status(),JSON.stringify(data)).toBe(status);
    return data;
  }
  const label = course === 'ECO elective' ? 'Economics elective (200 level or higher)' : course;
  const planCard = selectedPlanCard(page);
  const button = planCard.getByRole('button',{name:new RegExp(`^Change ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-[A-Z])?$`)}).first();
  const actualLabel = await button.getAttribute('aria-label');
  await button.click();
  const menu = planCard.getByRole('region',{name:`${actualLabel} options`,exact:true});
  const response = page.waitForResponse(r => r.url().endsWith('/api/majors/map') && r.request().postDataJSON()?.action === 'validate-plan');
  const option = menu.locator(`[data-change-choice="move:${destination}"]`);
  const conditional = await option.getAttribute('data-change-status') === 'CONDITIONAL';
  await option.click();
  if (conditional) await menu.getByRole('button',{name:'Apply change',exact:true}).click();
  const result = await response;
  const body = await result.json();
  expect(result.status(), JSON.stringify(body)).toBe(status);
  await expect(planCard.locator('.comparison-edit-status')).toContainText('Moved to');
  return body;
}

async function exportLocalPdf(page, browser, testInfo, name, expectedTarget, {failFirst = false, planId = "balanced"} = {}) {
  let attempt = 0;
  const requests = [];
  let report;
  await page.route('**/api/reports/economics', async route => {
    const actual = route.request().postDataJSON();
    requests.push(actual);
    const academicAudit = oracleEvaluateCanonicalPlan(await loadCanonicalPolicy(), actual.student, actual.selectedPlan);
    expect(academicAudit.valid, JSON.stringify(academicAudit)).toBe(true);
    const completeAudit = auditExternalEconomicsPlanComplete({
      student: { academicStanding:actual.student.academicStanding, completedCourses:actual.student.courses.filter(c=>c.status==='completed').map(c=>({course:c.code})), reservedCourseUnits:actual.student.reservedCourseUnits },
      expectedContext:actual.selectedPlan.planningContext,
      plan:{id:actual.selectedPlan.id,terms:actual.selectedPlan.terms.map(term=>({...term,courses:term.courses.map(course=>{
        const value={...course,canonicalCrossListIdentity:[course.course,...(course.crossListedAs||[])],provenance:{verificationDate:course.provenance?.verifiedOn??null,sourceReference:course.provenance?.sourceFiles?.[0]??null},...(course.course==='ECO 461'&&course.residency==='hanover'?{institution:'Hanover College'}:{})};
        if(!value.section) delete value.section;
        return value;
      })})),requirementClaims:[]},
      policy:JSON.parse(await readFile(new URL('../oracle/economics-policy.v1.json',import.meta.url),'utf8')),
      verifiedSchedule:JSON.parse(await readFile(new URL('../oracle/verified-schedule-2026-2027.json',import.meta.url),'utf8'))
    });
    expect(completeAudit.violations,JSON.stringify(completeAudit)).toEqual([]);
    expect(completeAudit.uncheckedRuleFamilies,JSON.stringify(completeAudit)).toEqual([]);
    const planCard = page.locator(`article.comparison-plan-card[data-plan-id="${actual.selectedPlan.id}"]`);
    for (const term of actual.selectedPlan.terms) {
      const displayed = await planCard.locator(`.compact-schedule [data-term-id="${term.slotId}"] .comparison-editable-course`).evaluateAll(rows => rows.map(row => {
        const control = row.querySelector('.plan-course-actions > button');
        return control ? control.getAttribute('aria-label').replace(/^Change /, '').replace('Economics elective (200 level or higher)', 'ECO elective') : row.querySelector('.comparison-fixed-course > strong')?.textContent.trim();
      }));
      expect(displayed.map(value => value?.replace(/-[A-Z]$/, "")).sort()).toEqual(term.courses.map(course=>course.course).sort());
    }
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
    expect(html).toContain('This plan covers');
    expect(html).not.toContain('Balanced planning horizon');
    const renderer = await browser.newPage();
    await renderer.setContent(html, {waitUntil:'load'});
    const bytes = await renderer.pdf({format:'Letter', printBackground:true,
      margin:{top:'0.42in',right:'0.42in',bottom:'0.42in',left:'0.42in'}});
    await renderer.close();
    const text = execFileSync(process.env.PDFTOTEXT || 'pdftotext', ['-','-'], {input:bytes}).toString().replace(/\s+/g,' ');
    expect(text).toContain(expectedTarget);
    expect(text).toMatch(/Your Economics major checklist/i);
    expect(text).toContain('Future schedules can change. Check the published schedule before you register.');
    expect(text).toContain(report.planningHorizon);
    expect(text).toContain('ECO 461');
    for (const course of report.terms.flatMap(term=>term.courses)) if (course.offeringInformation) expect(text).toContain(course.offeringInformation.label);
    if (name.startsWith('early')) {
      const standingNote = 'This plan assumes you will have senior standing in your final year.';
      expect(JSON.stringify(report)).toContain(standingNote);
      const standingCondition = report.planConditions.find(item => item.kind === 'standing').message;
      expect(html).toContain(standingCondition);
      expect(text).toContain(standingCondition);
      expect(html).not.toContain(standingNote);
      expect(text).not.toContain(standingNote);
    }
    for (const term of report.terms) for (const course of term.courses) expect(text).toContain(
      course.code === 'ECO elective' ? 'Economics elective (200 level or higher)' : course.code);
    await writeFile(testInfo.outputPath(`${name}.json`), JSON.stringify(report,null,2));
    await writeFile(testInfo.outputPath(`${name}.html`), html);
    await writeFile(testInfo.outputPath(`${name}.txt`), text);
    await route.fulfill({contentType:'application/pdf', body:bytes});
  });
  const planLabel = await page.evaluate(id => JSON.parse(sessionStorage.getItem('econ-planner-generated-session'))
    .report.programs.find(program => program.economicsPlans)?.economicsPlans.find(plan => plan.id === id)?.label, planId);
  const button = page.locator(`article.comparison-plan-card[data-plan-id="${planId}"]`)
    .getByRole('button', {name:`Download PDF Report: ${planLabel}`, exact:true});
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
  // Three PDF renders plus generation, edits and reloads can exceed the
  // default allowance on CI; preserve any larger hosted-verification timeout.
  test.setTimeout(Math.max(testInfo.timeout, 90_000));
  try {
    execFileSync(process.env.PDFTOTEXT || 'pdftotext', ['-v'], {stdio:'pipe'});
  } catch (error) {
    throw new Error('PDF verification requires Poppler pdftotext. Install Poppler or set PDFTOTEXT to its executable path. See docs/testing.md.', {cause:error});
  }
  await intake(page, 'freshman', true);
  await setCourseStatus(page, 'ECO 113', 'Completed');
  const response = await generatePlans(page);
  const payload = await response.json();
  const plans = payload.programs.find(p => p.program.id === 'economics-base').economicsPlans;
  expect(plans.map(p => p.id)).toEqual(['balanced','explore-first','one-year-early']);
  await expect(page.locator('.plan-edit-instructions strong')).toHaveText('Click a course to see where it can move. You can also drag it by the ⠿ handle.');
  await expect(page.locator('.plan-edit-instructions span')).toHaveText("While you drag, green terms are open, amber terms need approval or a check first, and gray terms show why the course can't go there.");
  await expect(page.locator('.projection-readiness-note')).toHaveCount(0);
  await expect(page.locator('.comparison-grid')).toBeVisible();
  const conditionsFollowPlans = await page.locator('.comparison-grid').evaluate(grid => {
    const conditions = document.querySelector('[data-plan-conditions]');
    return Boolean(conditions && (grid.compareDocumentPosition(conditions) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(conditionsFollowPlans).toBe(true);
  const earlyPlanCard = page.locator('article[data-plan-id="one-year-early"]');
  await expect(earlyPlanCard.locator('.early-plan-status')).toHaveText('Possible');
  await expect(earlyPlanCard).toContainText('Standard plan');
  await expect(earlyPlanCard).toContainText('May 2030');
  await expect(earlyPlanCard).toContainText('This plan');
  await expect(earlyPlanCard).toContainText('May 2029');
  await expect(earlyPlanCard.locator('.plan-feasibility-value')).toHaveText('Status: Needs confirmation');
  await expect(page.locator('.accelerated-result')).toHaveCount(0);
  await visitPlan(page, 'one-year-early');
  const target = earlyPlanCard.locator('.early-plan-graduation-dates');
  await expect(target).toContainText('May 2029');
  await reloadPlanner(page);
  await expect(target).toContainText('May 2029');
  await exportLocalPdf(page,browser,testInfo,'early','Spring/May 2029',{failFirst:true,planId:'one-year-early'});
  const valid = await move(page,'MAT 217','winter-2027');
  const statistics = valid.plan.terms.find(t => t.slotId === 'winter-2027').courses.find(c => c.course === 'MAT 217');
  expect(['J','K','L','M']).toContain(statistics.section);
  expect(statistics.source).toBe('verified-offering');
  const beforeRejection = await page.evaluate(()=>JSON.parse(sessionStorage.getItem('econ-planner-generated-session')).report);
  const invalid = await move(page,'MAT 217','winter-2029',422);
  expect(invalid.error).toMatch(/prerequisite|statistics/i);
  expect(invalid.error).not.toMatch(/Fall 2028|projected standing/);
  await expect(selectedPlanCard(page).locator('.plan-course-actions[aria-label^="Changes for MAT 217"]')).toHaveAttribute('data-current-term','move:winter-2027');
  const unsupported = await move(page,'ECO elective','fall-2028',422);
  expect(unsupported.error).toMatch(/elective|term limit/i);
  const earlyCard = selectedPlanCard(page);
  await earlyCard.locator('.comparison-editable-course:has(button[aria-label^="Change MAT 217"]) .course-drag-handle').dragTo(earlyCard.locator('.compact-schedule [data-term-id="winter-2029"]'));
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('econ-planner-generated-session')).report)).toEqual(beforeRejection);
  const electiveControl = earlyCard.locator('.plan-course-actions[aria-label="Changes for Economics elective (200 level or higher)"]').first();
  await expect(electiveControl).toHaveAttribute('data-current-term','move:fall-2027');
  await expect(page.locator('.pdf-download-status')).toHaveCount(0);
  await exportLocalPdf(page,browser,testInfo,'early-edited','Spring/May 2029',{planId:'one-year-early'});
  const balancedCard = await visitPlan(page, 'balanced');
  await expect(balancedCard).toContainText('May 2030');
  await expect(page.locator('.pdf-download-status')).toHaveCount(0);
  const balanced = await exportLocalPdf(page,browser,testInfo,'balanced','Spring/May 2030',{planId:'balanced'});
  expect(balanced.inputSummary).toContain('Planning pace: standard');
  expect(balanced.inputSummary).not.toContain('one year early');
  const restoredEarlyCard = await visitPlan(page, 'one-year-early');
  await restoredEarlyCard.getByRole('button',{name:'Undo last plan edit',exact:true}).click();
  await reloadPlanner(page);
  await expect(selectedPlanCard(page).locator('.plan-course-actions[aria-label^="Changes for MAT 217"]')).toHaveAttribute('data-current-term','move:spring-2027');
  await exportLocalPdf(page,browser,testInfo,'early-undone','Spring/May 2029',{planId:'one-year-early'});
  await page.screenshot({path:testInfo.outputPath('balanced-review.png'),fullPage:true,animations:'disabled'});
});

test('required controls explain restrictions while mobile elective editing and keyboard flows remain usable', async ({page},testInfo) => {
  await page.setViewportSize({width:390,height:844});
  await intake(page,'freshman');
  const generateButton = page.getByRole('button',{name:'Generate my plans',exact:true});
  await expect(generateButton).toBeEnabled();
  await generateButton.focus();
  await expect(generateButton).toBeFocused();
  const response = page.waitForResponse(r=>r.url().endsWith('/api/majors/map')&&r.status()===200);
  await page.keyboard.press('Enter');
  await response;
  await expect(page.locator(".comparison-page")).toBeVisible();
  await visitPlan(page, "balanced");
  await expect(page.getByRole('button',{name:'Remove ECO 113',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Remove BUSN 323',exact:true})).toHaveCount(0);
  const planCard = selectedPlanCard(page);
  await expect(planCard.getByRole('button',{name:'Change ECO 113-J',exact:true})).toBeVisible();
  const edited = page.waitForResponse(r=>r.url().endsWith('/api/majors/map')&&r.request().postDataJSON()?.action==='validate-plan');
  await planCard.getByRole('button',{name:'Change Economics elective (200 level or higher)',exact:true}).first().click();
  const menu = planCard.getByRole('region',{name:'Change Economics elective (200 level or higher) options',exact:true}).first();
  const option = menu.locator('[data-change-choice="move:fall-2029"]');
  const conditional = await option.getAttribute('data-change-status') === 'CONDITIONAL';
  await option.click();
  if (conditional) await menu.getByRole('button',{name:'Apply change',exact:true}).click();
  expect((await edited).status()).toBe(200);
  await expect(planCard.locator('.comparison-edit-status')).toContainText('Moved to');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.locator('main').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('mobile-edited.png'),fullPage:true,animations:'disabled'});
});

test('course cards explain when no move preserves prerequisite validity', async ({page}) => {
  await intake(page, 'freshman', true);
  await generatePlans(page);
  const planCard = await visitPlan(page, "one-year-early");
  const coreCard = planCard.locator('.comparison-editable-course:has(button[aria-label="Change ECO 113-J"])').first();
  await coreCard.getByRole('button',{name:'Change ECO 113-J',exact:true}).click();
  await expect(coreCard).toContainText('Not confirmed for May.');
  await expect(coreCard).toContainText('ECO 213 needs ECO 113 first. Move ECO 213 later, then try again.');
  const moves = coreCard.getByRole('combobox');
  await expect(moves).toHaveCount(0);
  await expect(coreCard.getByText(/Why can’t I choose other terms/)).toHaveCount(0);
});

test('senior statistics blocker is causal and saved answers survive revisiting', async ({page},testInfo) => {
  await intake(page,'senior');
  await page.getByText('Other Economics courses',{exact:true}).click();
  for(const code of ['ECO 113','ECO 114','MAT 113','MAT 217','ECO 213','ECO 214','BUSN 323','ECO 161','ECO 221','ECO 222','ECO 234']) await setCourseStatus(page,code,'Completed');
  const ready = await (await generatePlans(page)).json();
  expect(ready.programs.find(p=>p.program.id==='economics-base').economicsPlans.length).toBeGreaterThan(0);
  await page.getByRole('navigation',{name:'Planner progress'}).getByRole('button',{name:'Your courses',exact:true}).click();
  await setCourseStatus(page,'MAT 217','Completed');
  await generatePlans(page);
  await expect(page.locator('.result-status-value')).toHaveText('Not possible');
  await page.locator('details.result-diagnostics > summary').click();
  await expect(page.locator('details.result-diagnostics')).toContainText('Winter 2027');
  await expect(page.locator('details.result-diagnostics')).toContainText('Statistics (ECO 257 or MAT 217 or PSY 217) must be done first.');
  await expect(page.locator('details.result-diagnostics li')).toHaveCount(1);
  await page.screenshot({path:testInfo.outputPath('senior-blocker.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('navigation',{name:'Planner progress'}).getByRole('button',{name:'Your courses',exact:true}).click();
  await expect(page.getByRole('group',{name:'Status for MAT 217',exact:true}).getByRole('button',{name:'Completed',exact:true})).toHaveAttribute('aria-pressed','false');
  await expect(page.getByRole('group',{name:'Status for ECO 213',exact:true}).getByRole('button',{name:'Completed',exact:true})).toHaveAttribute('aria-pressed','true');
});

test('junior prerequisite correction preserves choices and explains next-year outcome', async ({page}) => {
  await intake(page,'junior');
  await setCourseStatus(page,'ECO 213','Taking now');
  const generate = page.getByRole('button',{name:'Generate my plans',exact:true});
  await expect(generate).toBeEnabled();
  await setCourseStatus(page,'ECO 113','Completed');
  await setCourseStatus(page,'MAT 113','Completed');
  await expect(generate).toBeEnabled();
  await page.getByRole('button',{name:'Back to about you',exact:true}).click();
  await page.getByRole('button',{name:'I’d like to graduate next year',exact:true}).click();
  await continueToCourses(page);
  const result = await (await generatePlans(page)).json();
  const economics = result.programs.find(p=>p.program.id==='economics-base');
  expect(economics.economicsPlans[0].planningContext.expectedGraduationTerm).toBe('Spring/May 2028');
  expect(economics.economicsPlans.some(p=>p.isEarlyGraduation)).toBe(false);
  await expect(page.getByRole('heading',{name:'Your plan',exact:true})).toBeFocused();
  await expect(page.getByRole('heading',{name:'Graduate next year: Not possible',exact:true})).toBeVisible();
  await expect(page.getByText('You cannot finish by May 2027. The plan below is for May 2028.', {exact:true})).toHaveCount(1);
});

for (const standing of ['junior', 'senior']) test(`${standing} May 2027 explanation uses confirmed finance and Spring load evidence`, async ({page}) => {
  await intake(page, standing);
  if (standing === 'junior') {
    await page.getByRole('button',{name:'Back to about you',exact:true}).click();
    await page.getByRole('button',{name:'I’d like to graduate next year',exact:true}).click();
    await continueToCourses(page);
  }
  await page.getByText('Other Economics courses',{exact:true}).click();
  for (const code of ['ECO 113','ECO 114','ECO 161','ECO 213','ECO 214','ECO 221','MAT 113','MAT 217']) await setCourseStatus(page,code,'Completed');
  const response = await (await generatePlans(page)).json();
  const economics = response.programs.find(program => program.program.id === 'economics-base');
  const result = standing === 'junior' ? economics.economicsAcceleratedResult : economics.economicsPlanResult;
  expect(standing === 'junior' ? result.status : result.conclusion).toBe(standing === 'junior' ? 'NOT_POSSIBLE' : 'PROVEN_INFEASIBLE');
  if (standing === 'senior') {
    await expect(page.locator('.result-status-value')).toHaveText('Not possible');
    await page.locator('details.result-diagnostics > summary').click();
  } else {
    await expect(page.getByRole('heading',{name:'Graduate next year: Not possible',exact:true})).toBeVisible();
    expect(result.effectiveStanding).toBe('junior');
  }
  await expect(page.getByText(result.evidence.blockingReasons[0].message,{exact:true}).first()).toBeVisible();
  expect(result.evidence.blockingReasons[0].message).toContain('ECO 321 counts for Finance');
  expect(result.evidence.blockingReasons[0].message).toContain('ECO 222, ECO 224, ECO 234');
  expect(result.evidence.blockingReasons[0].message).toContain('You can take only one');
});

for (const storage of ['localStorage', 'sessionStorage']) {
  test(`${storage} failed saves preserve live work and warn until a successful save`, async ({ page }) => {
    await resetPlanner(page);
    await page.evaluate(storage => {
      const original = Storage.prototype.setItem;
      window.failPlannerSave = true;
      Storage.prototype.setItem = function (key, value) {
        if (window.failPlannerSave && this === window[storage]) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    }, storage);
    await chooseStanding(page, 'freshman');
    await continueToCourses(page);
    await setCourseStatus(page, 'ECO 113', 'Completed');
    if (storage === 'sessionStorage') await generatePlans(page);
    const warning = page.getByRole('alert').filter({ hasText: 'unsaved' });
    await expect(warning).toContainText('may be lost if you reload');
    if (storage === 'localStorage') {
      await setCourseStatus(page, 'ECO 114', 'Completed');
      await expect(warning).toBeVisible();
      await page.evaluate(() => { window.failPlannerSave = false; });
      await setCourseStatus(page, 'ECO 214', 'Completed');
    } else {
      await expect(page.locator('.comparison-page')).toBeVisible();
      await page.evaluate(() => { window.failPlannerSave = false; });
      await page.getByRole('button', { name: 'Your courses', exact: true }).click();
    }
    await expect(warning).toHaveCount(0);
    if (storage === 'sessionStorage') {
      expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('econ-planner-generated-session')).report.programs.some(p => p.economicsPlans?.length))).toBe(true);
    }
    await page.reload();
    if (storage === 'sessionStorage') {
      await expect(page.locator('.comparison-page')).toBeVisible();
      await page.getByRole('button', { name: 'Your courses', exact: true }).click();
    }
    await expect(page.getByRole('group', { name: 'Status for ECO 113', exact: true }).getByRole('button', { name: 'Completed', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('alert').filter({ hasText: 'unsaved' })).toHaveCount(0);
  });
}

test('malformed course containers return actionable client errors through the real API', async ({ request }) => {
  const student = { academicStanding: 'freshman', planCreationDate: '2026-09-23' };
  for (const courses of [[null], {}, 'ECO 113']) {
    const response = await request.post('/api/majors/map', { data: { student: { ...student, courses } } });
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_COURSE_INPUT', error: expect.stringContaining('Courses must be a list') });
  }
  const response = await request.post('/api/majors/map', { data: { student: { ...student, courses: [{ code: 'ECO 113', status: 'completed' }] } } });
  expect(response.status()).toBe(200);
});

test('results navigation reflows and remains keyboard accessible at all required widths', async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, 'freshman');
  await continueToCourses(page);
  await generatePlans(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const navigation = page.getByRole('navigation', { name: 'Planner progress' });
    for (const button of await navigation.getByRole('button').all()) {
      await button.focus();
      await expect(button).toBeFocused();
      await expect(button).toBeInViewport();
    }
  }
});


test('one missing ECO 213 prerequisite prevents the otherwise finishable senior horizon', async ({request, page}) => {
  const common = ['ECO 113','ECO 114','ECO 214','MAT 113','MAT 217','BUSN 323','ECO 161','ECO 234','ECO 222','ECO 224'];
  const student = {academicStanding:'senior',planCreationDate:'2026-09-23',courses:[...common,'ECO 213'].map(code=>({code,status:'completed'}))};
  const readyResponse = await request.post('/api/majors/map',{data:{student}});
  expect(readyResponse.status()).toBe(200);
  const ready = (await readyResponse.json()).programs.find(p=>p.economicsPlans);
  expect(ready.economicsPlanResult.category).toBe('PLANS_READY');
  expect(ready.economicsPlans).toHaveLength(1);
  const plan = ready.economicsPlans[0];
  expect(plan.terms.flatMap(t=>t.courses.map(c=>c.course))).toEqual(['ECO 461']);
  const policy = await loadCanonicalPolicy();
  expect(oracleEvaluateCanonicalPlan(policy,student,plan).valid).toBe(true);
  const missing = {...student,courses:student.courses.filter(c=>c.code!=='ECO 213')};
  const blockedResponse = await request.post('/api/majors/map',{data:{student:missing}});
  expect(blockedResponse.status()).toBe(200);
  const blocked = (await blockedResponse.json()).programs.find(p=>p.economicsPlans);
  expect(blocked.economicsPlans).toEqual([]);
  expect(oracleEvaluateCanonicalPlan(policy,missing,plan).valid).toBe(false);
  for(const term of plan.terms) {
    expect(oracleEvaluateOffering(policy,{course:'ECO 213'},term).status).toBe('BLOCK');
  }
  // The published Winter schedule and May exclusions establish this target cannot fit.
  expect(blocked.economicsPlanResult.category).toBe('INFEASIBLE_PROVEN');
  await intake(page, 'senior');
  for (const code of common) {
    await page.getByRole('searchbox', {name:'Search courses',exact:true}).fill(code);
    await setCourseStatus(page, code, 'Completed');
  }
  await page.getByRole('searchbox', {name:'Search courses',exact:true}).fill('');
  const response = await generatePlans(page);
  const result = (await response.json()).programs.find(p=>p.economicsPlans);
  expect(result.economicsPlans).toEqual([]);
  expect(result.economicsPlanResult.reason).toBe(blocked.economicsPlanResult.reason);
  await expect(page.locator('.no-plan-state h2')).not.toContainText('overload');
  await expect(page.locator('.no-plan-state')).not.toContainText('Record existing advisor approval');
  await expect(page.locator('.no-plan-state > p').first()).not.toBeEmpty();
  await expect(page.getByRole('button', {name:/Download PDF Report/})).toHaveCount(0);
});


test('screen and PDF readiness statuses match and the course menu fits the viewport', async ({page, browser}, testInfo) => {
  test.setTimeout(60000);
  await intake(page, 'freshman');
  const response = await generatePlans(page);
  const result = (await response.json()).programs.find(p=>p.economicsPlans);
  const plan = result.economicsPlans.find(plan=>plan.id === 'balanced');
  expect(plan.readinessStatus).toBe('STUDENT_READY');
  expect(plan.feasibilityStatus).toBe('CONDITIONALLY_FEASIBLE');
  await visitPlan(page, plan.id);
  await expect(page.locator('.result-status-value')).toHaveText('Ready to plan');
  await expect(page.locator('.comparison-course-status')).toContainText('Status');
  await expect(page.locator(`article[data-plan-id="${plan.id}"] .plan-feasibility-value`)).toHaveText('Status: Ready to plan');
  await expect(page.locator('.result-status-reason').first()).toContainText('The plan meets the major rules.');
  const report = await page.request.post('/api/reports/economics', {data:{
    student:response.request().postDataJSON().student, selectedPlan:plan,
    plans:result.economicsPlans, format:'html'
  }});
  expect(report.status()).toBe(200);
  const reportPage = await browser.newPage();
  await reportPage.setContent(await report.text());
  await expect(reportPage.locator('.plan-details h2')).toHaveText(await page.locator(`article[data-plan-id="${plan.id}"] .plan-feasibility-value`).textContent());
  await reportPage.close();
  for (const width of [1440, 1280, 820, 390]) {
      await page.setViewportSize({width,height:900});
      const trigger = page.getByRole('button', {name:/^Change /}).first();
      await trigger.click();
      const menu = page.locator('.course-change-panel:not([hidden])');
      const box = await menu.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(280);
      expect(box.x).toBeGreaterThanOrEqual(12);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 12);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(900);
      const close = menu.getByRole('button', {name:'Close course options'});
      await expect(close).toBeInViewport();
      expect(await close.evaluate(button => {
        const r = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })).toBe(true);
      if (width === 1440) await testInfo.attach('comparison-menu', {body:await page.screenshot({path:testInfo.outputPath('comparison-menu.png')}),contentType:'image/png'});
      await close.click();
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
  }
});
