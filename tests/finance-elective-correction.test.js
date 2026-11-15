import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadEconomicsPolicyCompatibility } from "../lib/policy/compat-normalized.js";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { evaluateRequirementAllocation } from "../lib/decision-engine/requirements.js";
import { buildRequirementAllocation } from "../lib/planning/requirementAllocation.js";
import { checkExternalEconomicsRequirements } from "./oracle/check-requirements.js";
import { GET, POST } from '../app/api/majors/map/route.js';
import { handleEconomicsReportRequest } from '../app/api/reports/economics/route.js';
import { createGeneratedPlannerSession } from '../lib/planning/uiState.js';
import { validateSavedPlannerSession } from '../lib/planning/session-restoration.js';

const policy = loadEconomicsPolicyCompatibility();
const oracle = JSON.parse(await readFile(new URL('./oracle/economics-policy.v1.json', import.meta.url)));
const message = 'You may petition to count BUSN 323 as an Economics elective. This planner does not apply that credit; discuss the petition with your advisor.';
const pair = ['ECO 321', 'BUSN 323'];
const completed = code => ({ code, status: 'completed', source: 'direct-record', units: 1 });
const core = ['ECO 113', 'ECO 114', 'ECO 213', 'ECO 214', 'MAT 113', 'MAT 217', 'ECO 461'];
const electives = ['ECO 221', 'ECO 234', 'ECO 260', 'ECO 333', 'ECO 337'];
const map = courses => mapStudentToProgram({ id: 'economics' }, policy.requirements, { courses });

test('finance decision table: all 81 status combinations, both orders, and duplicate records', () => {
  const statuses = ['absent', 'completed', 'in_progress', 'planned', 'transfer', 'uncertain', 'failed', 'withdrawn', 'repeated'];
  let covered = 0;
  for (const a of statuses) for (const b of statuses) {
    const courses = [a, b].flatMap((status, i) => status === 'absent' ? [] : [{ ...completed(pair[i]), status }]);
    const expectedNotice = a === 'completed' && b === 'completed';
    for (const input of [courses, [...courses].reverse(), [...courses, ...courses]]) {
      const result = map(input);
      assert.equal(result.advisorNotifications.length, Number(expectedNotice), `${a}/${b}`);
      for (const scenario of [result.strict, result.optimistic, result.projectedAfterInProgress.strict, result.projectedAfterInProgress.optimistic]) {
        assert.ok(!scenario.assignments.some(item => item.slotId.startsWith('eco-elective')));
        assert.ok(scenario.assignments.filter(item => item.slotId === 'finance').length <= 1);
      }
      if (expectedNotice) {
        assert.equal(result.strict.assignments.find(item => item.slotId === 'finance').code, 'ECO 321');
        assert.equal(result.advisorNotifications[0].message, message);
        assert.ok(result.unusedCourses.some(item => item.code === 'BUSN 323'));
      }
    }
    covered++;
  }
  assert.equal(covered, 81, '100% of the 81 defined decision-table combinations');
});

test('completed-pair notice excludes provisional sources and incomplete units', () => {
  for (const source of ['transfer', 'ap', 'equivalency', 'substitution', 'waiver', 'outside', 'uncertain', 'title_only']) {
    for (const index of [0, 1]) {
      const courses = pair.map(completed);
      courses[index].source = source;
      assert.deepEqual(map(courses).advisorNotifications, [], `${source}/${index}`);
    }
  }
  for (const index of [0, 1]) {
    const courses = pair.map(completed);
    courses[index].units = 0.5;
    assert.deepEqual(map(courses).advisorNotifications, []);
  }
});

