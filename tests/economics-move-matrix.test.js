import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fc from "fast-check";
import { POST } from "../app/api/majors/map/route.js";
import { resolvePlanningContext, selectedPlanContext } from "../lib/planning/horizon.js";
import { checkExternalEconomicsScheduleAndHorizon } from "./oracle/check-schedule-and-horizon.js";
import { auditExternalEconomicsPlanComplete } from "./oracle/audit-external-plan.js";
import { loadCanonicalPolicy, oracleEvaluateCanonicalPlan } from "./oracle/load-canonical-policy.js";

const policy = await loadCanonicalPolicy();
const oracleSpecification = JSON.parse(await readFile(new URL("./oracle/economics-policy.v1.json", import.meta.url), "utf8"));
const verifiedSchedule = JSON.parse(await readFile(new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url), "utf8"));
const profileFixture = JSON.parse(await readFile(new URL("./fixtures/economics-planning-profile-matrix.json", import.meta.url), "utf8"));
const fullMode = process.env.ECONOMICS_MOVE_MATRIX_MODE === "full";
const profileFilter = process.env.ECONOMICS_MOVE_MATRIX_PROFILE || null;
const completed = codes => codes.map(code => ({ code, status: "completed" }));
const baseSenior = completed(["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323"]);

const profiles = [
  ["extended", { academicStanding: "freshman", customGraduationEnabled: true, customExpectedGraduationYear: "2031", planCreationDate: "2026-09-23", courses: [] }],
  ["freshman", { academicStanding: "freshman", planCreationDate: "2026-09-23", courses: [] }],
  ["early", { academicStanding: "freshman", planningPace: "one_year_early", planCreationDate: "2026-09-23", courses: [] }],
  ["sophomore", { academicStanding: "sophomore", planCreationDate: "2026-07-30", courses: completed(["ECO 113", "ECO 114", "MAT 113"]) }],
  ["junior", { academicStanding: "junior", planCreationDate: "2026-07-30", courses: completed(["ECO 113", "ECO 114", "MAT 113", "ECO 213", "ECO 214", "MAT 217"]) }],
  ["senior", { academicStanding: "senior", planCreationDate: "2026-07-30", courses: baseSenior }],
  ["transfer", { academicStanding: "junior", isTransferStudent: true, transferExpectedGraduationYear: "2030", transferEntryAcademicYear: "2025-2026", planCreationDate: "2027-01-10", courses: completed(["ECO 113", "ECO 114", "MAT 113", "ECO 213"]) }],
  ["taking-now", { academicStanding: "sophomore", planCreationDate: "2027-02-01", courses: [...completed(["ECO 113", "ECO 114", "MAT 113"]), { code: "ECO 213", status: "in_progress", academicYear: "2026/2027", termKey: "Winter" }] }],
  ["current-fixed", { academicStanding: "freshman", planCreationDate: "2026-08-24", courses: [{ code: "ECO 113", status: "in_progress", academicYear: "2026/2027", termKey: "Fall" }], reservedCourseUnits: { "winter-2027": 4, "spring-2027": 1 } }],
  ["reserved", { academicStanding: "senior", planCreationDate: "2026-07-30", reservedCourseUnits: { "fall-2026": 3 }, courses: baseSenior }]
];

if (fullMode) for (const standing of profileFixture.standings) for (const fixture of profileFixture.profiles) {
  profiles.push([`corpus-${standing}-${fixture.id}`, {
    academicStanding: standing,
    planCreationDate: profileFixture.planCreationDate,
    courses: completed(fixture.courses)
  }]);
}

async function post(body) {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }));
  return { status: response.status, data: await response.json() };
}

function placements(plan) {
  return plan.terms.flatMap(term => term.courses.map(course => ({ term, course })));
}

function moveEdit(plan, from, course, destination) {
  return {
    type: "move", planId: plan.id, fromTermId: from.slotId, toTermId: destination.slotId,
    courseId: course.requirementId || `${course.course}-${course.source || "course"}`
  };
}

function canonicalTerm(term) {
  return ["Spring", "May", "Spring/May"].includes(term.termKey) ? "MAY" : String(term.termKey).toUpperCase();
}

