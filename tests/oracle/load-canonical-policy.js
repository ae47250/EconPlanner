import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

export async function loadCanonicalPolicy({ repositoryRoot = DEFAULT_ROOT } = {}) {
  const manifest = await readJson(repositoryRoot, "policy/manifest/econ-2025-2026.1.json");
  const documents = {};
  for (const input of manifest.inputs) documents[input.id] = await readJson(repositoryRoot, input.path);
  const rules = Object.values(documents).flatMap(document => document.records || []).filter(rule => rule.status === "ACTIVE").toSorted((left, right) => left.ruleId.localeCompare(right.ruleId));
  return Object.freeze({
    manifest,
    documents,
    rules,
    byRuleId: Object.fromEntries(rules.map(rule => [rule.ruleId, rule])),
    courses: documents.courses.courses,
    schedule: documents["schedule-2026-2027"],
    offeringPatterns: documents["offering-patterns"].patterns,
    messages: documents["messages-en-US"].messages,
    provenance: documents.provenance,
    unresolved: documents.unresolved.questions
  });
}

const REQUIREMENT_RULE = Object.freeze({
  "eco-113": "REQ-ECO-113", "eco-114": "REQ-ECO-114", "eco-213": "REQ-ECO-213", "eco-214": "REQ-ECO-214",
  statistics: "REQ-STATISTICS", finance: "REQ-FINANCE", "eco-461": "REQ-ECO-461", cognate: "REQ-COGNATE"
});

function requirementRuleId(requirementId) {
  return String(requirementId || "").startsWith("eco-elective") ? "REQ-ECO-ELECTIVES" : REQUIREMENT_RULE[requirementId];
}

export function oracleEvaluateAllocation(policy, course, requirementId) {
  const placement = typeof course === "object" ? course : { course };
  const code = String(placement.course || "").toUpperCase();
  const ruleId = requirementRuleId(requirementId);
  const rule = policy.byRuleId[ruleId];
  if (!rule) return { status: "UNKNOWN", ruleIds: [], reasonCode: "UNKNOWN_REQUIREMENT" };
  if (placement.source === "requirement-placeholder" && Array.isArray(placement.options)) {
    return (rule.effect.options || []).every(option => placement.options.includes(option))
      ? { status: "ALLOW", ruleIds: [ruleId], reasonCode: "REQUIREMENT_PLACEHOLDER_OPTIONS_MATCH" }
      : { status: "BLOCK", ruleIds: [ruleId], reasonCode: "COURSE_NOT_ELIGIBLE_FOR_REQUIREMENT" };
  }
  if (ruleId === "REQ-ECO-ELECTIVES") {
    const excluded = ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "ECO 257", "ECO 307", "ECO 461"];
    return excluded.includes(code) || !(code.startsWith("ECO ") || code === "PHI 234" || code === "ECO ELECTIVE")
      ? { status: "BLOCK", ruleIds: [code === "ECO 257" ? "ELECTIVE-ECO-257-STATISTICS-ONLY" : ruleId], reasonCode: code === "ECO 257" ? "ECO_257_STATISTICS_ONLY" : "COURSE_NOT_ELIGIBLE_FOR_REQUIREMENT" }
      : { status: "ALLOW", ruleIds: [ruleId], reasonCode: "REQUIREMENT_OPTION_MATCH" };
  }
  return (rule.effect.options || []).includes(code)
    ? { status: "ALLOW", ruleIds: [ruleId], reasonCode: "REQUIREMENT_OPTION_MATCH" }
    : { status: "BLOCK", ruleIds: [ruleId], reasonCode: "COURSE_NOT_ELIGIBLE_FOR_REQUIREMENT" };
}

function approvalsCover(approvals, course, prerequisite, authority) {
  return approvals.some(approval => {
    if (approval.approvalId) {
      return approval.status === "APPROVED"
        && String(approval.scope?.course || "").toUpperCase() === course
        && String(approval.ruleId || "").includes(authority === "INSTRUCTOR" ? "MATH" : "INTERMEDIATE")
        && String(approval.authority || "").toUpperCase().includes(authority);
    }
    return String(approval.course || course).toUpperCase() === course
      && String(approval.prerequisite || "").toUpperCase() === prerequisite
      && String(approval.type || approval.authority || "").toUpperCase().includes(authority)
      && (!approval.authority || String(approval.authority).toUpperCase().includes(authority));
  });
}

