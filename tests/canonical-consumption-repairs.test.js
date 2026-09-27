import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicyBundle } from '../lib/policy/load-bundle.js';
import { evaluateRequirementAllocation } from '../lib/decision-engine/requirements.js';
import { evaluatePlanningHorizon } from '../lib/decision-engine/placement.js';
import { resolvePlanningContext } from '../lib/planning/horizon.js';
import { loadPlanningFlexibilityPolicy } from '../lib/catalog/policy-releases.js';
const bundle = await loadPolicyBundle();

test('owner standing notice is nonblocking and exact', () => {
  const standing = loadPlanningFlexibilityPolicy().policy.acceleratedSeniorStanding;
  assert.equal(standing.notice.message, 'This plan assumes you will have senior standing in your final year.');
  assert.equal(standing.requiresStudentConfirmation, false);
  assert.equal(standing.readinessImpact, 'NONE');
});
test('statistics timing has one active controlling record', () => {
  assert.equal(bundle.indexes.byRuleId['PREREQ-ECO-461'].effect.statisticsMustBePrior, true);
  assert.notEqual(bundle.indexes.byRuleId['CAPSTONE-STATISTICS-BEFORE']?.status, 'ACTIVE');
});
test('synthetic elective limit changes the decision', () => {
  const synthetic = structuredClone(bundle);
  synthetic.indexes.byRuleId['ELECTIVE-MAX-ONE-100-LEVEL'].effect.maximumAcrossElectiveSlots = 2;
  assert.equal(evaluateRequirementAllocation('ECO 161', 'eco-elective-1', {}, synthetic, { level100Electives: 1 }).status, 'ALLOW');
});
test('direct horizon validation cannot bypass closed current-term registration', () => {
  const context = resolvePlanningContext({academicStanding:'freshman', planCreationDate:'2026-08-29'});
  const decision = evaluatePlanningHorizon({academicYear:'2026/2027',yearIndex:0,termKey:'Fall',courses:[{course:'ECO 113'}]}, context, bundle, {});
  assert.equal(decision.status, 'BLOCK');
});

import { readFile, readdir } from 'node:fs/promises';
import { buildCompatibilityRepresentations } from '../lib/policy/compatibility-projection.js';
import { requirementFormGroups } from '../lib/planning/requirementFormChoices.js';
import { buildEarlyGraduationContext, buildPlanningSlots } from '../lib/planning/horizon.js';
import { evaluatePlan } from '../lib/decision-engine/plan.js';
import { normalizeStudentFacts } from '../lib/decision-engine/student-facts.js';
const json = async path => JSON.parse(await readFile(new URL('../' + path, import.meta.url), 'utf8'));

test('synthetic canonical requirement choices drive the compiled form and engine together', async () => {
  const manifest = await json('policy/manifest/econ-2025-2026.1.json');
  const documents = Object.fromEntries(await Promise.all(manifest.inputs.map(async input => [input.id, await json(input.path)])));
  // In-memory only; no synthetic rule is written to a source or generated file.
  const rules = Object.values(documents).flatMap(document => document.records || []).filter(rule => rule.status === 'ACTIVE');
  for (const id of ['REQ-STATISTICS', 'REQ-FINANCE', 'REQ-COGNATE']) {
    const rule = rules.find(rule => rule.ruleId === id);
    rule.effect.options = rule.effect.options.slice(0, 1);
  }
  const views = buildCompatibilityRepresentations({courses:documents.courses, requirements:documents.requirements, rules,
    schedule:documents['schedule-2026-2027'], offeringPatterns:documents['offering-patterns'], provenance:documents.provenance, profile:documents['compatibility-profile']});
  const requirements = views['requirements.json'];
  assert.ok(requirements);
  const synthetic = structuredClone(bundle);
  synthetic.indexes.byRuleId = Object.fromEntries(rules.map(rule => [rule.ruleId, rule]));
  const groups = requirementFormGroups(requirements);
  for (const [id, groupId] of [['statistics','statistics-requirement'], ['finance','finance-requirement'], ['cognate','math-requirement']]) {
    const slot = requirements.requirementSlots.find(slot => slot.id === id);
    assert.deepEqual(groups.find(group => group.id === groupId).courseCodes, slot.options);
    assert.equal(slot.options.length, 1);
    assert.equal(evaluateRequirementAllocation(slot.options[0], id, {}, synthetic).status, 'ALLOW');
    const oldOptions = Object.values(bundle.indexes.byRuleId).find(rule => rule.effect.options && rule.scope.requirements.includes(id)).effect.options;
    for (const removed of oldOptions.filter(code => !slot.options.includes(code))) assert.equal(evaluateRequirementAllocation(removed, id, {}, synthetic).status, 'BLOCK');
  }
});