function scheduleTermId(term) {
  const years = String(term.academicYear).match(/(\d{4})\D+(\d{4})/);
  const key = canonicalTerm(term);
  return years ? `${key === "FALL" ? years[1] : years[2]}-${key}` : null;
}

function matchingExactSections(code, term) {
  const releaseTerm = policy.schedule.terms.find(item => item.termId === scheduleTermId(term));
  if (!releaseTerm) return null;
  return releaseTerm.sections.filter(item => item.course === code || (item.crossListedAs || []).includes(code));
}

function policyBoundary(student, course, destination) {
  const key = canonicalTerm(destination);
  const rule = policy.rules.find(item => item.ruleType === "termLoad" && item.condition.canonicalTerm === key);
  const reserved = Number(student.reservedCourseUnits?.[destination.slotId] ?? 0);
  if (course.fixedInProgress) return { blocked: true, ruleIds: ["FIXED-IN-PROGRESS"] };
  if (course.course === "ECO 461" && !policy.byRuleId["CAPSTONE-WINTER-ONLY"].effect.allowedCanonicalTerms.includes(key)) return { blocked: true, ruleIds: ["CAPSTONE-WINTER-ONLY"] };
  if (rule && (destination.courses.length + 1 > rule.effect.maxTotalCourses
    || destination.courses.reduce((sum, item) => sum + Number(item.units ?? 1), reserved) + Number(course.units ?? 1) > rule.effect.normalCourseUnits
    || (rule.effect.maxEconomicsCourses
      && String(course.course).startsWith("ECO ")
      && destination.courses.filter(item => String(item.course).startsWith("ECO ")).length + 1 > rule.effect.maxEconomicsCourses))) {
    return { blocked: true, ruleIds: [rule.ruleId] };
  }
  const exact = matchingExactSections(course.course, destination);
  if (exact && !exact.length) return { blocked: true, ruleIds: ["SCHEDULE-AVAILABILITY-BEHAVIOR"] };
  const may = policy.byRuleId["PLANNING-MAY-COURSE-EXCLUSIONS"];
  if (key === "MAY" && may.effect.excludedCourses.includes(course.course) && !exact?.length) {
    return { blocked: true, ruleIds: [may.ruleId] };
  }
  const pair = policy.offeringPatterns.find(pattern => pattern.projectionPolicy.sameTerm === "REQUIRE_MATCHING_VERIFIED_SECTIONS"
    && [pattern.course].flat().includes(course.course));
  const counterparts = pair ? destination.courses.filter(row => row.course !== course.course && [pair.course].flat().includes(row.course)) : [];
  if (counterparts.length && !(exact?.length && counterparts.every(row => matchingExactSections(row.course, destination)?.length))) {
    return { blocked: true, ruleIds: [pair.patternId] };
  }
  const excluded = policy.offeringPatterns.find(pattern => [pattern.course].flat().includes(course.course)
    && pattern.hardExcludedTerms.includes(key));
  if (excluded) return { blocked: true, ruleIds: [excluded.patternId] };
  const approvedProjection = policy.offeringPatterns.find(pattern => [pattern.course].flat().includes(course.course)
    && pattern.projectionPolicy.unpublishedTermEligibility === "APPROVED_RECURRING_TERMS_ONLY");
  if (approvedProjection && !approvedProjection.approvedRecurringTerms.includes(key) && !exact?.length) {
    return { blocked: true, ruleIds: [approvedProjection.patternId] };
  }
  return { blocked: false, ruleIds: [] };
}

// Build counterfactual placements from the independent verified schedule and canonical
// permission records. Offering patterns guide generation; the future-projection policy
// permits explicitly unconfirmed edits. Do not use production edit/validation helpers.
function sameCourseTiming(left, right) {
  const timing = plan => placements(plan).map(({ term, course }) => [
    term.slotId,
    String(course.requirementId).startsWith("eco-elective") ? "elective" : course.requirementId,
    String(course.requirementId).startsWith("eco-elective") ? "elective" : course.course
  ].join("|")).sort();
  return left.planningContext.expectedGraduationTerm === right.planningContext.expectedGraduationTerm
    && left.planningContext.planningPace === right.planningContext.planningPace
    && JSON.stringify(timing(left)) === JSON.stringify(timing(right));
}

