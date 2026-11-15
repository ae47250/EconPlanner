import test from 'node:test';
import assert from 'node:assert/strict';
import {loadCanonicalPolicy,oracleEvaluateCanonicalPlan,oracleEvaluatePrerequisite} from './oracle/load-canonical-policy.js';
import { handleEconomicsReportRequest } from '../app/api/reports/economics/route.js';
import { POST } from '../app/api/majors/map/route.js';
const student = { majorDeclarationCatalogYear: '2025-2026', academicStanding: 'sophomore', planCreationDate: '2026-10-17', courses: [
  { code: 'ECO 113', status: 'completed' }, { code: 'ECO 114', status: 'completed' }
] };
async function post(body) {
  const response = await POST(new Request('http://localhost/api/majors/map', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({student,...body})}));
  return {status:response.status,data:await response.json()};
}
test('Extra course adds and removes without replacing required placements', async () => {
  const generated = await post({});
  assert.equal(generated.status,200);
  const plans = generated.data.programs.find(item=>item.program.id==='economics-base').economicsPlans;
  const plan = plans.find(item=>item.id==='balanced');
  const canonical = await loadCanonicalPolicy();
  const available = student.courses.map(course=>course.code);
  for (const target of plan.terms) {
    for (const candidate of [...target.extraCourseOptions, ...target.extraCourseHistory]) {
      if (candidate.course === 'ECO elective') continue;
      const decision = oracleEvaluatePrerequisite(canonical,candidate.course,{available,sameTerm:target.courses.map(course=>course.course),approvals:candidate.requiredApprovals || []});
      assert.notEqual(decision.status,'BLOCK',`${candidate.course} ${target.slotId}`);
    }
    if (target.termKey === 'Spring') assert.ok(!target.extraCourseHistory.some(item=>['MAT 113','ECO 213','ECO 214'].includes(item.course)));
    available.push(...target.courses.map(course=>course.course));
  }
  const term = plan.terms.find(item=>item.slotId==='winter-2027');
  assert.ok(term.extraCourseOptions.some(item=>item.course==='ECO 161' && item.status==='ALLOWED'));
  assert.ok(!term.extraCourseOptions.some(item=>item.course==='ECO 461'));
  const added = await post({action:'validate-plan',plan,plans,edit:{type:'add-extra',toTermId:term.slotId,course:'ECO 161'}});
  assert.equal(added.status,200,JSON.stringify(added.data));
  const oracle = oracleEvaluateCanonicalPlan(await loadCanonicalPolicy(),student,added.data.plan);
  assert.equal(oracle.valid,true,JSON.stringify(oracle));
  const all = added.data.plan.terms.flatMap(item=>item.courses);
  const extra = all.find(item=>item.extra);
  assert.equal(extra.course,'ECO 161');
  assert.deepEqual(all.filter(item=>!item.extra).map(item=>item.requirementId),plan.terms.flatMap(item=>item.courses.map(course=>course.requirementId)));
  const reportResponse = await handleEconomicsReportRequest(new Request('http://localhost/api/reports/economics',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({student,selectedPlan:added.data.plan,plans:plans.map(item=>item.id===plan.id?added.data.plan:item),format:'html'})}));
  assert.equal(reportResponse.status,200);
  const html = await reportResponse.text();
  assert.match(html, /data-requirement-id="extra-economics-1"/);
  assert.match(html, /class="course-requirement">Extra<\/span>/);
  const removed = await post({action:'validate-plan',plan:added.data.plan,plans:plans.map(item=>item.id===plan.id?added.data.plan:item),edit:{type:'remove-extra',fromTermId:term.slotId,courseId:extra.requirementId}});
  assert.equal(removed.status,200,JSON.stringify(removed.data));
  assert.equal(removed.data.plan.terms.flatMap(item=>item.courses).some(item=>item.extra),false);
  const forged = structuredClone(plan);
  forged.terms[0].courses[0].extra=true;
  const rejected = await post({action:'validate-plan',plan:forged,plans});
  assert.equal(rejected.status,422);
});

test('Winter elective replacements reject ECO 321 even when BUSN 323 is planned for finance', async () => {
  const generated = await post({});
  const plans = generated.data.programs.find(item => item.program.id === 'economics-base').economicsPlans;
  const plan = plans.find(item => item.id === 'balanced');
  assert.ok(plan.terms.some(term => term.courses.some(course => course.course === 'BUSN 323')));
  const from = plan.terms.find(term => term.courses.some(course => course.course === 'ECO 222'));
  const course = from.courses.find(course => course.course === 'ECO 222');
  const edit = replacementCourse => ({ type: 'replace-move', fromTermId: from.slotId,
    toTermId: 'winter-2027', courseId: course.requirementId, replacementCourse });
  const first = await post({ action: 'validate-plan', plan, plans, edit: edit('ECO 161') });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const winter = first.data.plan.terms.find(term => term.slotId === 'winter-2027');
  const elective = winter.courses.find(course => course.course === 'ECO 161');
  const option = elective.replacementDestinationOptions.find(option => option.course === 'ECO 321' && option.toTermId === winter.slotId);
  assert.ok(!option || option.status === 'BLOCKED', 'ECO 321 cannot replace an elective');
  const changed = await post({ action: 'validate-plan', plan: first.data.plan,
    plans: plans.map(item => item.id === plan.id ? first.data.plan : item),
    edit: { ...edit('ECO 321'), fromTermId: winter.slotId } });
  assert.equal(changed.status, 422, JSON.stringify(changed.data));
  const audit = oracleEvaluateCanonicalPlan(await loadCanonicalPolicy(), student, first.data.plan);
  assert.equal(audit.valid, true, JSON.stringify(audit));
});

test('existing concurrent enrollment does not become a new registration warning', async () => {
  const result = await post({ student: { ...student, courses: [...student.courses,
    { code: 'MAT 113', status: 'in_progress' }, { code: 'ECO 213', status: 'in_progress' }] } });
  assert.equal(result.status, 200);
  assert.ok(!result.data.catalog.advisorAttention.some(item => item.title === 'Concurrent enrollment approval'));
});