test('mixed repeated records cannot combine partial completed and pending evidence for the notice', () => {
  for (const code of pair) {
    const other = completed(pair.find(item => item !== code));
    for (const status of ['in_progress', 'failed', 'withdrawn', 'repeated', 'uncertain']) {
      const records = [{ ...completed(code), units: 0.5 }, { ...completed(code), status }];
      for (const ordered of [records, [...records].reverse()]) {
        assert.deepEqual(map([other, ...ordered]).advisorNotifications, [], `${code}/${status}`);
      }
    }
    const records = [completed(code), { ...completed(code), source: 'transfer' }];
    for (const ordered of [records, [...records].reverse()]) {
      const result = map([other, ...ordered]);
      assert.equal(result.advisorNotifications[0].message, message);
      assert.equal(result.strict.assignments.find(item => item.slotId === 'finance').code, 'ECO 321');
    }
  }
});

test('three/four/five elective boundaries agree independently with the Oracle', () => {
  for (const count of [3, 4, 5]) {
    const codes = [...core, ...pair, ...electives.slice(0, count)];
    const result = map(codes.map(completed));
    const remaining = result.strict.unresolved.filter(item => item.requirementId.startsWith('eco-elective'));
    assert.equal(remaining.length, count === 3 ? 1 : 0);
    assert.equal(result.strict.assignments.filter(item => item.slotId.startsWith('eco-elective')).length, Math.min(count, 4));
    const independent = checkExternalEconomicsRequirements({
      policy: oracle,
      student: { completedCourses: codes.map(course => ({ course, units: 1, ...(course === 'ECO 461' ? { institution: 'Hanover College' } : {}) })) },
      plan: { id: `fictional-finance-${count}`, terms: [] }
    });
    assert.equal(independent.status, count === 3 ? 'INVALID_REQUIREMENTS' : 'VALID_REQUIREMENTS');
    assert.ok(!independent.allocation?.some(item => item.ruleId === 'REQ-ECO-ELECTIVES' && pair.includes(item.canonicalCourse)));
  }
});

test('both pairings and claimed placeholder or approval metadata cannot bypass allocation', () => {
  for (const [finance, elective] of [pair, [...pair].reverse()]) {
    const assignments = [{ slotId: 'finance', code: finance }];
    for (const metadata of [{}, { source: 'requirement-placeholder', options: [] }, { approvalInstances: [{ status: 'APPROVED' }], requirementCreditEvidence: 'approved' }]) {
      assert.equal(evaluateRequirementAllocation({ course: elective, ...metadata }, 'eco-elective-1', null, policy.bundle, { assignments }).status, 'BLOCK');
    }
    for (const status of ['completed', 'in_progress']) {
      const result = buildRequirementAllocation({ requirements: policy.requirements.requirementSlots,
        existingAssignments: [{ ...assignments[0], status }],
        plan: { terms: [{ courses: [{ course: elective, requirementId: 'eco-elective-1' }] }] }
      });
      assert.equal(result.valid, false);
    }
  }
});

const request = body => new Request('http://localhost/api/majors/map', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});
const studentWithPair = { majorDeclarationCatalogYear: '2025-2026', academicStanding: 'senior', planCreationDate: '2026-07-30',
  courses: [...core.filter(code => code !== 'ECO 461'), ...pair, ...electives.slice(0, 3)].map(completed) };