function expectedMove(student, plan, from, course, destination, plans = []) {
  const boundary = policyBoundary(student, course, destination);
  if (destination.isCurrentTerm) {
    const prerequisite = policy.rules.find(rule => rule.ruleType === "coursePrerequisite" && rule.condition.course === course.course);
    const finished = new Set((student.courses || []).filter(item => ["completed", "transfer"].includes(item.status)).map(item => item.code));
    if ((prerequisite?.effect.allOf || []).some(code => !finished.has(code))) {
      return { status: 422, evidence: [prerequisite.ruleId] };
    }
  }
  if (boundary.blocked) return { status: 422, evidence: boundary.ruleIds };
  const exact = matchingExactSections(course.course, destination);
  const rows = exact ? verifiedSchedule.sections.filter(row =>
    canonicalTerm({ termKey: row.term }) === canonicalTerm(destination)
    && (row.canonicalCrossListIdentity || [row.course]).includes(course.course)) : [null];
  const audits = rows.map(row => {
    const candidate = structuredClone(plan);
    const source = candidate.terms.find(term => term.slotId === from.slotId);
    const target = candidate.terms.find(term => term.slotId === destination.slotId);
    const index = source.courses.findIndex(item => item.requirementId === course.requirementId);
    const moved = source.courses.splice(index, 1)[0];
    Object.assign(moved, {
      slotId: destination.slotId, term: destination.term, termKey: destination.termKey,
      academicYear: destination.academicYear, projectedStanding: destination.projectedStanding,
      source: row ? "verified-offering" : "projected-offering",
      verificationStatus: row ? "verified" : "unconfirmed",
      title: row?.title || moved.title, units: row?.units ?? moved.units,
      crossListedAs: row?.canonicalCrossListIdentity.filter(code => code !== course.course) || [],
      section: row?.section || "", availability: row?.availability || null,
      meeting: row ? { ...row.meeting, ...row.courseDates } : null,
      provenance: row ? { humanVerifiedOn: row.verificationDate, sourceFiles: [row.sourceReference] } : null
    });
    delete moved.preliminaryScheduleEvidence;
    target.courses.push(moved);
    const available = new Set((student.courses || []).filter(item => ["completed", "transfer", "in_progress"].includes(item.status)).map(item => item.code));
    for (const term of candidate.terms) {
      for (const item of term.courses) {
        delete item.approvalRequired;
        const approvals = policy.rules.filter(rule => rule.ruleType === "permissionException"
          && rule.condition.dependentCourse === item.course).flatMap(rule =>
          (rule.condition.concurrentOptions || []).filter(code => !available.has(code)
            && term.courses.some(other => other.course === code)).map(code => ({
            ruleId: rule.ruleId, authority: rule.effect.approvalAuthority,
            course: item.course, prerequisite: code, term: term.term,
            reason: "Concurrent prerequisite requires approval", sourceRef: rule.sourceRefs[0]
          })));
        if (approvals.length) item.approvalRequired = approvals;
      }
      for (const item of term.courses) available.add(item.course);
    }
    return { ...completeOracleAudit(student, candidate),
      duplicateSchedule: plans.find(peer => peer.id !== plan.id && sameCourseTiming(candidate, peer))?.id || null };
  });
  const viable = audits.find(audit => audit.violations.length === 0);
  return { status: viable ? 200 : 422, duplicateSchedule: viable?.duplicateSchedule, evidence: viable
    ? ["FUTURE-UNPUBLISHED-SCHEDULE-PLANNING-PROJECTION", "Independent Oracle: no violations"]
    : audits.flatMap(audit => audit.violations.map(item => item.ruleId || item.code)) };
}

function oracleApproval(approval) {
  const ruleId = approval.ruleId || (approval.code === "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL"
    ? "CONCURRENT-INTERMEDIATE-ECO-461"
    : approval.course === "ECO 213" ? "CONCURRENT-MATH-ECO-213" : "CONCURRENT-MATH-ECO-214");
  return {
    ruleId, type: ruleId === "CONCURRENT-INTERMEDIATE-ECO-461" ? "DEPARTMENT_APPROVAL" : "INSTRUCTOR_APPROVAL",
    authority: approval.authority, course: approval.course, prerequisite: approval.prerequisite ?? null,
    term: approval.term, reason: approval.reason, sourceRef: approval.sourceRef || null
  };
}