export function oracleEvaluatePrerequisite(policy, course, { available = [], sameTerm = [], approvals = [] } = {}) {
  const code = String(course || "").toUpperCase();
  const availableSet = new Set(available.map(value => String(value).toUpperCase()));
  const sameTermSet = new Set(sameTerm.map(value => String(value).toUpperCase()));
  const rule = policy.rules.find(candidate => candidate.ruleType === "coursePrerequisite" && candidate.condition.course === code);
  if (!rule) return { status: "ALLOW", ruleIds: [], reasonCode: "NO_DECLARED_PREREQUISITE" };
  const concurrentApprovalCovers = prerequisite => {
    const permission = policy.rules.find(candidate => candidate.ruleType === "permissionException"
      && candidate.condition.dependentCourse === code
      && (candidate.condition.concurrentOptions || []).includes(prerequisite));
    return Boolean(permission && sameTermSet.has(prerequisite)
      && approvalsCover(approvals, code, prerequisite, permission.ruleId.includes("MATH") ? "INSTRUCTOR" : "DEPARTMENT"));
  };
  const unresolved = [];
  for (const prerequisite of rule.effect.allOf || []) {
    if (!availableSet.has(prerequisite) && !concurrentApprovalCovers(prerequisite)) unresolved.push(prerequisite);
  }
  for (const group of rule.effect.oneOfGroups || []) {
    const normalized = [...group].sort().join("|");
    const placeholderSatisfied = normalized === ["ECO 257", "MAT 217", "PSY 217"].sort().join("|")
      ? availableSet.has("STATISTICS REQUIREMENT")
      : normalized === ["MAT 113", "MAT 121"].sort().join("|")
        ? availableSet.has("MATHEMATICS COGNATE")
        : false;
    if (!placeholderSatisfied && !group.some(prerequisite => availableSet.has(prerequisite) || concurrentApprovalCovers(prerequisite))) unresolved.push(...group);
  }
  return unresolved.length
    ? { status: "BLOCK", ruleIds: [rule.ruleId], reasonCode: "PREREQUISITE_NOT_SATISFIED", missing: [...new Set(unresolved)] }
    : { status: "ALLOW", ruleIds: [rule.ruleId], reasonCode: "PREREQUISITES_SATISFIED" };
}

function canonicalTerm(term) {
  const value = String(term || "").toUpperCase();
  return ["SPRING", "SPRING/MAY", "MAY", "MAY TERM"].includes(value) ? "MAY" : value;
}

function termId(term) {
  const key = canonicalTerm(term.termKey || term.term);
  const years = String(term.academicYear || "").match(/(\d{4})\D+(\d{4})/);
  return years ? `${key === "FALL" ? years[1] : years[2]}-${key}` : null;
}