test('API, edits, rejected claims, restoration and reports retain the same finance correction', async () => {
  const student = structuredClone(studentWithPair);
  const original = structuredClone(student);
  const response = await POST(request({ student }));
  assert.equal(response.status, 200);
  const report = await response.json();
  const economics = report.programs.find(item => item.program.id === 'economics-base');
  const plans = economics.economicsPlans;
  assert.ok(plans.length);
  assert.equal(economics.assignments.filter(item => item.slotId.startsWith('eco-elective')).length, 3);
  for (const plan of plans) {
    assert.equal(plan.validation.valid, true, plan.id);
    assert.ok(plan.studentNotices.some(item => item.message === message));
    assert.ok(!plan.terms.flatMap(term => term.courses).some(item => pair.includes(item.course)), 'finance is already completed; neither course unlocks an elective');
    assert.equal(plan.majorRequirementsChecklist.rows.find(row => row.id === 'finance').course, 'ECO 321');
  }
  const plan = plans[0];
  const winter = plan.terms.find(term => term.slotId === 'winter-2027');
  const added = await POST(request({ student, plan, plans, action: 'validate-plan',
    edit: { type: 'add-extra', toTermId: winter.slotId, course: 'ECO 161' } }));
  assert.equal(added.status, 200);
  const addedPlan = (await added.json()).plan;
  assert.ok(addedPlan.studentNotices.some(item => item.message === message));
  const extra = addedPlan.terms.flatMap(term => term.courses).find(item => item.extra);
  const removed = await POST(request({ student, plan: addedPlan, plans: plans.map(item => item.id === plan.id ? addedPlan : item), action: 'validate-plan',
    edit: { type: 'remove-extra', fromTermId: winter.slotId, courseId: extra.requirementId } }));
  assert.equal(removed.status, 200);
  assert.ok((await removed.json()).plan.studentNotices.some(item => item.message === message));

  let forged;
  for (const code of pair) {
    forged = structuredClone(plan);
    const elective = forged.terms.flatMap(term => term.courses).find(item => item.requirementId.startsWith('eco-elective'));
    elective.course = code;
    elective.source = 'requirement-placeholder';
    elective.options = [];
    assert.equal((await POST(request({ student, plan: forged, plans, action: 'validate-plan' }))).status, 422);
    assert.equal((await handleEconomicsReportRequest(request({ student, preparedDate: student.planCreationDate, selectedPlan: forged, plans }))).status, 422);
  }
  const session = createGeneratedPlannerSession({ report, inputSignature: 'finance', selectedPlanId: plan.id,
    view: 'plan', reportContextId: 'finance', planEditUndo: { reportContextId: 'finance', inputSignature: 'finance', planId: plan.id, plan: forged } });
  const rawSession = JSON.stringify(session);
  const restored = await validateSavedPlannerSession({ rawSession, inputSignature: 'finance', student,
    fetchImpl: (_url, options) => options.method === 'POST' ? POST(request(JSON.parse(options.body))) : GET() });
  assert.equal(restored.kind, 'restored');
  assert.equal(restored.session.planEditUndo, null, 'old finance/elective undo must be discarded');
  const obsolete = { ...session, plannerFingerprint: 'sha256:before-finance-clarification' };
  assert.equal((await validateSavedPlannerSession({ rawSession: JSON.stringify(obsolete), inputSignature: 'finance', student, fetchImpl: GET })).kind, 'obsolete');
  assert.equal(JSON.stringify(session), rawSession, 'stored history remains recoverable');
  assert.deepEqual(student, original);
});

test('no-feasible-plan API, JSON and HTML reports retain the notice and missing elective', async () => {
  const student = { ...studentWithPair, planCreationDate: '2026-09-27',
    reservedCourseUnits: { 'winter-2027': 4, 'spring-2027': 1 } };
  const data = await (await POST(request({ student }))).json();
  const economics = data.programs.find(item => item.program.id === 'economics-base');
  assert.equal(economics.economicsPlans.length, 0);
  assert.ok(data.catalog.advisorAttention.some(item => item.message === message));
  for (const format of ['json', 'html']) {
    const response = await handleEconomicsReportRequest(request({ student, preparedDate: student.planCreationDate, format }));
    assert.equal(response.status, 200);
    if (format === 'html') assert.ok((await response.text()).includes(message));
    else {
      const report = await response.json();
      assert.equal(report.selectedPlan, null);
      assert.ok(report.studentNotices.some(item => item.message === message));
      assert.ok(report.advisorNotifications.some(item => item.message === message));
      assert.ok(report.majorRequirementsChecklist.rows.some(row => row.id.startsWith('eco-elective') && row.status === 'still_needed'));
    }
  }
});