function completeOracleAudit(student, plan) {
  const studentCourses = (student.courses || []).filter(course => ["completed", "transfer", "in_progress"].includes(course.status));
  const input = {
    student: {
      academicStanding: student.academicStanding,
      // The requirements auditor counts projected completions; preserve that input,
      // and independently check current-term chronology in expectedMove below.
      completedCourses: studentCourses.map(course => ({ course: course.code, ...(course.status === "in_progress" ? { projectedCompletion: true } : {}) })),
      inProgressCourses: studentCourses.filter(course => course.status === "in_progress").map(course => {
        const placement = placements(plan).find(item => item.course.course === course.code && item.course.fixedInProgress);
        return {
          course: course.code,
          academicYear: course.academicYear || placement?.term.academicYear,
          termKey: course.termKey || placement?.term.termKey
        };
      })
    },
    expectedContext: selectedPlanContext(resolvePlanningContext(student), plan),
    plan: {
      id: plan.id,
      terms: plan.terms.map(term => ({
        ...term,
        reservedOutsideCourseUnits: Number(student.reservedCourseUnits?.[term.slotId] ?? 0),
        reservedOutsideCourseUnitsByProjectedTerm: (() => {
          const year = Number(String(term.academicYear || "").match(/\d{4}/)?.[0]);
          return Number.isFinite(year) ? {
            Fall: Number(student.reservedCourseUnits?.[`fall-${year}`] || 0),
            Winter: Number(student.reservedCourseUnits?.[`winter-${year + 1}`] || 0),
            "Spring/May": Number(student.reservedCourseUnits?.[`spring-${year + 1}`] ?? student.reservedCourseUnits?.[`may-${year + 1}`] ?? 0)
          } : {};
        })(),
        courses: term.courses.filter(course => !course.fixedInProgress).map(course => {
          const stale = (plan.feasibility?.enrollmentConditions || []).some(item => item.type === "stale_availability" && item.course === course.course && item.term === term.term);
          const normalized = {
            ...course,
            canonicalCrossListIdentity: [course.course, ...(course.crossListedAs || [])],
            availability: { ...course.availability, ...(stale ? { freshness: "stale" } : {}) },
            provenance: { verificationDate: course.provenance?.verifiedOn ?? null, sourceReference: course.provenance?.sourceFiles?.[0] ?? null },
            ...(course.course === "ECO 461" && course.residency === "hanover" ? { institution: "Hanover College" } : {}),
            ...(Array.isArray(course.approvalRequired) ? { approvalRequired: course.approvalRequired.map(oracleApproval) } : {})
          };
          if (!normalized.section) delete normalized.section;
          return normalized;
        })
      })),
      requirementClaims: []
    },
    policy: oracleSpecification,
    verifiedSchedule
  };
  const complete = auditExternalEconomicsPlanComplete(input);
  // Prerequisite review can short-circuit the composed audit. Still independently
  // check section conflicts and capacity instead of treating an unchecked family as valid.
  const schedule = checkExternalEconomicsScheduleAndHorizon({ ...input, requirementAllocation: complete.requirementAllocation });
  return { ...complete, valid: complete.valid && schedule.violations.length === 0,
    violations: [...complete.violations, ...schedule.violations] };
}

function assignmentSignature(plan) {
  return placements(plan).map(({ term, course }) => ({ requirementId: course.requirementId || `${course.course}:fixed`, code: course.course, termId: term.slotId })).sort((left, right) => left.requirementId.localeCompare(right.requirementId));
}