export function oracleEvaluateOffering(policy, course, term) {
  const normalizeCode = value => String(value || "").trim().toUpperCase();
  course = { ...course, course: normalizeCode(course.course) };
  term = { ...term, courses: (term.courses || []).map(row => ({ ...row, course: normalizeCode(row.course) })) };
  const key = canonicalTerm(term.termKey || term.term);
  const sections = policy.schedule.terms.find(row => row.termId === termId(term))?.sections || [];
  const verified = code => sections.some(row => row.course === code || (row.crossListedAs || []).includes(code));
  const block = (id, reason) => ({ status: "BLOCK", ruleIds: [id], reasonCode: reason });
  const capstone = policy.byRuleId["CAPSTONE-WINTER-ONLY"];
  if (course.course === capstone.condition.course && key !== "TBC" && !capstone.effect.allowedCanonicalTerms.includes(key)) {
    return block(capstone.ruleId, capstone.reasonCode);
  }
  const may = policy.byRuleId["PLANNING-MAY-COURSE-EXCLUSIONS"];
  if (key === may.condition.canonicalTerm && may.effect.excludedCourses.includes(course.course)
    && !(may.override.permitted && may.override.authority === "ACTIVE_EXACT_SCHEDULE" && verified(course.course))) {
    return block(may.ruleId, may.reasonCode);
  }
  for (const pattern of policy.offeringPatterns) {
    const codes = [pattern.course].flat();
    if (!codes.includes(course.course)) continue;
    if (pattern.hardExcludedTerms.includes(key) && !(pattern.projectionPolicy.activeExactScheduleOverrides && verified(course.course))) {
      return block(pattern.patternId, "COURSE_TERM_EXCLUDED");
    }
    const others = (term.courses || []).filter(row => row.course !== course.course && codes.includes(row.course));
    if (key !== "TBC" && pattern.projectionPolicy.sameTerm === "REQUIRE_MATCHING_VERIFIED_SECTIONS"
      && others.length && !(verified(course.course) && others.every(row => verified(row.course)))) {
      return block(pattern.patternId, "INTERMEDIATE_SAME_TERM_REQUIRES_VERIFIED_SCHEDULE");
    }
  }
  if (course.source === "requirement-placeholder") {
    return { status: "PRELIMINARY", ruleIds: ["PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY"], reasonCode: "UNPUBLISHED_OFFERING_TBC" };
  }
  const releaseTerm = policy.schedule.terms.find(candidate => candidate.termId === termId(term));
  if (!releaseTerm && ["catalog-statement", "recurring-rule-unconfirmed", "historical-pattern"].includes(course.source)) {
    const key = canonicalTerm(term.termKey || term.term);
    const year = termId(term)?.split("-")[0];
    let supported = false;
    if (course.source === "historical-pattern") {
      const records = policy.documents["historical-offerings"]?.records || [];
      supported = records.some(record => record.courseIdentity === course.course
        && record.activationStatus === "ACTIVE_OWNER_APPROVED" && record.ownerApproval?.approved === true
        && Object.keys(record.conditionalTermDistribution || {}).includes(key));
    } else {
      const capstone = policy.byRuleId["CAPSTONE-WINTER-ONLY"];
      supported = course.source === "recurring-rule-unconfirmed" && course.course === capstone.condition.course
        && capstone.effect.allowedCanonicalTerms.includes(key) && Boolean(year)
        && capstone.effective.from <= `${year}-01-01`
        && (!capstone.effective.through || capstone.effective.through >= `${year}-12-31`);
      for (const pattern of policy.offeringPatterns) {
        if (![pattern.course].flat().includes(course.course)) continue;
        if (pattern.evidenceType !== (course.source === "catalog-statement" ? "OFFICIAL_CATALOG_STATEMENT" : "DEPARTMENT_RECURRING")) continue;
        if (!pattern.authorityBoundary || !pattern.sourceRefs?.length) continue;
        if (!pattern.approvedRecurringTerms.includes(key) || pattern.hardExcludedTerms.includes(key)) continue;
        if (!pattern.projectionPolicy.scheduleCoverage.some(coverage => coverage === "UNKNOWN" || coverage === "UNAVAILABLE")) continue;
        if (!year || !(pattern.effective.from <= `${year}-01-01`)) continue;
        if (pattern.effective.through && pattern.effective.through < `${year}-12-31`) continue;
        if (policy.offeringPatterns.some(replacement => replacement.supersedes.includes(pattern.patternId))) continue;
        supported = true;
      }
    }
    if (!supported) return { status: "UNKNOWN", ruleIds: [], reasonCode: "PROJECTION_EVIDENCE_OUT_OF_SCOPE" };
    return { status: "ALLOW", ruleIds: ["FUTURE-UNPUBLISHED-SCHEDULE-PLANNING-PROJECTION"], reasonCode: "FUTURE_SCHEDULE_PLANNING_PROJECTION" };
  }
  if (!releaseTerm && ["future-placeholder", "projected-offering"].includes(course.source)) {
    return { status: "ALLOW", ruleIds: ["FUTURE-UNPUBLISHED-SCHEDULE-PLANNING-PROJECTION"], reasonCode: "FUTURE_SCHEDULE_PLANNING_PROJECTION" };
  }
  if (!releaseTerm) return { status: "UNKNOWN", ruleIds: [], reasonCode: "SCHEDULE_TERM_NOT_COVERED" };
  const section = releaseTerm.sections.find(candidate => (candidate.course === course.course || candidate.crossListedAs.includes(course.course))
    && (!course.section || candidate.sectionId.endsWith(`-${course.section}`)));
  if (!section) return { status: releaseTerm.coverage === "COMPLETE" ? "BLOCK" : "UNKNOWN", ruleIds: ["SCHEDULE-AVAILABILITY-BEHAVIOR"], reasonCode: releaseTerm.coverage === "COMPLETE" ? "NOT_OFFERED_IN_COMPLETE_SCHEDULE" : "OFFERING_UNKNOWN" };
  const outcome = policy.byRuleId["SCHEDULE-AVAILABILITY-BEHAVIOR"].effect[section.enrollmentState];
  return { status: outcome === "VERIFIED" ? "ALLOW" : outcome === "BLOCK" ? "BLOCK" : outcome === "CONDITIONAL" ? "CONDITIONAL" : outcome === "PRELIMINARY" ? "PRELIMINARY" : outcome, ruleIds: ["SCHEDULE-AVAILABILITY-BEHAVIOR"], reasonCode: `ENROLLMENT_${section.enrollmentState}` };
}

