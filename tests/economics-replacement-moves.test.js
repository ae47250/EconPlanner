import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../app/api/majors/map/route.js';
import { POST as reportPOST } from '../app/api/reports/economics/route.js';
import { compactEconomicsPlanForValidation } from '../lib/planning/validation-payload.js';
import { courseOfferingInformation } from '../lib/planning/plan-notes.js';
import { runtimePolicyBundle } from '../lib/policy/compat-normalized.js';
import { loadCanonicalPolicy, oracleEvaluateCanonicalPlan } from './oracle/load-canonical-policy.js';
import { projectSelectedPlanArtifact, projectReportJsonArtifact, projectReportHtmlArtifact, projectionMismatches } from './oracle/economics-artifact-projection.js';

const student = { academicStanding: 'freshman', planCreationDate: '2026-07-30', courses: [] };
async function post(body, handler = POST) {
  const response = await handler(new Request('http://localhost/api/majors/map', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }));
  const data = response.headers.get('content-type')?.includes('text/html') ? await response.text() : await response.json();
  return { status: response.status, data };
}
const generated = await post({student});
const plans = generated.data.programs.find(item => item.economicsPlans).economicsPlans;
const source = plans.find(item => item.id === 'explore-first');
const requirementId = 'eco-elective-1';
const find = plan => plan.terms.flatMap(term => term.courses.map(course => ({term, course}))).find(item => item.course.requirementId === requirementId);
async function edit(plan, replacementCourse, toTermId, type = 'replace-move', id = requirementId) {
  const from = plan.terms.find(term => term.courses.some(course => course.requirementId === id));
  return post({ action:'validate-plan', student, plan:compactEconomicsPlanForValidation(plan), plans: plans.map(peer => compactEconomicsPlanForValidation(peer.id === plan.id ? plan : peer)),
    edit: {type, fromTermId:from.slotId, courseId:id, toTermId, replacementCourse} });
}
const namedResult = await edit(source, 'ECO 222', 'spring-2027');
assert.equal(namedResult.status, 200, JSON.stringify(namedResult.data));
const named = namedResult.data.plan;
const oraclePolicy = await loadCanonicalPolicy();
const assignments = plan => plan.terms.flatMap(term => term.courses.map(course => [course.requirementId, course.course, term.slotId, course.section, course.minimumLevel || null])).sort();

for (const destination of ['fall-2027', 'winter-2028', 'spring-2028']) {
  test(`explicit named elective conversion into ${destination} preserves the complete plan`, async () => {
    const original = structuredClone(named);
    const moveNamed = await edit(named, undefined, destination, 'move');
    assert.equal(moveNamed.status, 422, 'Unpublished named electives remain prohibited, including May');
    const result = await edit(named, 'ECO elective', destination);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const placed = find(result.data.plan);
    assert.equal(placed.term.slotId, destination);
    assert.equal(placed.course.course, 'ECO elective');
    assert.equal(placed.course.minimumLevel, 200);
    assert.equal(placed.course.section, '');
    assert.equal(placed.course.source, 'projected-offering');
    assert.equal(placed.course.availability, null);
    assert.equal(placed.course.offeringInformation, null, 'The old named course pattern must not follow the generic elective');
    assert.match(placed.course.title, /choose the course later/);
    assert.deepEqual(assignments(result.data.plan).filter(row => row[0] !== requirementId), assignments(named).filter(row => row[0] !== requirementId));
    assert.equal(new Set(assignments(result.data.plan).map(row => row[0])).size, assignments(named).length);
    assert.equal(result.data.planSetValidation.valid, true);
    assert.equal(oracleEvaluateCanonicalPlan(oraclePolicy, student, result.data.plan).valid, true);
    assert.deepEqual(named, original);
    const next = placed.course.moveDestinationOptions.find(option => ['ALLOWED','CONDITIONAL'].includes(option.status));
    assert.ok(next, 'An existing generic elective remains editable');
    const movedAgain = await edit(result.data.plan, undefined, next.id, 'move');
    assert.equal(movedAgain.status, 200, JSON.stringify(movedAgain.data));
  });
}

