import { visitPlan } from "./cp7-helpers.js";
import { test, expect } from "@playwright/test";
import {resetPlanner,chooseStanding,continueToCourses,setCourseStatus,courseStatusGroup,generatePlans,fixturePlan,openFixtureResult,plannerResultFixture} from './cp7-helpers.js';
import {evaluateTermLoad} from '../../lib/decision-engine/placement.js';
import {runtimePolicyBundle} from '../../lib/policy/compat-normalized.js';
import {termLoadMessage} from '../../lib/policy/term-load.js';
import {studentDisplayMessages} from '../../lib/planning/student-language.js';

const history = ['ECO 113','ECO 114','ECO 213','MAT 113','MAT 217','ECO 161','ECO 234'];
async function selectHistory(page,codes) {
  for (const code of codes) {
    const group = courseStatusGroup(page,code);
    if (!await group.isVisible()) await page.getByRole('searchbox',{name:'Search courses',exact:true}).fill(code);
    await setCourseStatus(page,code,'Completed');
    await page.getByRole('searchbox',{name:'Search courses',exact:true}).fill('');
  }
}

test('a pending-overload move card is visibly disabled and requests evidence',async ({page}) => {
  const bundle = runtimePolicyBundle();
  const loadDecision = evaluateTermLoad({termKey:'Winter',courses:[{course:'MAT 217',units:5}]},{},bundle);
  expect(loadDecision.status).toBe('UNKNOWN');
  const plan = fixturePlan();
  plan.terms[0].courses[0].moveDestinationIds = ['2026-FALL'];
  plan.terms[0].courses[0].moveDestinationOptions = [
    {id:'2026-FALL',label:'Fall 2026',status:'CURRENT',message:'Currently selected term.'},
    {id:'2027-WINTER',label:'Winter 2027',status:'REVIEW_REQUIRED',loadDecision,message:termLoadMessage(loadDecision,bundle)}
  ];
  plan.terms[0].courses[0].moveGuidance = {studentMessage:termLoadMessage(loadDecision,bundle)};
  await openFixtureResult(page,{...plannerResultFixture({plans:[plan]}),policyMessages:studentDisplayMessages(bundle)});
  const planCard = await visitPlan(page, "balanced");
  const control = planCard.locator('.plan-course-actions[aria-label="Changes for ECO 113"]');
  await control.getByRole('button',{name:'Change ECO 113',exact:true}).click();
  const menu = planCard.getByRole('region', {name:'Change ECO 113 options'});
  await expect(menu.locator('[data-change-choice="move:2027-WINTER"]')).toHaveCount(0);
  await expect(menu).toContainText("An advisor needs to check this move, because it depends on an approval or record EconPlanner can’t confirm.");
  await expect(menu.locator('.course-choice-details')).toHaveCount(0);
});
async function clearAll(page) {
  await page.getByRole('button',{name:'Clear all',exact:true}).click();
  await page.getByRole('dialog',{name:'Clear all answers and generated plans?'}).getByRole('button',{name:'Clear all',exact:true}).click();
}