test('synthetic exclusions, pairings and equivalencies change production allocation', () => {
  const synthetic = structuredClone(bundle);
  synthetic.indexes.byRuleId['ELECTIVE-ECO-257-STATISTICS-ONLY'].condition.course = 'ECO 221';
  assert.equal(evaluateRequirementAllocation('ECO 221','eco-elective-1',{},synthetic).status,'BLOCK');
  synthetic.requirementProfile.electiveConditionalCourses['ECO 321'].assignedCode = 'ECO 321';
  assert.equal(evaluateRequirementAllocation('ECO 321','eco-elective-1',{},synthetic,{assignments:[{slotId:'finance',code:'BUSN 323'}]}).status,'BLOCK');
  const equivalency = synthetic.indexes.byRuleId['ELECTIVE-CROSSLIST-ECO-234-PHI-234'];
  equivalency.condition.equivalentCodes.push('TST 234');
  assert.equal(evaluateRequirementAllocation('TST 234','eco-elective-1',{},synthetic).status,'ALLOW');
});

test('engine observes every official add/drop opening, closing and day after closure', async () => {
  const calendar = await json('policy/calendars/hanover-undergraduate.json');
  for (const window of calendar.initialDropAddWindows) {
    const term = {academicYear:window.academicYear, yearIndex:0, termKey:window.canonicalTerm, courses:[{course:'ECO 113'}]};
    for (const date of [window.start,window.end]) {
      const context = resolvePlanningContext({academicStanding:'freshman',planCreationDate:date});
      assert.notEqual(evaluatePlanningHorizon(term,context,bundle,{}).status,'BLOCK',date);
    }
    const after = new Date(window.end+'T12:00:00Z'); after.setUTCDate(after.getUTCDate()+1);
    const context = resolvePlanningContext({academicStanding:'freshman',planCreationDate:after.toISOString().slice(0,10)});
    assert.equal(evaluatePlanningHorizon(term,context,bundle,{}).status,'BLOCK',window.end);
    assert.notEqual(evaluatePlanningHorizon({...term,courses:[{course:'ECO 113',fixedInProgress:true}]},context,bundle,{}).status,'BLOCK');
  }
});

test('regular and transfer early contexts assume final-year standing only', () => {
  const contexts = [buildEarlyGraduationContext(resolvePlanningContext({academicStanding:'freshman',planCreationDate:'2026-09-27',planningPace:'one_year_early'})),
    resolvePlanningContext({isTransferStudent:true,transferEntryAcademicYear:'2026-2027',transferExpectedGraduationYear:2028,planCreationDate:'2026-09-27'})];
  for (const context of contexts) {
    assert.equal(context.acceleratedPlanAssumesSeniorStanding,true);
    const slots = buildPlanningSlots(context);
    assert.ok(slots.length);
    for (const slot of slots) assert.equal(slot.absoluteStandingIndex === 3,slot.yearIndex === context.remainingYears - 1);
  }
});

test('duplicate declared elective slots report the slot contract and exact reason', () => {
  const facts = normalizeStudentFacts({planCreationDate:'2026-08-05',courses:[]});
  const plan = {terms:[{academicYear:'2026/2027',termKey:'Fall',yearIndex:0,courses:[
    {course:'ECO 234',requirementId:'eco-elective-1'},{course:'ECO 260',requirementId:'eco-elective-1'}]}],unscheduled:[]};
  const result = evaluatePlan(plan, facts, {}, bundle);
  assert.ok(result.decisions.some(decision => decision.ruleIds.includes('ELECTIVE-SLOT-UNIQUE-ASSIGNMENT') && decision.reasonCode === 'DUPLICATE_ELECTIVE_SLOT_ASSIGNMENT'));
});

test('all active consumers select one flexibility bundle; obsolete direct versions are forbidden', async () => {
  const selected = await json('data/compiled/policy/planning-flexibility/active.json');
  assert.equal(selected.contentHash,loadPlanningFlexibilityPolicy().contentHash);
  assert.equal(selected.bundleVersion,'econ-planning-flexibility.7');
  async function inspect(directory) {
    for (const entry of await readdir(new URL('../'+directory,import.meta.url),{withFileTypes:true})) {
      const path = directory+'/'+entry.name;
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(js|mjs)$/.test(path)) {
        const text = await readFile(new URL('../'+path,import.meta.url),'utf8');
        assert.doesNotMatch(text,/planning-flexibility\/econ-planning-flexibility\.[1-6]\//,path);
      }
    }
  }
  await inspect('lib'); await inspect('app'); await inspect('scripts');
});