test('published schedules use actual replacements and same-course confirmed moves retain identity', async () => {
  const result = await edit(named, 'ECO 234', 'fall-2026');
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const confirmed = await edit(result.data.plan, undefined, 'spring-2027', 'move');
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(find(confirmed.data.plan).course.course, 'ECO 234');
  assert.equal(find(confirmed.data.plan).course.source, 'verified-offering');
  assert.ok(find(confirmed.data.plan).course.section);
  assert.deepEqual(assignments(confirmed.data.plan).filter(row=>row[0]!==requirementId), assignments(named).filter(row=>row[0]!==requirementId));
  assert.equal(oracleEvaluateCanonicalPlan(oraclePolicy, student, confirmed.data.plan).valid, true);
});

test('invalid, occupied, published placeholders, level changes and required-course conversion fail without mutation', async () => {
  const original = structuredClone(named);
  for (const [code, term, id] of [
    ['ECO elective','spring-2027',requirementId], ['ECO elective','spring-2029',requirementId],
    ['ECO elective','fall-2099',requirementId], ['ECO 161','winter-2027',requirementId],
    ['ECO 999','winter-2027',requirementId], ['ECO elective','fall-2027','eco-113']
  ]) {
    const result = await edit(named, code, term, 'replace-move', id);
    assert.equal(result.status, 422, `${code} ${term}: ${JSON.stringify(result.data)}`);
  }
  assert.deepEqual(named, original);
  const options = find(named).course.replacementDestinationOptions;
  assert.ok(!options.some(item => item.course === 'ECO elective' && item.toTermId === 'spring-2027'));
  assert.ok(options.some(item => item.course === 'ECO 234' && item.toTermId === 'spring-2027'));
});

test('selected converted plan and named offering information agree with report JSON and HTML', async () => {
  for (const plan of [named, (await edit(named, 'ECO elective', 'winter-2028')).data.plan]) {
    const body = {student, selectedPlan:plan, plans:plans.map(peer=>peer.id===plan.id ? plan : peer), preparedDate:'2026-07-30'};
    const json = await post({...body, format:'json'}, reportPOST);
    assert.equal(json.status, 200, JSON.stringify(json.data));
    const html = await post({...body, format:'html'}, reportPOST);
    assert.equal(html.status, 200);
    const expected = projectSelectedPlanArtifact(plan, {advisorNotices:json.data.catalog?.advisorAttention || []});
    assert.deepEqual(projectionMismatches(expected, projectReportJsonArtifact(json.data)), []);
    const occupied = projection => ({...projection, terms:projection.terms.filter(term=>term.courses.length)});
    assert.deepEqual(projectionMismatches(occupied(expected), occupied(projectReportHtmlArtifact(html.data))), []);
    const course = json.data.terms.flatMap(term=>term.courses).find(item=>item.requirementId===requirementId);
    assert.deepEqual(course.offeringInformation, find(plan).course.offeringInformation);
    if (course.offeringInformation) assert.ok(html.data.includes(course.offeringInformation.label));
  }
});

test('offering labels report historical facts without activating a May prediction', () => {
  const bundle = runtimePolicyBundle();
  const info = courseOfferingInformation({course:'ECO 222'}, bundle);
  assert.ok(info?.observations.length);
  assert.match(info.label, /^Past schedules:/);
  assert.doesNotMatch(info.label, /usually|only/i);
  assert.equal(courseOfferingInformation({course:'ECO 999'}, bundle), null);
  assert.equal(courseOfferingInformation({course:'ECO 222'}, {planningAdvice:{observations:[]}}), null);
  assert.equal(courseOfferingInformation({course:'ECO elective'}, bundle), null);
});
