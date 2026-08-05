import {
  canonicalExternalTermKey,
  externalTermPosition,
  parseExternalAcademicYear
} from "./plan-signature.js";

const ORACLE_SOURCE = "tests/oracle/economics-policy.v1.json";
const PLACEHOLDER_OPTION_GROUPS = new Map([
  ["MATHEMATICS COGNATE", new Set(["MAT 113", "MAT 121"])],
  ["STATISTICS REQUIREMENT", new Set(["ECO 257", "MAT 217", "PSY 217"])]
]);

const UNCHECKED_FAMILIES = Object.freeze([
  "SCHEDULE",
  "CAPACITY",
  "GRADUATION_RULES"
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function upper(value) {
  return text(value).toUpperCase();
}

function sameText(left, right) {
  return upper(left) === upper(right);
}

function allPolicyRules(policy) {
  return [
    policy?.prerequisiteRules,
    policy?.concurrencyRules,
    policy?.permissionRules,
    policy?.capstoneRules,
    policy?.unresolvedPolicyQuestions
  ].flatMap(group => (Array.isArray(group) ? group : []));
}

function ruleById(policy, ruleId) {
  return allPolicyRules(policy).find(rule => rule.ruleId === ruleId) || null;
}

function ruleSource(policy, ruleId) {
  const refs = ruleById(policy, ruleId)?.sourceRefs;
  return Array.isArray(refs) && refs.length ? refs.join(", ") : ORACLE_SOURCE;
}

function makeFinding(policy, ruleId, objectPath, message, extra = {}) {
  return {
    code: ruleId,
    ruleId,
    objectPath,
    message,
    sourceReference: ruleSource(policy, ruleId),
    ...extra
  };
}

function termLabel(termKey, academicYear) {
  const parsed = parseExternalAcademicYear(academicYear);
  if (!parsed.valid) return "";
  if (termKey === "Fall") return `Fall ${parsed.startYear}`;
  if (termKey === "Winter") return `Winter ${parsed.endYear}`;
  if (termKey === "Spring/May") return `Spring/May ${parsed.endYear}`;
  if (termKey === "Summer") return `Summer ${parsed.endYear}`;
  return "";
}

function evidencePosition(entry) {
  if (entry.state === "completed") return Number.NEGATIVE_INFINITY;
  const termPosition = externalTermPosition(entry.academicYear, entry.termKey);
  if (termPosition === null) return null;
  if (entry.termKey !== "TBC") return termPosition;
  const projectedRank = new Map([["Fall", 0], ["Winter", 1], ["Spring", 2], ["May", 2], ["Spring/May", 2]]);
  return projectedRank.has(entry.projectedTerm)
    ? termPosition + projectedRank.get(entry.projectedTerm) / 10
    : termPosition + Math.floor(Number(entry.planningSequence || 0) / 100) / 10;
}

function collectEvidence(student, plan) {
  const entries = [];
  const addStudentEntries = (values, state, field) => {
    (Array.isArray(values) ? values : []).forEach((value, index) => {
      const item = typeof value === "string" ? { course: value } : value;
      if (!isObject(item) || !upper(item.course)) return;
      const termKey = canonicalExternalTermKey(item.termKey || item.term);
      const entry = {
        ...item,
        course: upper(item.course),
        state,
        termKey,
        academicYear: text(item.academicYear),
        termLabel: text(item.term) || termLabel(termKey, item.academicYear),
        objectPath: `$.student.${field}[${index}]`,
        attachedApprovals: Array.isArray(item.approvalRequired) ? item.approvalRequired : []
      };
      entry.position = evidencePosition(entry);
      entries.push(entry);
    });
  };

  addStudentEntries(student?.completedCourses, "completed", "completedCourses");
  addStudentEntries(student?.inProgressCourses, "inProgress", "inProgressCourses");

  (Array.isArray(plan?.terms) ? plan.terms : []).forEach((term, termIndex) => {
    const termKey = canonicalExternalTermKey(term?.termKey || term?.term);
    (Array.isArray(term?.courses) ? term.courses : []).forEach((course, courseIndex) => {
      if (!isObject(course) || !upper(course.course)) return;
      const entry = {
        ...course,
        course: upper(course.course),
        state: "planned",
        termKey,
        academicYear: text(term.academicYear),
        termLabel: text(term.term) || termLabel(termKey, term.academicYear),
        projectedStanding: course.projectedStanding || term.projectedStanding,
        objectPath: `$.plan.terms[${termIndex}].courses[${courseIndex}]`,
        attachedApprovals: Array.isArray(course.approvalRequired) ? course.approvalRequired : []
      };
      entry.position = evidencePosition(entry);
      entries.push(entry);
    });
  });
  return entries;
}

function collectApprovals(plan, entries) {
  const approvals = [];
  entries.forEach(entry => {
    entry.attachedApprovals.forEach((approval, index) => {
      if (!isObject(approval)) return;
      approvals.push({
        ...approval,
        objectPath: `${entry.objectPath}.approvalRequired[${index}]`,
        attachedCourse: entry.course,
        attachedTerm: entry.termLabel
      });
    });
  });
  const planApprovals = [
    ...(Array.isArray(plan?.requiredApprovals) ? plan.requiredApprovals : []),
    ...(Array.isArray(plan?.feasibility?.requiredApprovals)
      ? plan.feasibility.requiredApprovals
      : [])
  ];
  planApprovals.forEach((approval, index) => {
    if (!isObject(approval)) return;
    approvals.push({
      ...approval,
      objectPath: `$.plan.requiredApprovals[${index}]`,
      attachedCourse: null,
      attachedTerm: null
    });
  });
  return approvals;
}

function collectClaims(entries, policy) {
  const reviewItems = [];
  const claims = [];
  entries.forEach(entry => {
    (Array.isArray(entry.prerequisiteClaims) ? entry.prerequisiteClaims : []).forEach((claim, index) => {
      if (!isObject(claim)) return;
      const kind = text(claim.kind).toLowerCase();
      if (!["waiver", "substitution", "equivalency"].includes(kind)) return;
      const specificEquivalent = entry.course === "ECO 335"
        && kind === "equivalency"
        && sameText(claim.prerequisite, "MAT 121");
      const ruleId = specificEquivalent
        ? "REVIEW-ECO-335-MATH-EQUIVALENT"
        : "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE";
      const rule = ruleById(policy, ruleId);
      const normalized = {
        ...claim,
        kind,
        dependentCourse: entry.course,
        prerequisite: upper(claim.prerequisite),
        objectPath: `${entry.objectPath}.prerequisiteClaims[${index}]`,
        ruleId
      };
      claims.push(normalized);
      reviewItems.push({
        ...makeFinding(
          policy,
          ruleId,
          normalized.objectPath,
          `${kind} evidence does not create automatic prerequisite credit.`
        ),
        status: rule?.status || "ADVISOR_CONFIRMATION_REQUIRED"
      });
    });
  });
  return { claims, reviewItems };
}

function claimCovers(claims, dependentCourse, prerequisites) {
  const options = new Set(prerequisites.map(upper));
  return claims.some(claim => (
    claim.dependentCourse === dependentCourse && options.has(claim.prerequisite)
  ));
}

function hasEarlierEvidence(entries, course, dependentPosition) {
  return entries.some(entry => (
    entry.course === upper(course)
    && entry.position !== null
    && entry.position < dependentPosition
  ));
}

function hasCompletedEvidence(entries, course) {
  return entries.some(entry => entry.state === "completed" && entry.course === upper(course));
}

function placeholderCoversGroup(entry, group) {
  if (entry.state !== "planned" || entry.source !== "requirement-placeholder") return false;
  const declaredGroup = PLACEHOLDER_OPTION_GROUPS.get(entry.course);
  const declaredOptions = new Set((entry.options || []).map(upper));
  return Boolean(declaredGroup)
    && group.every(option => declaredGroup.has(upper(option)))
    && group.every(option => declaredOptions.has(upper(option)));
}

function hasEarlierGroupEvidence(entries, group, dependentPosition) {
  return group.some(prerequisite => hasEarlierEvidence(entries, prerequisite, dependentPosition))
    || entries.some(entry => (
      entry.position !== null
      && entry.position < dependentPosition
      && placeholderCoversGroup(entry, group)
    ));
}

function samePositionEntries(entries, courses, position) {
  const options = new Set(courses.map(upper));
  return entries.filter(entry => options.has(entry.course) && entry.position === position);
}

function approvalType(policy, rule) {
  if ((policy.permissionRules || []).some(candidate => candidate.ruleId === rule.ruleId)) {
    return "DEPARTMENT_PERMISSION";
  }
  return /instructor/iu.test(rule.approvalAuthority)
    ? "INSTRUCTOR_APPROVAL"
    : "DEPARTMENT_APPROVAL";
}

function expectedApproval(policy, rule, dependent, prerequisite) {
  return {
    ruleId: rule.ruleId,
    type: approvalType(policy, rule),
    authority: rule.approvalAuthority,
    course: dependent.course,
    prerequisite: prerequisite === null ? null : upper(prerequisite),
    term: dependent.termLabel,
    sourceRefs: rule.sourceRefs || []
  };
}

function consumeApproval({ policy, approvals, usedApprovals, rule, dependent, prerequisite, violations }) {
  const expected = expectedApproval(policy, rule, dependent, prerequisite);
  const approvalIndex = approvals.findIndex((approval, index) => (
    !usedApprovals.has(index) && approval.ruleId === rule.ruleId
  ));
  if (approvalIndex < 0) {
    violations.push(makeFinding(
      policy,
      rule.ruleId,
      dependent.objectPath,
      `${rule.ruleId} requires complete approval metadata.`
    ));
    return false;
  }

  usedApprovals.add(approvalIndex);
  const approval = approvals[approvalIndex];
  const checks = [
    [approval.type === expected.type, "type"],
    [sameText(approval.authority, expected.authority), "authority"],
    [upper(approval.course) === expected.course, "course"],
    [expected.prerequisite === null
      ? Object.hasOwn(approval, "prerequisite") && approval.prerequisite === null
      : upper(approval.prerequisite) === expected.prerequisite, "prerequisite"],
    [sameText(approval.term, expected.term), "term"],
    [Boolean(text(approval.reason)), "reason"],
    [expected.sourceRefs.includes(approval.sourceRef), "sourceRef"],
    [approval.attachedCourse === null || approval.attachedCourse === expected.course, "attachment course"],
    [approval.attachedTerm === null || sameText(approval.attachedTerm, expected.term), "attachment term"]
  ];
  for (const [valid, field] of checks) {
    if (valid) continue;
    violations.push(makeFinding(
      policy,
      rule.ruleId,
      approval.objectPath,
      `${rule.ruleId} approval metadata has an incorrect or missing ${field}.`
    ));
  }
  return checks.every(([valid]) => valid);
}

function validateHistoricalPrerequisites({ policy, entries, claims, reviewItems }) {
  const completed = entries.filter(entry => entry.state === "completed");
  const completedCodes = new Set(completed.map(entry => entry.course));
  const rulesByCourse = new Map((policy.prerequisiteRules || []).map(rule => [upper(rule.course), rule]));
  for (const entry of completed) {
    const rule = rulesByCourse.get(entry.course);
    if (!rule) continue;
    const missingAll = (rule.allOf || []).filter(course => !completedCodes.has(upper(course)));
    const missingGroups = (rule.oneOfGroups || []).filter(group => (
      !group.some(course => completedCodes.has(upper(course)))
    ));
    const claimedMissing = [
      ...missingAll.filter(course => claimCovers(claims, entry.course, [course])),
      ...missingGroups.flat().filter(course => claimCovers(claims, entry.course, [course]))
    ];
    const unclaimedMissing = [
      ...missingAll.filter(course => !claimedMissing.includes(course)),
      ...missingGroups.filter(group => !claimCovers(claims, entry.course, group)).flat()
    ];
    if (!unclaimedMissing.length) continue;
    const reviewRuleId = "REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE";
    const reviewRule = ruleById(policy, reviewRuleId);
    reviewItems.push({
      ...makeFinding(
        policy,
        reviewRuleId,
        entry.objectPath,
        `Completed ${entry.course} is missing prerequisite records; the oracle does not infer ${unclaimedMissing.join(", ")}.`
      ),
      status: reviewRule?.status || "POLICY_REVIEW_REQUIRED"
    });
  }
}

function validateNormalRule({ policy, entries, claims, approvals, usedApprovals, entry, rule, violations }) {
  if (!Number.isFinite(entry.position)) {
    violations.push(makeFinding(
      policy,
      rule.ruleId,
      entry.objectPath,
      `${entry.course} needs a valid chronological position.`
    ));
    return;
  }

  for (const prerequisite of rule.allOf || []) {
    if (hasEarlierEvidence(entries, prerequisite, entry.position)) continue;
    if (claimCovers(claims, entry.course, [prerequisite])) continue;
    violations.push(makeFinding(
      policy,
      rule.ruleId,
      entry.objectPath,
      `${prerequisite} must be completed before ${entry.course}.`
    ));
  }

  for (const group of rule.oneOfGroups || []) {
    if (hasEarlierGroupEvidence(entries, group, entry.position)) continue;
    if (claimCovers(claims, entry.course, group)) continue;
    const concurrencyRule = (policy.concurrencyRules || []).find(candidate => (
      upper(candidate.course) === entry.course
      && samePositionEntries(entries, candidate.concurrentOptions || [], entry.position).length === 1
    ));
    if (concurrencyRule) {
      const concurrent = samePositionEntries(
        entries,
        concurrencyRule.concurrentOptions || [],
        entry.position
      )[0];
      consumeApproval({
        policy,
        approvals,
        usedApprovals,
        rule: concurrencyRule,
        dependent: entry,
        prerequisite: concurrent.course,
        violations
      });
      continue;
    }
    violations.push(makeFinding(
      policy,
      rule.ruleId,
      entry.objectPath,
      `One of ${group.join(", ")} must be completed before ${entry.course}.`
    ));
  }
}

function seniorEligible(entry, student, expectedContext) {
  if (entry.state === "inProgress" && sameText(student?.academicStanding, "Senior")) return true;
  const year = parseExternalAcademicYear(entry.academicYear);
  if (!year.valid) return false;
  const rawEntryAcademicYearStart = expectedContext?.entryAcademicYearStart;
  const entryAcademicYearStart = Number(rawEntryAcademicYearStart);
  const hasCanonicalEntryYear = rawEntryAcademicYearStart !== null
    && rawEntryAcademicYearStart !== undefined
    && rawEntryAcademicYearStart !== ""
    && Number.isInteger(entryAcademicYearStart);
  const reachesFourthCollegeYear = hasCanonicalEntryYear
    && year.startYear - entryAcademicYearStart >= 3;
  const confirmation = expectedContext?.projectedSeniorStandingConfirmation;
  const confirmedAcademicYear = confirmation?.status === "STUDENT_REPORTED_REGISTRAR_OR_ADVISOR_CONFIRMATION"
    ? String(confirmation.academicYear || "")
    : null;
  const matchesConfirmedAcademicYear = confirmedAcademicYear === `${year.startYear}/${year.endYear}`
    && confirmedAcademicYear === expectedContext?.projectedSeniorStandingAcademicYear;

  if (hasCanonicalEntryYear) {
    return reachesFourthCollegeYear || matchesConfirmedAcademicYear;
  }

  // Older independent fixtures do not contain the v4 horizon fields. Their
  // explicit projected-standing value remains the only available evidence.
  return sameText(entry.projectedStanding, "Senior");
}

function validateCapstone({
  policy,
  entries,
  claims,
  approvals,
  usedApprovals,
  entry,
  student,
  expectedContext,
  violations
}) {
  const winterRule = ruleById(policy, "CAPSTONE-WINTER-ONLY");
  if (entry.termKey !== "TBC" && !winterRule.allowedTerms.map(canonicalExternalTermKey).includes(entry.termKey)) {
    violations.push(makeFinding(
      policy,
      winterRule.ruleId,
      entry.objectPath,
      "ECO 461 must be placed in Winter."
    ));
  }
  const standingRule = ruleById(policy, "CAPSTONE-SENIOR-STANDING");
  if (!seniorEligible(entry, student, expectedContext)) {
    violations.push(makeFinding(
      policy,
      standingRule.ruleId,
      entry.objectPath,
      "ECO 461 requires projected senior standing."
    ));
  }
  const residencyRule = ruleById(policy, "CAPSTONE-HANOVER-RESIDENCY");
  if (!sameText(entry.institution, residencyRule.requiredInstitution)) {
    violations.push(makeFinding(
      policy,
      residencyRule.ruleId,
      entry.objectPath,
      `ECO 461 must be completed at ${residencyRule.requiredInstitution}.`
    ));
  }
  if (!Number.isFinite(entry.position)) return;

  const statisticsRule = ruleById(policy, "CAPSTONE-STATISTICS-BEFORE");
  const statistics = statisticsRule.mustBeCompletedBeforeOneOf || [];
  const statisticsEarlier = hasEarlierGroupEvidence(entries, statistics, entry.position);
  if (!statisticsEarlier && !claimCovers(claims, entry.course, statistics)) {
    violations.push(makeFinding(
      policy,
      statisticsRule.ruleId,
      entry.objectPath,
      "A confirmed statistics option must be completed before ECO 461."
    ));
  }

  const concurrencyRule = ruleById(policy, "CONCURRENT-INTERMEDIATE-ECO-461");
  const intermediates = concurrencyRule.concurrentOptions.map(upper);
  const prior = intermediates.filter(course => hasEarlierEvidence(entries, course, entry.position));
  const concurrent = samePositionEntries(entries, intermediates, entry.position);
  if (prior.length === 2) return;

  if (concurrent.length !== 1) {
    violations.push(makeFinding(
      policy,
      concurrent.length > 1 ? concurrencyRule.ruleId : "PREREQ-ECO-461",
      entry.objectPath,
      concurrent.length > 1
        ? "At most one intermediate may be concurrent with ECO 461."
        : "ECO 213 and ECO 214 must be completed before ECO 461 unless the one-course exception applies."
    ));
    return;
  }

  const concurrentCourse = concurrent[0].course;
  const otherCourse = intermediates.find(course => course !== concurrentCourse);
  if (!hasCompletedEvidence(entries, otherCourse)) {
    violations.push(makeFinding(
      policy,
      concurrencyRule.ruleId,
      entry.objectPath,
      `${otherCourse} must already be recorded as completed for the ECO 461 concurrency exception.`
    ));
    return;
  }
  consumeApproval({
    policy,
    approvals,
    usedApprovals,
    rule: concurrencyRule,
    dependent: entry,
    prerequisite: concurrentCourse,
    violations
  });
}

function validatePermissions({ policy, entries, approvals, usedApprovals, violations }) {
  for (const rule of policy.permissionRules || []) {
    entries
      .filter(entry => entry.state !== "completed" && entry.course === upper(rule.course))
      .forEach(entry => consumeApproval({
        policy,
        approvals,
        usedApprovals,
        rule,
        dependent: entry,
        prerequisite: null,
        violations
      }));
  }
}

function validateUnusedApprovals(policy, approvals, usedApprovals, violations) {
  approvals.forEach((approval, index) => {
    if (usedApprovals.has(index)) return;
    const ruleId = ruleById(policy, approval.ruleId)
      ? approval.ruleId
      : "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE";
    violations.push(makeFinding(
      policy,
      ruleId,
      approval.objectPath,
      "Approval metadata is attached where no matching confirmed exception or permission applies."
    ));
  });
}

export function checkExternalEconomicsPrerequisites(input) {
  const args = isObject(input) ? input : {};
  const policy = isObject(args.policy) ? args.policy : {};
  const student = isObject(args.student) ? args.student : {};
  const plan = isObject(args.plan) ? args.plan : {};
  const requiredCollections = [
    "prerequisiteRules",
    "concurrencyRules",
    "permissionRules",
    "capstoneRules",
    "unresolvedPolicyQuestions"
  ];
  const missingCollections = requiredCollections.filter(name => !Array.isArray(policy[name]));
  if (missingCollections.length) {
    return prerequisiteResult({
      violations: [makeFinding(
        policy,
        "REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE",
        "$.policy",
        `The independent policy is missing ${missingCollections.join(", ")}.`
      )]
    });
  }

  const entries = collectEvidence(student, plan);
  const approvals = collectApprovals(plan, entries);
  const claims = collectClaims(entries, policy);
  const violations = [];
  const reviewItems = [...claims.reviewItems];
  const usedApprovals = new Set();
  const rulesByCourse = new Map(policy.prerequisiteRules.map(rule => [upper(rule.course), rule]));

  validateHistoricalPrerequisites({ policy, entries, claims: claims.claims, reviewItems });
  for (const entry of entries.filter(item => item.state !== "completed")) {
    const prerequisiteRule = rulesByCourse.get(entry.course);
    if (entry.course === "ECO 461") {
      validateCapstone({
        policy,
        entries,
        claims: claims.claims,
        approvals,
        usedApprovals,
        entry,
        student,
        expectedContext: args.expectedContext,
        violations
      });
    } else if (prerequisiteRule) {
      validateNormalRule({
        policy,
        entries,
        claims: claims.claims,
        approvals,
        usedApprovals,
        entry,
        rule: prerequisiteRule,
        violations
      });
    }
  }
  validatePermissions({ policy, entries, approvals, usedApprovals, violations });
  validateUnusedApprovals(policy, approvals, usedApprovals, violations);

  return prerequisiteResult({ violations, reviewItems });
}

function prerequisiteResult({ violations = [], reviewItems = [] }) {
  const uncheckedRuleFamilies = UNCHECKED_FAMILIES.map(family => ({ family, status: "NOT_CHECKED" }));
  const uncheckedReviews = uncheckedRuleFamilies.map(item => ({
    code: "RULE_FAMILY_NOT_CHECKED",
    family: item.family,
    status: item.status,
    message: `${item.family} is intentionally not checked by the Task 5 prerequisite oracle.`
  }));
  const status = violations.length
    ? "INVALID_PREREQUISITES"
    : reviewItems.length
      ? "REVIEW_REQUIRED"
      : "VALID_PREREQUISITES";
  return {
    valid: status === "VALID_PREREQUISITES",
    status,
    violations,
    warnings: [],
    reviewItems: [...reviewItems, ...uncheckedReviews],
    checkedRuleFamilies: [{ family: "PREREQUISITES", status: "CHECKED" }],
    uncheckedRuleFamilies
  };
}
