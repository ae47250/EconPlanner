import test from "node:test";
import assert from "node:assert/strict";
import { loadPolicyBundle } from "../lib/policy/load-bundle.js";
import { evaluateOffering, evaluatePrerequisites, evaluateRequirementAllocation, evaluateTermLoad, normalizeStudentFacts } from "../lib/decision-engine/index.js";
import { loadCanonicalPolicy, oracleEvaluateAllocation, oracleEvaluateOffering, oracleEvaluatePrerequisite, oracleEvaluateTermLoad } from "./oracle/load-canonical-policy.js";

const [bundle, oracle] = await Promise.all([
  loadPolicyBundle({ allowPending: true }),
  loadCanonicalPolicy()
]);
const facts = normalizeStudentFacts({ courses: [] });

test("allocation decisions agree for every core choice and the ECO 257 negative case", () => {
  const cases = [
    ["ECO 113", "eco-113"], ["ECO 257", "statistics"], ["MAT 217", "statistics"],
    ["BUSN 323", "finance"], ["MAT 121", "cognate"], ["ECO 260", "eco-elective-1"],
    ["ECO 257", "eco-elective-1"]
  ];
  for (const [course, requirement] of cases) {
    const production = evaluateRequirementAllocation(course, requirement, facts, bundle, { traceId: "differential" });
    const independent = oracleEvaluateAllocation(oracle, course, requirement);
    assert.equal(production.status, independent.status, `${course}/${requirement}`);
    assert.equal(production.reasonCode, independent.reasonCode, `${course}/${requirement}`);
  }
});

test("prerequisite decisions agree across prior, missing, and concurrent evidence", () => {
  const cases = [
    { course: "ECO 213", available: [], sameTerm: [], approvals: [] },
    { course: "ECO 213", available: ["ECO 113", "MAT 113"], sameTerm: [], approvals: [] },
    { course: "ECO 213", available: ["ECO 113"], sameTerm: ["ECO 213", "MAT 113"], approvals: [{ course: "ECO 213", prerequisite: "MAT 113", type: "INSTRUCTOR_APPROVAL" }] },
    { course: "ECO 331", available: ["ECO 213"], sameTerm: [], approvals: [] }
  ];
  for (const item of cases) {
    const production = evaluatePrerequisites({ course: item.course, approvalRequired: item.approvals }, {}, facts, bundle, { traceId: "differential", availableCourses: new Set(item.available), sameTermCourses: new Set(item.sameTerm) });
    const independent = oracleEvaluatePrerequisite(oracle, item.course, item);
    assert.equal(production.status, independent.status, JSON.stringify(item));
    assert.equal(production.reasonCode, independent.reasonCode, JSON.stringify(item));
  }
});

test("offering and term-load states agree including FULL and preliminary", () => {
  const offeringCases = [
    [{ course: "ECO 113", section: "A", source: "verified-offering" }, { academicYear: "2026-2027", termKey: "Fall" }],
    [{ course: "ECO 234", section: "A", source: "verified-offering" }, { academicYear: "2026-2027", termKey: "Fall" }],
    [{ course: "ECO 213", source: "projected-offering" }, { academicYear: "2027-2028", termKey: "Fall" }]
  ];
  for (const [course, term] of offeringCases) {
    assert.equal(evaluateOffering(course, term, bundle.indexes.offeringByTerm, bundle, { traceId: "differential" }).status, oracleEvaluateOffering(oracle, course, term).status);
  }
  const termCases = [
    { termKey: "Fall", academicYear: "2026-2027", courses: [{ course: "ECO 221" }] },
    { termKey: "May", academicYear: "2026-2027", courses: [{ course: "ECO 260" }, { course: "ECO 234" }] }
  ];
  for (const term of termCases) assert.equal(evaluateTermLoad(term, {}, bundle, { traceId: "differential" }).status, oracleEvaluateTermLoad(oracle, term).status);
});