import { POST as mapPost } from '../app/api/majors/map/route.js';
import { loadCanonicalPolicy, oracleEvaluateCanonicalPlan, oracleEvaluateStanding } from './oracle/load-canonical-policy.js';
const mapRequest = body => mapPost(new Request('http://localhost/api/majors/map',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
test('generation uses open current-term slots and restored/edit submissions reject them after closure', async () => {
  const student = {academicStanding:'freshman',planCreationDate:'2026-08-24',courses:[]};
  const response = await mapRequest({student});
  assert.equal(response.status,200);
  const data = await response.json();
  const plan = data.programs.find(program => program.program.id === 'economics-base').economicsPlans[0];
  assert.ok(plan.terms.find(term => term.slotId === 'fall-2026').courses.some(course => !course.fixedInProgress));
  const closedStudent = {...student,planCreationDate:'2026-08-29'};
  const edit = await mapRequest({action:'validate-plan',student:closedStudent,plan,plans:[plan]});
  assert.equal(edit.status,422);
  const oracle = await loadCanonicalPolicy();
  const result = oracleEvaluateCanonicalPlan(oracle,closedStudent,plan);
  assert.ok(result.findings.some(finding => finding.reasonCode === 'CURRENT_TERM_NEW_PLACEMENT_CLOSED'));
});
test('a forged term flag cannot make Taking now prerequisites completed in the current term', () => {
  const student = {academicStanding:'sophomore',planCreationDate:'2026-08-24',courses:[{code:'ECO 113',status:'in_progress'},{code:'MAT 113',status:'completed'}]};
  const plan = {terms:[{academicYear:'2026/2027',yearIndex:0,termKey:'Fall',inProgressPrerequisitesAvailable:true,courses:[{course:'ECO 213',requirementId:'eco-213'}]}],unscheduled:[]};
  const result = evaluatePlan(plan,normalizeStudentFacts(student),resolvePlanningContext(student),bundle);
  assert.ok(result.decisions.some(decision => decision.status === 'BLOCK' && decision.ruleIds.includes('PREREQ-ECO-213')));
});
test('canonical Oracle independently applies the approved final-year standing boundary', async () => {
  const policy = await loadCanonicalPolicy();
  for (const context of [
    buildEarlyGraduationContext(resolvePlanningContext({academicStanding:'freshman',planCreationDate:'2026-09-27',planningPace:'one_year_early'})),
    resolvePlanningContext({isTransferStudent:true,transferEntryAcademicYear:'2026-2027',transferExpectedGraduationYear:2028,planCreationDate:'2026-09-27'})
  ]) {
    const finalYear = context.expectedGraduationYear-1;
    assert.equal(oracleEvaluateStanding(policy,{academicYear:`${finalYear}/${finalYear+1}`},context).status,'ALLOW');
    assert.equal(oracleEvaluateStanding(policy,{academicYear:`${finalYear-1}/${finalYear}`},context).status,'BLOCK');
  }
});

import { checkExternalEconomicsScheduleAndHorizon } from './oracle/check-schedule-and-horizon.js';
test('external Oracle independently rejects closed add/drop placements', async () => {
  const policy = await json('tests/oracle/economics-policy.v1.json');
  const verifiedSchedule = await json('tests/oracle/verified-schedule-2026-2027.json');
  const expectedContext = {startYear:2026,expectedGraduationYear:2030};
  const plan = {terms:[{academicYear:'2026/2027',termKey:'Fall',courses:[{course:'ECO 113',requirementId:'eco-113'}]}]};
  for (const [date,closed] of [['2026-08-24',false],['2026-08-28',false],['2026-08-29',true]]) {
    const result = checkExternalEconomicsScheduleAndHorizon({policy,verifiedSchedule,plan,expectedContext,student:{planCreationDate:date}});
    assert.equal(result.violations.some(item => item.code === 'CURRENT_TERM_NEW_PLACEMENT_CLOSED'),closed,date);
  }
});

test('automatic raw-history allocations do not count as declared elective-slot repetitions', () => {
  const facts = normalizeStudentFacts({planCreationDate:'2026-08-05',courses:[{code:'ECO 161',status:'completed'}]});
  const plan = {terms:[{academicYear:'2026/2027',termKey:'Fall',courses:[{course:'ECO 234',requirementId:'eco-elective-1'}]}],unscheduled:[]};
  const result = evaluatePlan(plan,facts,{mapping:{assignments:[{slotId:'eco-elective-1',code:'ECO 161'}]}},bundle);
  assert.ok(result.decisions.some(decision => decision.reasonCode === 'REQUIREMENT_DUPLICATED'));
  assert.ok(!result.decisions.some(decision => decision.reasonCode === 'DUPLICATE_ELECTIVE_SLOT_ASSIGNMENT'));
});