function assertAcceptedMove({ student, plan, from, course, destination, result, label }) {
  assert.equal(result.data.plan?.validation?.valid, true, label);
  assert.equal(result.data.planSetValidation?.valid, true, label);
  const before = assignmentSignature(plan);
  const after = assignmentSignature(result.data.plan);
  assert.deepEqual(after, before.map(item => item.requirementId === (course.requirementId || `${course.course}:fixed`)
    ? { ...item, termId: destination.slotId } : item).sort((left, right) => left.requirementId.localeCompare(right.requirementId)), label);
  const moved = placements(result.data.plan).find(item => item.course.requirementId === course.requirementId);
  assert.equal(moved?.term.slotId, destination.slotId, label);
  assert.equal(moved?.course.course, course.course, label);
  const exact = matchingExactSections(course.course, destination);
  if (exact) {
    assert.equal(moved.course.source, "verified-offering", label);
    assert.ok(exact.some(section => section.sectionId.endsWith(`-${moved.course.section}`)), label);
  } else {
    assert.notEqual(moved.course.source, "verified-offering", label);
    assert.equal(moved.course.section || "", "", label);
    assert.equal(moved.course.availability, null, label);
    assert.equal(moved.course.meeting, null, label);
  }
  const policyCheck = oracleEvaluateCanonicalPlan(policy, student, result.data.plan);
  const fixedPaths = new Set(result.data.plan.terms.flatMap((term, termIndex) => term.courses.flatMap((item, courseIndex) => (
    item.fixedInProgress ? [`$.terms[${termIndex}].courses[${courseIndex}]`] : []
  ))));
  const policyBlocks = policyCheck.findings.filter(item => (
    ["BLOCK", "UNKNOWN"].includes(item.status)
    && !(item.reasonCode === "UNKNOWN_REQUIREMENT" && fixedPaths.has(item.path))
  ));
  assert.deepEqual(policyBlocks, [], `${label}: canonical policy decision mismatch`);
  const complete = completeOracleAudit(student, result.data.plan);
  if (!complete.valid) {
    assert.deepEqual(complete.violations, [], `${label}: ${JSON.stringify(placements(result.data.plan).flatMap(item => item.course.approvalRequired || []))}`);
    if (complete.status === "POLICY_REVIEW") {
      assert.ok(complete.reviewItems.length > 0 && complete.reviewItems.every(item => item.code === "SCHEDULE_SECTION_FULL_REVIEW"), label);
      assert.ok(result.data.plan.validation.reviewFindings?.some(item => item.reasonCode === "ENROLLMENT_FULL"), label);
    } else {
      assert.equal(complete.status, "REVIEW_REQUIRED", `${label} ${JSON.stringify(complete.reviewItems)}`);
      assert.ok(complete.reviewItems.some(item => item.code === "REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE"), label);
      assert.ok(complete.reviewItems.every(item => ["REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE", "RULE_FAMILY_NOT_CHECKED"].includes(item.code)), label);
    }
  }
  assert.equal(from.courses.includes(course), true, label);
}

