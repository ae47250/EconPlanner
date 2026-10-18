import { visitPlan } from "./cp7-helpers.js";
import { expect, test } from './nightly-observability.js';
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import { resetPlanner, reloadPlanner, chooseStanding, continueToCourses, generatePlans, setCourseStatus } from './cp7-helpers.js';

const normalize = value => value.replace(/\s+/g, ' ').trim();
const studentNoteTitles = { 'ccr-ace':'Other graduation requirements', history:'When these classes ran before',
  upcoming:'Upcoming courses', future:'Courses in future years' };
const expectedNoteText = note => normalize([studentNoteTitles[note.id] || note.title, note.description,
  ...note.items.map(item => [item.code, item.label ? item.label + ':' : '', ...(item.lines || [item.text])].filter(Boolean).join(' ')), note.caveat].filter(Boolean).join(' '));

for (const [device, viewport] of [['desktop', {width:1440,height:900}], ['mobile', {width:390,height:844}]]) {
  test(`${device}: actual generation, selected-plan notes, brief feedback, keyboard focus, undo and reload`, async ({ page }, testInfo) => {
    test.setTimeout(Math.max(testInfo.timeout, 90000));
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      window.__liveMessages = [];
      const capture = () => document.querySelectorAll('[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]').forEach(element => {
        const text = element.innerText?.trim();
        if (text && !window.__liveMessages.includes(text)) window.__liveMessages.push(text);
      });
      new MutationObserver(capture).observe(document, {subtree:true,childList:true,characterData:true});
    });
    const liveObservations = [];
    const recordLiveMessages = async phase => {
      liveObservations.push({phase, messages:await page.evaluate(() => window.__liveMessages.splice(0))});
    };
    await resetPlanner(page);
    await chooseStanding(page, 'sophomore');
    await page.locator('details.more-details > summary').first().click();
    await page.getByLabel('Plan creation date', {exact:true}).fill('2026-09-28');
    await page.getByRole('button', {name:'I’d like to graduate one year early',exact:true}).click();
    await continueToCourses(page);
    const response = await generatePlans(page);
    const payload = await response.json();
    let student = response.request().postDataJSON().student;
    let plans = payload.programs.find(item => item.program.id === 'economics-base').economicsPlans;
    expect(plans.length).toBe(3);
    await expect(page.getByRole('heading', {name:'Compare your course plans',exact:true})).toBeVisible();
    await expect(page.locator('.projection-readiness-note')).toHaveCount(0);
    await expect(page.locator('.comparison-grid')).toBeVisible();
    const plansBeforeConditions = await page.locator('.comparison-grid').evaluate(grid => {
      const conditions = document.querySelector('[data-plan-conditions]');
      return Boolean(conditions && (grid.compareDocumentPosition(conditions) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(plansBeforeConditions).toBe(true);
    if (device === 'desktop') {
      await page.setViewportSize({width:832,height:900});
      const viewportWidth = await page.locator('html').evaluate(element => ({scroll:element.scrollWidth, client:element.clientWidth}));
      expect(viewportWidth.scroll).toBeLessThanOrEqual(viewportWidth.client);
      await expect(page.locator('.difference-toggle')).toBeVisible();
      await page.setViewportSize(viewport);
    }
    await recordLiveMessages('sophomore: generation');
    for (const plan of plans) {
      await visitPlan(page, plan.id);
      await expect(page.locator('[data-plan-notes] [data-plan-note]')).toHaveCount(plan.planNotes.length);
      if (await page.locator('[data-major-requirements-checklist] > details').getAttribute('open') === null) await page.locator('[data-major-requirements-checklist] > details > summary').click();
      const evidenceSummary = page.getByText('More about this plan', {exact:true});
      if (await evidenceSummary.locator('..').getAttribute('open') === null) await evidenceSummary.click();
      const checklist = page.locator('[data-major-requirements-checklist]');
      await expect(checklist.getByRole('columnheader')).toHaveText(['Requirement','Course / term','Status']);
      await expect(checklist.locator('tbody tr')).toHaveCount(12);
      for (const row of plan.majorRequirementsChecklist.rows) {
        const rendered = checklist.locator(`[data-requirement-checklist-id="${row.id}"]`);
        await expect(rendered.getByRole('rowheader')).toHaveText(row.label);
        await expect(rendered).toContainText(row.courseTerm.replaceAll("Spring/May", "May"));
        await expect(rendered.locator('.checklist-status')).toContainText(row.statusLabel);
        for (const marker of row.markers) await expect(rendered).toContainText(marker);
      }
      await expect(page.locator('.term-card .plan-course-availability').first()).toHaveText('Seat availability not confirmed');
      await expect(page.locator('[data-plan-conditions]')).toHaveCount(1);
      await expect(page.locator('main')).not.toContainText('This plan assumes you will have senior standing in your final year.');
      if (plan.id === 'one-year-early') {
        await expect(page.locator('[data-plan-conditions]')).toContainText('ECO 213 with ECO 461 in Winter 2028');
        await expect(page.locator('[data-plan-conditions]')).toContainText('Senior standing is assumed for 2027–2028');
        await expect(page.locator('main')).not.toContainText('This plan assumes you will have senior standing in your final year.');
      }
      for (const note of plan.planNotes) {
        expect(normalize(await page.locator(`[data-plan-note="${note.id}"]`).innerText())).toBe(expectedNoteText(note));
      }
      expect(await page.locator('[data-plan-note]').evaluateAll(nodes => nodes.map(node => node.dataset.planNote)))
        .toEqual(plan.planNotes.map(note => note.id));
      await expect(page.locator('[data-plan-note] summary')).toHaveCount(0);
      await expect(page.locator('[data-plan-note="upcoming"] h3')).toHaveText('Upcoming courses');
      const sectionLabels = await page.locator('[data-plan-note="upcoming"] strong').allTextContents();
      expect(sectionLabels).toContain('J:');
      expect(sectionLabels).toContain('K:');
      expect(sectionLabels).not.toContain('S:');
      const firstUpcomingCourse = page.locator('[data-plan-note="upcoming"] .upcoming-course-entry').first();
      await expect(firstUpcomingCourse.locator('.upcoming-course-heading')).toContainText('ECO 113');
      await expect(firstUpcomingCourse.locator('.upcoming-course-heading')).toContainText('Principles of Microeconomics');
      await expect(firstUpcomingCourse.locator('.upcoming-course-title')).toHaveCSS('text-decoration-line', 'underline');
      await expect(firstUpcomingCourse.locator('.upcoming-course-times')).toContainText('Tue, Thu');
      await expect(page.locator('main')).not.toContainText('Course-level planning options');
      await expect(page.locator('main')).not.toContainText('potential Economics');
      await expect(page.locator('main')).not.toContainText('current seat availability is');
      await expect(page.locator('.section-heading .accelerated-math-sequence-note')).toHaveCount(0);
      for (const warning of plan.displayWarnings.filter(message =>
        /^(Complete planned prerequisites|Confirm seat availability)/.test(message))) {
        await expect(page.getByText(warning, {exact:true})).toHaveCount(0);
      }
      for (const condition of plan.planConditions.filter(item => ["prerequisite", "seat"].includes(item.kind))) {
        await expect(page.locator('[data-plan-conditions]').getByText(condition.message, {exact:true})).toHaveCount(1);
      }
      await expect(page.locator('.term-card .plan-course-summary')).toContainText(Array.from({length:1}, () => 'ECO elective (200+)'));
      expect(await page.locator('[data-plan-notes]').evaluate(node => Boolean(node.closest('[aria-live], [role="status"]')))).toBe(false);
      const json = await page.request.post('/api/reports/economics', {data:{student,selectedPlan:plan,plans,preparedDate:'2026-09-28',format:'json'}});
      expect(json.status()).toBe(200);
      expect((await json.json()).planNotes).toEqual(plan.planNotes);
      await recordLiveMessages(`sophomore: select ${plan.label}`);
      await page.getByRole('button', {name:'Compare plans',exact:true}).click();
    }
    await resetPlanner(page);
    await chooseStanding(page, 'freshman');
    await page.locator('details.more-details > summary').first().click();
    await page.getByLabel('Plan creation date', {exact:true}).fill('2026-09-28');
    await page.getByRole('button', {name:'I’d like to graduate one year early',exact:true}).click();
    await continueToCourses(page);
    const moveProfile = await generatePlans(page);
    student = moveProfile.request().postDataJSON().student;
    plans = (await moveProfile.json()).programs.find(item => item.program.id === 'economics-base').economicsPlans;
      await expect(page.getByRole('heading', {name:'Compare your course plans',exact:true})).toBeVisible();
    await recordLiveMessages('freshman: generation');
    await visitPlan(page, "one-year-early");
    const control = page.locator('.plan-course-actions[aria-label="Changes for MAT 217"]');
    await expect(page.locator('.accelerated-math-sequence-note').first()).toBeHidden();
    await page.getByText('More planning details', {exact:true}).click();
    await expect(page.locator('.accelerated-math-sequence-note').first()).toBeVisible();
    await page.getByText('More planning details', {exact:true}).click();
    await recordLiveMessages('freshman: select One Year Early');
    const selected = plans.find(plan => plan.id === 'one-year-early');
    const from = selected.terms.find(term => term.courses.some(course => course.course === 'MAT 217'));
    const rejected = await page.request.post('/api/majors/map', {data:{action:'validate-plan',student,plan:selected,plans,
      edit:{type:'move',fromTermId:from.slotId,toTermId:'winter-2029',courseId:'statistics'}}});
    expect(rejected.status()).toBe(422);
    await page.getByRole('button',{name:'Change MAT 217',exact:true}).click();

    const validated = page.waitForResponse(r => r.url().endsWith('/api/majors/map') && r.request().postDataJSON()?.action === 'validate-plan');
    const menu = control.getByRole('region', {name:'Change MAT 217 options',exact:true});
    if (!await menu.isVisible()) await page.getByRole('button',{name:'Change MAT 217',exact:true}).click();
    const option = menu.locator('[data-change-choice="move:winter-2027"]');
    const conditional = await option.getAttribute('data-change-status') === 'CONDITIONAL';
    await option.focus();
    await page.keyboard.press('Enter');
    if (conditional) await menu.getByRole('button',{name:'Apply change',exact:true}).click();
    expect((await validated).status()).toBe(200);
    await expect(page.getByRole('button',{name:'Change MAT 217',exact:true})).toBeFocused();
    await expect(page.locator('.plan-course-edit-feedback')).toContainText('Moved to');
    await expect(page.locator('.plan-course-edit-feedback')).toHaveText('Moved to Winter 2027. Plan checks pass.');
    await expect(page.locator('[data-requirement-checklist-id="statistics"]')).toContainText('MAT 217 — Winter 2027');
    await recordLiveMessages('MAT 217: move to Winter 2027');
    expect(await control.locator('[data-change-choice]').evaluateAll(options => Math.max(...options.map(option => option.innerText.length)))).toBeLessThan(120);
    await page.getByRole('button', {name:'Undo last plan edit'}).click();
    await expect(control).toHaveAttribute('data-current-term',`move:${from.slotId}`);
    await expect(page.locator('[data-requirement-checklist-id="statistics"]')).toContainText(`MAT 217 — ${from.term.replaceAll("Spring/May", "May")}`);
    await expect(page.locator('.plan-course-edit-feedback')).toHaveText('Change undone.');
    await recordLiveMessages('MAT 217: undo');
    const again = page.waitForResponse(r => r.url().endsWith('/api/majors/map') && r.request().postDataJSON()?.action === 'validate-plan');
    await page.getByRole('button',{name:'Change MAT 217',exact:true}).click();
    await option.click();
    if (conditional) await menu.getByRole('button',{name:'Apply change',exact:true}).click();
    expect((await again).status()).toBe(200);
    await expect(page.locator('.plan-course-edit-feedback')).toContainText('Moved to');
    await recordLiveMessages('MAT 217: move again');
    await reloadPlanner(page);
    await expect(control).toHaveAttribute('data-current-term','move:winter-2027');
    await expect(page.locator('[data-requirement-checklist-id="statistics"]')).toContainText('MAT 217 — Winter 2027');
    // Saved display fields cannot manufacture credit; the API rebuilds them on reload.
    await page.evaluate(() => {
      const key='econ-planner-generated-session'; const state=JSON.parse(sessionStorage.getItem(key));
      for (const program of state.report.programs) for (const plan of program.economicsPlans || []) {
        plan.planConditions=[];
        for (const row of plan.majorRequirementsChecklist.rows) { row.status='completed';row.statusLabel='Completed';row.symbol='✓';row.markers=[]; }
      }
      sessionStorage.setItem(key,JSON.stringify(state));
    });
    await reloadPlanner(page);
    await expect(control).toHaveAttribute('data-current-term','move:winter-2027');
    await expect(page.locator('[data-major-requirements-checklist] tbody .checklist-status.is-completed')).toHaveCount(0);
    await expect(page.locator('[data-plan-conditions]')).toContainText('Senior standing is assumed');
    await recordLiveMessages('MAT 217: reload');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
    const axe = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
    expect(axe.violations).toEqual([]);
    await page.locator('[data-plan-notes]').scrollIntoViewIfNeeded();
    await page.screenshot({path:testInfo.outputPath(`${device}-plan-notes.png`),fullPage:true,animations:'disabled'});
    await writeFile(testInfo.outputPath(`${device}-dom-live-messages.json`), JSON.stringify({
      kind:'DOM live-region observations; NOT a screen-reader speech test',
      observations:liveObservations
    }, null, 2));
    for (const observation of liveObservations) for (const message of observation.messages) {
      expect(message.length).toBeLessThan(220);
      expect(message).not.toMatch(/Major requirements checklist|Past Economics schedules|Upcoming Economics courses/);
    }
    // Saved academic edits also receive full validation before any plan is displayed.
    await page.evaluate(() => {
      const key='econ-planner-generated-session'; const state=JSON.parse(sessionStorage.getItem(key));
      const plan=state.report.programs.find(program=>program.economicsPlans)?.economicsPlans[0];
      const terms=plan.terms.filter(term=>term.publicationStatus==='PLANNING_PROJECTION' && term.courses.some(course=>course.requirementId?.startsWith('eco-elective')));
      const source=terms[0];const destination=terms[1];const index=source.courses.findIndex(course=>course.requirementId.startsWith('eco-elective'));
      destination.courses.push(source.courses.splice(index,1)[0]);
      sessionStorage.setItem(key,JSON.stringify(state));
    });
    await reloadPlanner(page);
    await expect(page.getByRole('heading',{name:'Which courses have you finished or are taking now?'})).toBeVisible();
    await expect(page.locator('[data-major-requirements-checklist]')).toHaveCount(0);
    await expect(page.locator('.summary-status')).toContainText('Your saved answers are kept');
  });
}

test('actual completed and current checklist credit stays distinct from future assignments in all three plans and after reload', async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page,'freshman');
  await page.getByRole('button',{name:'I’d like to graduate one year early',exact:true}).click();
  await continueToCourses(page);
  await setCourseStatus(page,'ECO 113','Completed');
  await setCourseStatus(page,'ECO 114','Taking now');
  await setCourseStatus(page,'MAT 113','Completed');
  await page.getByText('Other Economics courses',{exact:true}).click();
  await setCourseStatus(page,'ECO 161','Completed');
  const response=await generatePlans(page);
  const plans=(await response.json()).programs.find(program=>program.economicsPlans).economicsPlans;
  expect(plans).toHaveLength(3);
  for(const plan of plans) {
    await visitPlan(page, plan.id);
    const checklist=page.locator('[data-major-requirements-checklist]');
    await expect(checklist.locator('[data-requirement-checklist-id="eco-113"] .checklist-status')).toHaveText('✓ Completed');
    await expect(checklist.locator('[data-requirement-checklist-id="eco-114"] .checklist-status')).toHaveText('◐ In progress');
    await expect(checklist.locator('[data-requirement-checklist-id="cognate"] .checklist-status')).toHaveText('✓ Completed');
    await expect(checklist.locator('tr').filter({hasText:'ECO 161'})).toHaveCount(1);
    await expect(checklist.locator('tbody .is-completed')).toHaveCount(3);
    await expect(checklist.locator('tbody .is-in_progress')).toHaveCount(1);
    await expect(checklist.locator('tbody .is-planned')).toHaveCount(8);
    await expect(page.locator('[data-plan-note="history"]')).not.toContainText('ECO 161');
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await reloadPlanner(page);
    await expect(checklist.locator('tbody .is-completed')).toHaveCount(3);
    await expect(checklist.locator('tbody .is-in_progress')).toHaveCount(1);
    await page.setViewportSize({width:1440,height:900});
    await page.getByRole('button',{name:'Compare plans',exact:true}).click();
  }
});
