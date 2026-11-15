import { visitPlan } from "./cp7-helpers.js";
import {expect,test} from './nightly-observability.js';
import {resetPlanner,chooseStanding,continueToCourses,setCourseStatus,courseStatusGroup,generatePlans,fixturePlan,openFixtureResult,plannerResultFixture} from './cp7-helpers.js';
import {evaluateTermLoad} from '../../lib/decision-engine/placement.js';
import {runtimePolicyBundle} from '../../lib/policy/compat-normalized.js';
import {termLoadMessage} from '../../lib/policy/term-load.js';

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
  await openFixtureResult(page,plannerResultFixture({plans:[plan]}));
  const planCard = await visitPlan(page, "balanced");
  const control = planCard.locator('.plan-course-actions[aria-label="Changes for ECO 113"]');
  await control.getByRole('button',{name:'Change ECO 113',exact:true}).click();
  const menu = planCard.getByRole('region', {name:'Change ECO 113 options'});
  await expect(menu.locator('[data-change-choice="move:2027-WINTER"]')).toHaveCount(0);
  await expect(menu).toContainText('An advisor needs to check this move.');
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
  {name:'missing overload evidence',reserved:'1',approval:'NOT_SUPPLIED',probation:'NOT_SUPPLIED',expected:'More information needed'},
  {name:'approved five Winter units',reserved:'1',approval:'APPROVED',probation:'NOT_ON_ACADEMIC_PROBATION',expected:'Needs confirmation'},
  {name:'denied Winter approval',reserved:'1',approval:'NOT_APPROVED',probation:'NOT_ON_ACADEMIC_PROBATION',expected:'Not possible'},
  {name:'Winter overload on probation',reserved:'1',approval:'APPROVED',probation:'ON_ACADEMIC_PROBATION',expected:'Not possible'},
  {name:'six Winter units above ceiling',reserved:'2',approval:'APPROVED',probation:'NOT_ON_ACADEMIC_PROBATION',expected:'Not possible'},
  {name:'two May units with approval',reserved:'0',spring:'1',approval:'APPROVED',probation:'NOT_ON_ACADEMIC_PROBATION',expected:'Not possible'}
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
    expect(result.economicsPlanResult.conclusion).toBe(scenario.expected==='Not possible'?'PROVEN_INFEASIBLE':'UNKNOWN');
  }
});