test(`course-to-term move matrix [${fullMode ? "full" : "PR"}]`, async t => {
  const coverage = { profiles: 0, plans: 0, pairs: 0, listed: 0, hidden: 0, accepted: 0, rejected: 0, may2027: 0, capstone: 0, capstoneAccepted: 0, capstoneRejected: 0, fixed: 0 };
  const expectedCells = new Set();
  const exercisedCells = new Set();
  const uncoveredProfiles = [];
  const findings = [];
  for (const [profileName, student] of profiles) {
    if (profileFilter && profileName !== profileFilter) continue;
    const generated = await post({ student });
    assert.equal(generated.status, 200, `${profileName}: ${JSON.stringify(generated.data)}`);
    const economics = generated.data.programs.find(item => item.program?.id === "economics-base");
    const plans = economics?.economicsPlans || [];
    if (!plans.length && fullMode) {
      uncoveredProfiles.push({ profile: profileName, reason: economics?.economicsPlanResult?.category || "NO_GENERATED_PLAN" });
      continue;
    }
    assert.ok(plans.length, `${profileName}: no complete generated plan`);
    coverage.profiles += 1;
    for (const plan of plans) {
      coverage.plans += 1;
      const original = structuredClone(plan);
      for (const { term: source, course: sourceCourse } of placements(plan)) for (const target of plan.terms) {
        if (target !== source) expectedCells.add(`${profileName}|${plan.id}|${sourceCourse.requirementId || sourceCourse.course}|${source.slotId}|${target.slotId}`);
      }
      for (const { term: from, course } of placements(plan)) for (const destination of plan.terms) {
        if (destination === from) continue;
        const expected = expectedMove(student, plan, from, course, destination, plans);
        const listed = !course.fixedInProgress;
        exercisedCells.add(`${profileName}|${plan.id}|${course.requirementId || course.course}|${from.slotId}|${destination.slotId}`);
        const label = JSON.stringify({ profile: profileName, plan: plan.id, course: course.course, source: from.slotId, destination: destination.slotId, listed, expected: expected.status, evidence: expected.evidence });
        const result = await post({ action: "validate-plan", student, plan, plans, edit: moveEdit(plan, from, course, destination) });
        coverage.pairs += 1;
        coverage[listed ? "listed" : "hidden"] += 1;
        if (destination.slotId === "spring-2027") coverage.may2027 += 1;
        if (course.course === "ECO 461") {
          coverage.capstone += 1;
          coverage[result.status === 200 ? "capstoneAccepted" : "capstoneRejected"] += 1;
        }
        if (course.fixedInProgress) coverage.fixed += 1;
        coverage[result.status === 200 ? "accepted" : "rejected"] += 1;
        try {
          if (expected.status === 200 && expected.duplicateSchedule && result.status === 422) {
            // Academic validity does not override the existing distinct-plan contract.
            // Independently establish identical coursework timing before accepting this reason.
            assert.match(result.data.error, /same material schedule/, label);
          } else {
            assert.equal(result.status, expected.status, `${label}: independent expected outcome differs from API`);
          }
          if (result.status === 200) {
            assert.equal(listed, true, `${label}: a hidden destination was accepted`);
            assertAcceptedMove({ student, plan, from, course, destination, result, label });
          } else {
            assert.equal(result.status, 422, `${label}: unexpected HTTP ${result.status}`);
            assert.match(result.data.error || "", /\S.{20,}/, `${label}: missing student-facing reason`);
            assert.doesNotMatch(result.data.error, /^The plan edit could not be validated\.?$/i, label);
          }
          assert.deepEqual(plan, original, `${label}: validation mutated the source plan`);
        } catch (error) {
          findings.push({ cell: label, actualStatus: result.status, error: result.data.error || null, failure: String(error.message).slice(0, 1200) });
        }
      }
    }
  }
  for (const key of (profileFilter ? ["profiles", "plans", "pairs"] : ["profiles", "plans", "pairs", "listed", "hidden", "accepted", "rejected", "may2027", "capstone", "capstoneAccepted", "capstoneRejected", "fixed"])) {
    assert.ok(coverage[key] > 0, `Missing move-matrix coverage: ${key}`);
  }
  const uncoveredCells = [...expectedCells].filter(cell => !exercisedCells.has(cell));
  t.diagnostic(JSON.stringify({ mode: fullMode ? "full" : "PR", profileFilter, coverage, uncoveredCells, uncoveredProfiles, findingCount: findings.length, findings }));
  assert.deepEqual(uncoveredCells, [], "Generated course-to-term cells were not exercised");
  assert.equal(findings.length, 0, `${findings.length} move cells failed; first: ${JSON.stringify(findings[0])}`);
});

test("an invalid move leaves the plan usable for two consecutive valid moves", async () => {
  const student = profiles.find(([name]) => name === "early")[1];
  const generated = await post({ student });
  const plans = generated.data.programs.find(item => item.program.id === "economics-base").economicsPlans;
  let plan = plans.find(item => item.id === "one-year-early");
  const source = placements(plan).find(item => item.course.course === "ECO 113");
  const invalidDestination = plan.terms.find(term => term.slotId === "fall-2027");
  const before = structuredClone(plan);
  const rejected = await post({ action: "validate-plan", student, plan, plans, edit: moveEdit(plan, source.term, source.course, invalidDestination) });
  assert.equal(rejected.status, 422);
  assert.match(rejected.data.error, /ECO 213 is missing prerequisites: ECO 113/);
  assert.deepEqual(plan, before);
  for (const [fromId, toId] of [["spring-2027", "winter-2027"], ["winter-2027", "spring-2027"]]) {
    const from = plan.terms.find(term => term.slotId === fromId);
    const destination = plan.terms.find(term => term.slotId === toId);
    const course = from.courses.find(item => item.course === "MAT 217");
    assert.ok(course, `MAT 217 missing from ${fromId}`);
    const result = await post({ action: "validate-plan", student, plan, plans: plans.map(item => item.id === plan.id ? plan : item), edit: moveEdit(plan, from, course, destination) });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assertAcceptedMove({ student, plan, from, course, destination, result, label: `${fromId} -> ${toId}` });
    plan = result.data.plan;
  }
  assert.deepEqual(assignmentSignature(plan), assignmentSignature(before));
});