export function oracleEvaluateTermLoad(policy, term) {
  const key = canonicalTerm(term.termKey || term.term);
  if (key === "TBC") return { status: "PRELIMINARY", ruleIds: ["PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY"], reasonCode: "TERM_LOAD_TO_BE_CONFIRMED" };
  const rule = policy.rules.find(candidate => candidate.ruleType === "termLoad" && candidate.condition.canonicalTerm === key);
  if (!rule) return { status: "UNKNOWN", ruleIds: [], reasonCode: "TERM_CAPACITY_RULE_MISSING" };
  const economics = (term.courses || []).filter(course => String(course.course).startsWith("ECO ") || course.course === "ECO elective").length;
  const blocked = term.courses.length > rule.effect.maxTotalCourses || (rule.effect.maxEconomicsCourses && economics > rule.effect.maxEconomicsCourses);
  return { status: blocked ? "BLOCK" : "ALLOW", ruleIds: [rule.ruleId], reasonCode: blocked ? "TERM_CAPACITY_EXCEEDED" : "TERM_CAPACITY_AVAILABLE" };
}

export function oracleEvaluateCanonicalPlan(policy, student, plan) {
  const findings = [];
  const available = new Set((student.courses || []).filter(course => ["completed", "transfer", "in_progress"].includes(course.status)).map(course => String(course.code).toUpperCase()));
  for (const [termIndex, term] of (plan.terms || []).entries()) {
    const isTbc = canonicalTerm(term.termKey || term.term) === "TBC";
    findings.push({ path: `$.terms[${termIndex}]`, ...oracleEvaluateTermLoad(policy, term) });
    if (isTbc) {
      const projectedGroups = new Map();
      for (const course of term.courses || []) {
        const projectedTerm = course.projectedTerm || "TBC";
        projectedGroups.set(projectedTerm, [...(projectedGroups.get(projectedTerm) || []), course]);
      }
      for (const [projectedTerm, courses] of projectedGroups) {
        if (projectedTerm !== "TBC") findings.push({ path: `$.terms[${termIndex}]`, ...oracleEvaluateTermLoad(policy, { ...term, termKey: projectedTerm, courses }) });
      }
    }
    const indexedCourses = (term.courses || []).map((course, courseIndex) => ({ course, courseIndex }));
    const orderedCourses = isTbc
      ? indexedCourses.toSorted((left, right) => Number(left.course.planningSequence ?? Number.MAX_SAFE_INTEGER)
        - Number(right.course.planningSequence ?? Number.MAX_SAFE_INTEGER))
      : indexedCourses;
    let currentProjectedTerm = null;
    let pendingCourses = [];
    for (const { course, courseIndex } of orderedCourses) {
      if (isTbc && currentProjectedTerm !== null && course.projectedTerm !== currentProjectedTerm) {
        for (const pending of pendingCourses) available.add(String(pending).toUpperCase());
        pendingCourses = [];
      }
      if (isTbc) currentProjectedTerm = course.projectedTerm || `sequence-${course.planningSequence}`;
      const sameTerm = (term.courses || [])
        .filter(candidate => !isTbc || (candidate !== course && candidate.projectedTerm === course.projectedTerm))
        .flatMap(candidate => candidate.source === "requirement-placeholder" && Array.isArray(candidate.options)
          ? candidate.options
          : [candidate.course]);
      const path = `$.terms[${termIndex}].courses[${courseIndex}]`;
      findings.push({ path, ...oracleEvaluateAllocation(policy, course, course.requirementId) });
      findings.push({ path, ...oracleEvaluateOffering(policy, course, term) });
      if (course.course !== "ECO elective" && !String(course.source).includes("placeholder")) findings.push({ path, ...oracleEvaluatePrerequisite(policy, course.course, { available: [...available], sameTerm, approvals: course.approvalRequired || [] }) });
      if (isTbc) pendingCourses.push(course.course);
    }
    if (isTbc) {
      for (const pending of pendingCourses) available.add(String(pending).toUpperCase());
    } else {
      for (const course of term.courses || []) available.add(String(course.course).toUpperCase());
    }
  }
  const status = findings.some(item => item.status === "BLOCK") ? "BLOCK"
    : findings.some(item => item.status === "UNKNOWN") ? "UNKNOWN"
      : findings.some(item => item.status === "REVIEW_REQUIRED") ? "REVIEW_REQUIRED"
        : findings.some(item => item.status === "PRELIMINARY") ? "PRELIMINARY"
          : findings.some(item => item.status === "CONDITIONAL") ? "CONDITIONAL" : "ALLOW";
  return { status, valid: !["BLOCK", "UNKNOWN"].includes(status), findings };
}