test('fresh and reset sessions submit no selected courses; saved selections survive reload and regeneration', async ({page}, testInfo) => {
  // Five plan generations plus reload/reset exceeded 30 seconds on the CI runner.
  test.setTimeout(Math.max(testInfo.timeout, 60000));
  await resetPlanner(page);
  await chooseStanding(page,'freshman');
  await continueToCourses(page);
  await expect(page.getByRole('group',{name:/^Status for /}).locator('button[aria-pressed="true"]')).toHaveCount(0);
  const first = await generatePlans(page);
  expect(first.request().postDataJSON().student.courses).toEqual([]);
  const regeneration = page.waitForResponse(response => response.url().endsWith('/api/majors/map'));
  await page.getByRole('button',{name:'Regenerate all plans',exact:true}).click();
  expect((await regeneration).request().postDataJSON().student.courses).toEqual([]);
  await page.getByRole('navigation',{name:'Planner progress'}).getByRole('button',{name:'Your courses',exact:true}).click();
  await setCourseStatus(page,'ECO 113','Completed');
  await setCourseStatus(page,'MAT 113','Taking now');
  await page.reload();
  await expect(courseStatusGroup(page,'ECO 113').getByRole('button',{name:'Completed',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(courseStatusGroup(page,'MAT 113').getByRole('button',{name:'Taking now',exact:true})).toHaveAttribute('aria-pressed','true');
  const restored = await generatePlans(page);
  expect(restored.request().postDataJSON().student.courses.map(course=>[course.code,course.status]).sort()).toEqual([['ECO 113','completed'],['MAT 113','in_progress']]);
  const restoredRegeneration = page.waitForResponse(response => response.url().endsWith('/api/majors/map'));
  await page.getByRole('button',{name:'Regenerate all plans',exact:true}).click();
  expect((await restoredRegeneration).request().postDataJSON().student.courses).toEqual(restored.request().postDataJSON().student.courses);
  await clearAll(page);
  await chooseStanding(page,'freshman');
  await continueToCourses(page);
  await expect(page.getByRole('group',{name:/^Status for /}).locator('button[aria-pressed="true"]')).toHaveCount(0);
  const reset = await generatePlans(page);
  expect(reset.request().postDataJSON().student.courses).toEqual([]);
});

for (const dependent of ['ECO 213','ECO 214']) for (const math of ['MAT 113','MAT 121']) test(`${dependent} accepts ${math} Taking now without the other math selection`,async ({page}) => {
  await resetPlanner(page);
  await chooseStanding(page,'freshman');
  await continueToCourses(page);
  await selectHistory(page,['ECO 113','ECO 114',dependent]);
  await setCourseStatus(page,math,'Taking now','Status for prerequisite');
  await expect(page.getByRole('button',{name:'Generate my plans',exact:true})).toBeEnabled();
  const response = await generatePlans(page);
  const courses = response.request().postDataJSON().student.courses;
  expect(courses.find(course=>course.code===math).status).toBe('in_progress');
  expect(courses.some(course=>course.code===(math==='MAT 113'?'MAT 121':'MAT 113'))).toBe(false);
});

for (const scenario of [
  {name:'normal four Winter units',reserved:'0',approval:'NOT_SUPPLIED',probation:'NOT_SUPPLIED',expected:'Needs confirmation'},
  {name:'missing overload evidence',reserved:'1',approval:'NOT_SUPPLIED',probation:'NOT_SUPPLIED',expected:'Needs advisor attention'},
  {name:'approved five Winter units',reserved:'1',approval:'APPROVED',probation:'NOT_ON_ACADEMIC_PROBATION',expected:'Needs confirmation'},
  {name:'denied Winter approval',reserved:'1',approval:'NOT_APPROVED',probation:'NOT_ON_ACADEMIC_PROBATION',expected:'Needs advisor attention'},
  {name:'Winter overload on probation',reserved:'1',approval:'APPROVED',probation:'ON_ACADEMIC_PROBATION',expected:'Needs advisor attention'},
  {name:'six Winter units above ceiling',reserved:'2',approval:'APPROVED',probation:'NOT_ON_ACADEMIC_PROBATION',expected:'Needs advisor attention'},
  {name:'two May units with approval',reserved:'0',spring:'1',approval:'APPROVED',probation:'NOT_ON_ACADEMIC_PROBATION',expected:'Needs advisor attention'}
]) test(`browser controls and results: ${scenario.name}`,async ({page}) => {
  await resetPlanner(page);
  await chooseStanding(page,'senior');
  await page.locator('details.more-details > summary').first().click();
  await page.getByLabel('Plan creation date',{exact:true}).fill('2026-09-28');
  await page.getByText('Adjust your schedule (optional)',{exact:true}).click();
  await page.getByLabel('Course units reserved in Winter 2027',{exact:true}).selectOption(scenario.reserved);
  await page.getByLabel('Advisor overload approval in Winter 2027',{exact:true}).selectOption(scenario.approval);
  await page.getByLabel('Academic probation status in Winter 2027',{exact:true}).selectOption(scenario.probation);
  if (scenario.spring) {
    await page.getByLabel('Course units reserved in Spring/May 2027',{exact:true}).selectOption(scenario.spring);
    await page.getByLabel('Advisor overload approval in Spring/May 2027',{exact:true}).selectOption('APPROVED');
    await page.getByLabel('Academic probation status in Spring/May 2027',{exact:true}).selectOption('NOT_ON_ACADEMIC_PROBATION');
  }
  await continueToCourses(page);
  await selectHistory(page,history);
  const response = await generatePlans(page);
  expect(response.request().postDataJSON().student.termLoadOverrides['winter-2027']).toMatchObject({advisorApproval:scenario.approval,academicProbationStatus:scenario.probation});
  await expect(page.locator('.result-status-value')).toContainText(scenario.expected);
  const result = (await response.json()).programs.find(item=>item.economicsPlans);
  if (scenario.expected === 'Needs confirmation') {
    const plan = result.economicsPlans[0];
    expect(plan.validation.valid).toBe(true);
    const winter = plan.validation.policyDecision.decisions.find(decision=>decision.subject.termId==='2027-WINTER'&&decision.ruleIds.includes('CAPACITY-WINTER'));
    expect(winter.status).toBe(scenario.reserved==='0'?'ALLOW':'CONDITIONAL');
  } else {
    expect(result.economicsPlans).toHaveLength(0);
    expect(result.economicsPlanResult.reason).not.toBe('TERM_OVERLOAD_EVIDENCE_REQUIRED');
  }
});

test('a reserved-room no-plan result links back to the room setting',async ({page}) => {
  await resetPlanner(page);
  await chooseStanding(page,'junior');
  await page.locator('details.more-details > summary').first().click();
  await page.getByLabel('Plan creation date',{exact:true}).fill('2026-09-28');
  await page.getByText('Adjust your schedule (optional)',{exact:true}).click();
  const reservations = page.locator('select[aria-label^="Course units reserved in "]');
  const count = await reservations.count();
  expect(count).toBeGreaterThan(0);
  for (let index=0; index<count; index+=1) {
    const options = await reservations.nth(index).locator('option').count();
    await reservations.nth(index).selectOption({index:options-1});
  }
  await continueToCourses(page);
  await setCourseStatus(page,'ECO 113','Completed');
  await setCourseStatus(page,'ECO 114','Completed');
  const response = await generatePlans(page);
  const result = (await response.json()).programs.find(item=>item.program?.id==='economics-base');
  expect(result.economicsPlans).toHaveLength(0);
  expect(result.economicsPlanResult.reason).toBe('RESERVED_ROOM_BLOCKS_PLAN');
  await expect(page.locator('.no-plan-state h2')).toHaveText('No plan fits with the room saved for other courses.');
  await expect(page.locator('.no-plan-state > p')).toContainText(/You saved room for \d+ other courses across \d+ terms/);
  await page.locator('.result-diagnostics > summary').click();
  const gaps = page.locator('.result-diagnostics .planning-gaps li');
  await expect(gaps).toHaveCount(1);
  await expect(gaps.first()).toContainText('No plan fits all your choices. Change your answers, choose a later graduation year, or talk with your advisor.');
  await expect(page.locator('.result-diagnostics')).not.toContainText('remains unscheduled');
  await expect(page.locator('.result-diagnostics')).not.toContainText('.;');
  await page.getByRole('button',{name:'Save less room',exact:true}).click();
  await expect(page.locator('#other-courses-reserved')).toBeVisible();
});

test('a junior early result gives one course-fit sentence in planning details',async ({page}) => {
  await resetPlanner(page);
  await chooseStanding(page,'junior');
  await page.locator('details.more-details > summary').first().click();
  await page.getByLabel('Plan creation date',{exact:true}).fill('2026-11-22');
  await page.getByRole('button',{name:'I’d like to graduate next year',exact:true}).click();
  await continueToCourses(page);
  await selectHistory(page,['ECO 113','ECO 114']);
  await generatePlans(page);
  await page.locator('.result-diagnostics > summary').click();
  const details = page.locator('.result-diagnostics');
  await expect(details).toContainText('These requirements did not fit by May 2027:');
  await expect(details).not.toContainText('remains unscheduled');
  await expect(details).not.toContainText('.;');
});

test('the verified ECO 321 section appears in a junior plan instead of BUSN 323',async ({page}) => {
  await resetPlanner(page);
  await chooseStanding(page,'junior');
  await page.locator('details.more-details > summary').first().click();
  await page.getByLabel('Plan creation date',{exact:true}).fill('2026-11-22');
  await continueToCourses(page);
  await selectHistory(page,['ECO 113','ECO 114','MAT 121','ECO 213','MAT 217']);
  await setCourseStatus(page,'ECO 214','Taking now');
  const response = await generatePlans(page);
  const plan = (await response.json()).programs.find(item=>item.program?.id==='economics-base')
    .economicsPlans.find(item=>item.id==='balanced');
  expect(plan.terms.find(term=>term.slotId==='winter-2027').courses.some(course=>(
    course.course==='ECO 321' && course.requirementId==='finance'
  ))).toBe(true);
  expect(plan.terms.every(term=>term.courses.every(course=>course.course!=='BUSN 323'))).toBe(true);
  const card = await visitPlan(page,'balanced');
  await expect(card.locator('[data-term-id="winter-2027"]')).toContainText('ECO 321');
  await expect(card.locator('.compact-schedule')).not.toContainText('BUSN 323');
});

test('a Ready to plan status includes the petition paperwork sentence on screen and PDF',async ({page}) => {
  await resetPlanner(page);
  await chooseStanding(page,'senior');
  await page.locator('details.more-details > summary').first().click();
  await page.getByLabel('Plan creation date',{exact:true}).fill('2027-05-01');
  await page.getByRole('button',{name:'My expected graduation year is different'}).click();
  await page.getByLabel('When do you expect to graduate?').selectOption('2028');
  await continueToCourses(page);
  await selectHistory(page,['ECO 113','ECO 114','MAT 121','ECO 213','ECO 214','MAT 217','ECO 221','ECO 222']);
  const response = await generatePlans(page);
  const mapped = (await response.json()).programs.find(item=>item.program?.id==='economics-base');
  const plan = mapped.economicsPlans.find(item=>item.id==='balanced');
  expect(plan.readinessStatus).toBe('STUDENT_READY');
  await expect(page.locator('.result-status-value')).toHaveText('Ready to plan');
  const status = page.locator('.result-status-reason');
  await expect(status).toHaveCount(1);
  await expect(status).toContainText('See the notes below for paperwork to file.');
  const report = await page.request.post('/api/reports/economics',{data:{
    student:response.request().postDataJSON().student,selectedPlan:plan,plans:mapped.economicsPlans,format:'html'
  }});
  expect(report.status()).toBe(200);
  expect(await report.text()).toContain('See the notes below for paperwork to file.');
});