test("malformed requests fail and forged evidence cannot confirm a future offering", async () => {
  const student = profiles.find(([name]) => name === "early")[1];
  const generated = await post({ student });
  const plans = generated.data.programs.find(item => item.program.id === "economics-base").economicsPlans;
  const plan = plans.find(item => item.id === "one-year-early");
  const original = structuredClone(plan);
  const from = plan.terms.find(term => term.courses.some(course => course.course === "ECO 222"));
  const course = from.courses.find(item => item.course === "ECO 222");
  const destination = plan.terms.find(term => term.slotId === "winter-2028");
  const forged = structuredClone(plan);
  forged.terms.find(term => term.slotId === from.slotId).courses.find(item => item.requirementId === course.requirementId).moveTermIds = [from.slotId, destination.slotId];
  const forgedResult = await post({ action: "validate-plan", student, plan: forged, plans, edit: { ...moveEdit(plan, from, course, destination), source: "verified-offering", section: "J" } });
  assert.equal(forgedResult.status, 422, JSON.stringify(forgedResult.data));
  assert.match(forgedResult.data.error || "", /projected only in MAY when its schedule is unpublished/);
  for (const edit of [
    { ...moveEdit(plan, from, course, destination), fromTermId: "missing-term" },
    { ...moveEdit(plan, from, course, destination), toTermId: "missing-term" },
    { ...moveEdit(plan, from, course, destination), courseId: "missing-course" }
  ]) {
    const result = await post({ action: "validate-plan", student, plan, plans, edit });
    assert.equal(result.status, 422, JSON.stringify(edit));
    assert.match(result.data.error || "", /\S.{20,}/);
  }
  const staleStudent = { ...student, courses: [{ code: "ECO 222", status: "completed" }] };
  const stale = await post({ action: "validate-plan", student: staleStudent, plan, plans, edit: moveEdit(plan, from, course, destination) });
  assert.equal(stale.status, 422);
  assert.match(stale.data.error, /Regenerate your plans/);
  const malformed = await post({ action: "validate-plan", student, edit: moveEdit(plan, from, course, destination) });
  assert.equal(malformed.status, 400);
  assert.deepEqual(plan, original);
});

test(`shrinking move sequences preserve the selected plan [seed=20260923; ${fullMode ? 50 : 8} runs]`, async () => {
  const student = profiles.find(([name]) => name === "early")[1];
  const generated = await post({ student });
  const plans = generated.data.programs.find(item => item.program.id === "economics-base").economicsPlans;
  const startingPlan = plans.find(item => item.id === "one-year-early");
  const commands = fc.array(fc.tuple(fc.nat(100), fc.nat(100)), { minLength: 2, maxLength: fullMode ? 8 : 4 });
  await fc.assert(fc.asyncProperty(commands, async sequence => {
    let current = structuredClone(startingPlan);
    for (const [courseIndex, termIndex] of sequence) {
      const chosen = placements(current)[courseIndex % placements(current).length];
      const destination = current.terms[termIndex % current.terms.length];
      if (chosen.term.slotId === destination.slotId) continue;
      const before = structuredClone(current);
      const result = await post({ action: "validate-plan", student, plan: current, plans: plans.map(plan => plan.id === current.id ? current : plan), edit: moveEdit(current, chosen.term, chosen.course, destination) });
      const label = JSON.stringify({ seed: 20260923, sequence, course: chosen.course.course, from: chosen.term.slotId, to: destination.slotId });
      assert.deepEqual(current, before, `${label}: request mutated input`);
      const expected = expectedMove(student, current, chosen.term, chosen.course, destination, plans);
      if (expected.status === 200 && expected.duplicateSchedule && result.status === 422) {
        assert.match(result.data.error, /same material schedule/, label);
      } else assert.equal(result.status, expected.status, `${label}: ${JSON.stringify(expected)}`);
      if (result.status === 200) {
        assertAcceptedMove({ student, plan: current, from: chosen.term, course: chosen.course, destination, result, label });
        current = result.data.plan;
      } else {
        assert.equal(result.status, 422, label);
        assert.match(result.data.error || "", /\S.{20,}/, label);
      }
    }
  }), { seed: 20260923, numRuns: fullMode ? 50 : 8, verbose: 2 });
});
