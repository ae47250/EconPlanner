const REQUIREMENT_SOURCE = "tests/oracle/economics-policy.v1.json";

const REQUIRED_RULE_IDS = Object.freeze([
  "REQ-ECO-113",
  "REQ-ECO-114",
  "REQ-ECO-213",
  "REQ-ECO-214",
  "REQ-STATISTICS",
  "REQ-FINANCE",
  "REQ-ECO-461",
  "REQ-COGNATE",
  "REQ-ECO-ELECTIVES"
]);

const UNCHECKED_FAMILIES = Object.freeze([
  "PREREQUISITES",
  "SCHEDULE",
  "CAPACITY",
  "GRADUATION_RULES"
]);
const SUPPORTING_REQUIREMENT_PLACEHOLDERS = new Map([
  ["STATISTICS REQUIREMENT", "REQ-STATISTICS"],
  ["MATHEMATICS COGNATE", "REQ-COGNATE"],
  ["FINANCE REQUIREMENT", "REQ-FINANCE"]
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizedCourse(value) {
  return normalizedText(value).toUpperCase();
}

function ruleById(policy, ruleId) {
  const groups = [
    policy?.requirementRules,
    policy?.electiveRules,
    policy?.capstoneRules,
    policy?.unresolvedPolicyQuestions
  ];
  for (const group of groups) {
    const rule = Array.isArray(group) ? group.find(item => item.ruleId === ruleId) : null;
    if (rule) return rule;
  }
  return null;
}

function ruleSource(policy, ruleId) {
  const rule = ruleById(policy, ruleId);
  return Array.isArray(rule?.sourceRefs) && rule.sourceRefs.length
    ? rule.sourceRefs.join(", ")
    : REQUIREMENT_SOURCE;
}

function canonicalCourse(code) {
  const normalized = normalizedCourse(code);
  return normalized === "PHI 234" ? "ECO 234" : normalized;
}

function courseNumber(code) {
  const match = canonicalCourse(code).match(/^ECO\s+(\d{3})$/u);
  return match ? Number(match[1]) : null;
}

function electivePlaceholderPolicy(policy) {
  return ruleById(policy, "REQ-ECO-ELECTIVES")?.futurePlaceholder || {};
}

function isGenericElectivePlaceholder(course, policy) {
  const displayLabel = normalizedCourse(electivePlaceholderPolicy(policy).displayLabel || "ECO elective");
  return canonicalCourse(course.course) === displayLabel;
}

function genericPlaceholderRuleId(course, policy) {
  if (isGenericElectivePlaceholder(course, policy)) return "REQ-ECO-ELECTIVES";
  return SUPPORTING_REQUIREMENT_PLACEHOLDERS.get(canonicalCourse(course.course)) || null;
}

function placeholderSlotIdentity(course, policy) {
  if (!genericPlaceholderRuleId(course, policy)) return null;
  const identityFields = electivePlaceholderPolicy(policy).identityFields || [
    "placeholderSlotId",
    "requirementId"
  ];
  for (const field of identityFields) {
    const value = normalizedText(course[field]);
    if (value) return value.toUpperCase();
  }
  return null;
}

function courseIdentity(course, policy) {
  const placeholderIdentity = placeholderSlotIdentity(course, policy);
  const placeholderRuleId = genericPlaceholderRuleId(course, policy);
  if (placeholderRuleId) {
    return `${placeholderRuleId}-PLACEHOLDER#${placeholderIdentity || "MISSING-SLOT-IDENTITY"}`;
  }
  const canonical = canonicalCourse(course.course);
  if (canonical === "ECO 260" && normalizedText(course.repeatableInstanceId)) {
    return `${canonical}#${normalizedText(course.repeatableInstanceId).toUpperCase()}`;
  }
  return canonical;
}

function collectCourses(student, plan, policy) {
  const courses = [];
  const completed = Array.isArray(student?.completedCourses) ? student.completedCourses : [];
  completed.forEach((entry, index) => {
    const course = typeof entry === "string" ? { course: entry } : entry;
    if (!isObject(course) || !normalizedCourse(course.course)) return;
    const placeholderIdentity = placeholderSlotIdentity(course, policy);
    courses.push({
      ...course,
      course: normalizedCourse(course.course),
      canonicalCourse: canonicalCourse(course.course),
      actualCourseIdentity: genericPlaceholderRuleId(course, policy)
        ? null
        : canonicalCourse(course.course),
      placeholderSlotIdentity: placeholderIdentity,
      requirementAllocationIdentity: normalizedText(course.requirementId) || null,
      identity: courseIdentity(course, policy),
      planningState: "completed",
      objectPath: `$.student.completedCourses[${index}]`
    });
  });

  const terms = Array.isArray(plan?.terms) ? plan.terms : [];
  terms.forEach((term, termIndex) => {
    const entries = Array.isArray(term?.courses) ? term.courses : [];
    entries.forEach((course, courseIndex) => {
      if (!isObject(course) || !normalizedCourse(course.course)) return;
      const placeholderIdentity = placeholderSlotIdentity(course, policy);
      courses.push({
        ...course,
        course: normalizedCourse(course.course),
        canonicalCourse: canonicalCourse(course.course),
        actualCourseIdentity: genericPlaceholderRuleId(course, policy)
          ? null
          : canonicalCourse(course.course),
        placeholderSlotIdentity: placeholderIdentity,
        requirementAllocationIdentity: normalizedText(course.requirementId) || null,
        identity: courseIdentity(course, policy),
        planningState: genericPlaceholderRuleId(course, policy) ? "placeholder" : "planned",
        objectPath: `$.plan.terms[${termIndex}].courses[${courseIndex}]`
      });
    });
  });
  return courses;
}

function makeSlots(policy) {
  const slots = [];
  for (const ruleId of REQUIRED_RULE_IDS) {
    const rule = ruleById(policy, ruleId);
    if (!rule) continue;
    const count = ruleId === "REQ-ECO-ELECTIVES" ? 4 : 1;
    for (let index = 0; index < count; index += 1) {
      slots.push({
        slotId: count === 1 ? ruleId : `${ruleId}#${index + 1}`,
        ruleId,
        options: Array.isArray(rule.options) ? rule.options.map(normalizedCourse) : [],
        attributes: ruleId === "REQ-ECO-461"
          ? { requiredInstitution: ruleById(policy, "CAPSTONE-HANOVER-RESIDENCY")?.requiredInstitution }
          : {}
      });
    }
  }
  return slots;
}

function isElectiveCandidate(course, policy) {
  if (isGenericElectivePlaceholder(course, policy)) {
    return course.planningState === "placeholder" && Boolean(course.placeholderSlotIdentity);
  }
  const code = course.canonicalCourse;
  const statisticsOnlyRule = ruleById(policy, "ELECTIVE-ECO-257-STATISTICS-ONLY");
  if (statisticsOnlyRule?.status === "CONFIRMED"
    && code === canonicalCourse(statisticsOnlyRule.course)
    && statisticsOnlyRule.excludedRequirementRuleIds?.includes("REQ-ECO-ELECTIVES")) {
    return false;
  }
  if (code === "ECO 307") return false;
  if (!code.startsWith("ECO ")) return false;
  if (Number.isFinite(course.units) && course.units < 1) return false;
  return Boolean(courseNumber(code));
}

function courseMatchesSlot(course, slot, policy) {
  const placeholderRuleId = genericPlaceholderRuleId(course, policy);
  if (placeholderRuleId) {
    return course.planningState === "placeholder"
      && Boolean(course.placeholderSlotIdentity)
      && slot.ruleId === placeholderRuleId;
  }
  if (slot.ruleId === "REQ-ECO-ELECTIVES") return isElectiveCandidate(course, policy);
  return slot.options.includes(course.canonicalCourse);
}

function allocationSignature(allocation) {
  const fixed = allocation
    .filter(item => item.ruleId !== "REQ-ECO-ELECTIVES")
    .map(item => `${item.ruleId}:${item.courseIdentity}`)
    .sort();
  const electives = allocation
    .filter(item => item.ruleId === "REQ-ECO-ELECTIVES")
    .map(item => item.courseIdentity)
    .sort();
  return [...fixed, `REQ-ECO-ELECTIVES:${electives.join(",")}`].join("|");
}

function exhaustiveAllocations(courses, slots, policy) {
  const candidates = slots.map(slot => courses
    .map((course, courseIndex) => ({ course, courseIndex }))
    .filter(({ course }) => courseMatchesSlot(course, slot, policy)));
  const order = slots
    .map((slot, slotIndex) => ({ slot, slotIndex, candidateCount: candidates[slotIndex].length }))
    .sort((left, right) => left.candidateCount - right.candidateCount
      || left.slot.slotId.localeCompare(right.slot.slotId));
  const results = [];
  const seenResults = new Set();
  const assigned = new Map();
  const usedCourseIndexes = new Set();
  const usedIdentities = new Set();

  function visit(position) {
    if (position === order.length) {
      const finance = assigned.get("REQ-FINANCE");
      const electives = [...assigned.entries()]
        .filter(([slotId]) => slotId.startsWith("REQ-ECO-ELECTIVES#"))
        .map(([, value]) => value.course);
      if (electives.some(course => course.canonicalCourse === "ECO 321")
        && finance?.course.canonicalCourse !== "BUSN 323") return;
      const oneHundredLevelCount = electives.filter(course => {
        const number = courseNumber(course.canonicalCourse);
        return number !== null && number >= 100 && number < 200;
      }).length;
      if (oneHundredLevelCount > 1) return;

      const allocation = slots.map(slot => {
        const selected = assigned.get(slot.slotId);
        return {
          slotId: slot.slotId,
          ruleId: slot.ruleId,
          course: selected.course.course,
          canonicalCourse: selected.course.canonicalCourse,
          actualCourseIdentity: selected.course.actualCourseIdentity,
          placeholderSlotIdentity: selected.course.placeholderSlotIdentity,
          requirementAllocationIdentity: selected.course.requirementAllocationIdentity,
          planningState: selected.course.planningState,
          offeringSource: normalizedText(selected.course.source) || null,
          courseIdentity: selected.course.identity,
          coursePath: selected.course.objectPath,
          attributes: slot.attributes
        };
      });
      const signature = allocationSignature(allocation);
      if (!seenResults.has(signature)) {
        seenResults.add(signature);
        results.push(allocation);
      }
      return;
    }

    const { slot, slotIndex } = order[position];
    for (const candidate of candidates[slotIndex]) {
      if (usedCourseIndexes.has(candidate.courseIndex) || usedIdentities.has(candidate.course.identity)) continue;
      assigned.set(slot.slotId, candidate);
      usedCourseIndexes.add(candidate.courseIndex);
      usedIdentities.add(candidate.course.identity);
      visit(position + 1);
      usedIdentities.delete(candidate.course.identity);
      usedCourseIndexes.delete(candidate.courseIndex);
      assigned.delete(slot.slotId);
    }
  }

  visit(0);
  return { results, candidates };
}

function requirementClaims(plan, policy) {
  const reviewItems = [];
  const coveredRuleIds = new Set();
  const claims = Array.isArray(plan?.requirementClaims) ? plan.requirementClaims : [];
  claims.forEach((claim, index) => {
    if (!isObject(claim)) return;
    const kind = normalizedText(claim.kind).toLowerCase();
    if (!["waiver", "substitution", "equivalency"].includes(kind)) return;
    const targetRuleId = normalizedText(claim.targetRuleId);
    if (targetRuleId) coveredRuleIds.add(targetRuleId);
    const requestedReviewRuleId = normalizedText(claim.reviewRuleId);
    const reviewRuleId = ruleById(policy, requestedReviewRuleId)
      ? requestedReviewRuleId
      : "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE";
    const rule = ruleById(policy, reviewRuleId);
    reviewItems.push({
      code: reviewRuleId,
      ruleId: reviewRuleId,
      status: rule?.status || "ADVISOR_CONFIRMATION_REQUIRED",
      objectPath: `$.plan.requirementClaims[${index}]`,
      targetRuleId: targetRuleId || null,
      message: `${kind} credit is not assigned automatically; the approved scope and authority require review.`,
      sourceReference: ruleSource(policy, reviewRuleId)
    });
  });
  return { reviewItems, coveredRuleIds };
}

function violation(ruleId, objectPath, message, policy) {
  return {
    code: ruleId,
    ruleId,
    objectPath,
    message,
    sourceReference: ruleSource(policy, ruleId)
  };
}

function diagnoseFailure(courses, slots, candidates, coveredRuleIds, policy) {
  const violations = [];
  const missingSlots = slots.filter((slot, slotIndex) => candidates[slotIndex].length === 0);
  for (const slot of missingSlots) {
    if (coveredRuleIds.has(slot.ruleId)) continue;
    violations.push(violation(
      slot.ruleId,
      "$.plan",
      `${slot.slotId} has no eligible course.`,
      policy
    ));
  }

  const electiveHints = courses.filter(course => /elective/iu.test(normalizedText(course.requirementId)));
  const hinted307 = electiveHints.find(course => course.canonicalCourse === "ECO 307");
  if (hinted307) violations.push(violation(
    "REQ-ECO-ELECTIVES",
    hinted307.objectPath,
    "ECO 307 is a half-unit directed study and does not fill a normal full-unit elective slot.",
    policy
  ));
  const hintedOutsideEco = electiveHints.find(course => ["MAT 217", "PSY 217"].includes(course.canonicalCourse));
  if (hintedOutsideEco) violations.push(violation(
    "REQ-ECO-ELECTIVES",
    hintedOutsideEco.objectPath,
    `${hintedOutsideEco.course} may satisfy statistics but is not an ECO elective.`,
    policy
  ));

  const statisticsOnlyRule = ruleById(policy, "ELECTIVE-ECO-257-STATISTICS-ONLY");
  const hintedStatisticsOnly = electiveHints.find(course => (
    course.canonicalCourse === canonicalCourse(statisticsOnlyRule?.course)
  ));
  if (hintedStatisticsOnly) violations.push(violation(
    "ELECTIVE-ECO-257-STATISTICS-ONLY",
    hintedStatisticsOnly.objectPath,
    "ECO 257 may satisfy only the statistics requirement and is not an Economics elective.",
    policy
  ));

  const crossListEntries = courses.filter(course => course.canonicalCourse === "ECO 234");
  if (crossListEntries.length > 1 && electiveHints.filter(course => course.canonicalCourse === "ECO 234").length > 1) {
    violations.push(violation(
      "ELECTIVE-CROSSLIST-ECO-234-PHI-234",
      "$.plan",
      "ECO 234 and PHI 234 share one canonical identity and can count only once.",
      policy
    ));
  }

  const fixedEconomicsCourses = new Set(["ECO 113", "ECO 114", "ECO 213", "ECO 214", "ECO 461"]);
  const eligibleElectives = courses.filter(course => (
    isElectiveCandidate(course, policy) && !fixedEconomicsCourses.has(course.canonicalCourse)
  ));
  const uniqueElectives = new Map(eligibleElectives.map(course => [course.identity, course]));
  if (uniqueElectives.size < 4) {
    violations.push(violation(
      "REQ-ECO-ELECTIVES",
      "$.plan",
      `Only ${uniqueElectives.size} distinct qualifying elective slots are available; four are required.`,
      policy
    ));
  }

  const identityCounts = new Map();
  for (const course of courses) identityCounts.set(course.identity, (identityCounts.get(course.identity) || 0) + 1);
  if ([...identityCounts.values()].some(count => count > 1)) {
    violations.push(violation(
      "ELECTIVE-NO-DOUBLE-COUNT",
      "$.plan",
      "An actual course or future placeholder slot may fill at most one requirement slot.",
      policy
    ));
  }

  const oneHundredLevel = [...uniqueElectives.values()].filter(course => {
    const number = courseNumber(course.canonicalCourse);
    return number !== null && number >= 100 && number < 200;
  });
  const nonOneHundredLevelCount = uniqueElectives.size - oneHundredLevel.length;
  if (uniqueElectives.size >= 4 && nonOneHundredLevelCount < 3) {
    violations.push(violation(
      "ELECTIVE-MAX-ONE-100-LEVEL",
      "$.plan",
      "Four electives cannot be allocated without using more than one 100-level ECO course.",
      policy
    ));
  }

  const eco321 = courses.find(course => course.canonicalCourse === "ECO 321");
  const busn323 = courses.find(course => course.canonicalCourse === "BUSN 323");
  if (eco321 && !busn323 && electiveHints.some(course => course.canonicalCourse === "ECO 321")) {
    violations.push(violation(
      "REQ-FINANCE",
      eco321.objectPath,
      "ECO 321 can be an elective only when BUSN 323 fills the finance slot.",
      policy
    ));
    if (/finance/iu.test(normalizedText(eco321.requirementId))) violations.push(violation(
      "ELECTIVE-NO-DOUBLE-COUNT",
      eco321.objectPath,
      "ECO 321 may not fill both the finance slot and an elective slot.",
      policy
    ));
  }

  if (!violations.length && !coveredRuleIds.size) {
    violations.push(violation(
      "REQ-MAJOR-COURSE-COUNT",
      "$.plan",
      "The supplied courses cannot fill all 11 major slots and the cognate slot exactly once.",
      policy
    ));
  }
  return violations;
}

export function checkExternalEconomicsRequirements(input) {
  const args = isObject(input) ? input : {};
  const policy = isObject(args.policy) ? args.policy : {};
  const plan = isObject(args.plan) ? args.plan : {};
  const student = isObject(args.student) ? args.student : {};
  const missingManifestRules = [...REQUIRED_RULE_IDS, "ELECTIVE-SLOT-UNIQUE-ASSIGNMENT"].filter(ruleId => !ruleById(policy, ruleId));
  if (missingManifestRules.length) {
    const violations = missingManifestRules.map(ruleId => violation(
      ruleId,
      "$.policy",
      `The policy manifest is missing ${ruleId}.`,
      policy
    ));
    return requirementResult({ violations });
  }

  const courses = collectCourses(student, plan, policy);
  const slots = makeSlots(policy);
  const claims = requirementClaims(plan, policy);
  const capstone = courses.find(course => course.canonicalCourse === "ECO 461");
  const residencyViolation = capstone
    && normalizedText(capstone.institution).toLowerCase() !== "hanover college"
    ? violation(
      "CAPSTONE-HANOVER-RESIDENCY",
      capstone.objectPath,
      "ECO 461 must identify Hanover College as the institution of completion.",
      policy
    )
    : null;
  const { results, candidates } = exhaustiveAllocations(courses, slots, policy);
  const violations = residencyViolation ? [residencyViolation] : [];
  if (!results.length && !residencyViolation) {
    violations.push(...diagnoseFailure(courses, slots, candidates, claims.coveredRuleIds, policy));
  }
  // Audit the submitted assignments independently of the alternative allocations
  // above. Raw history carries course evidence, not declared plan slot ownership.
  const assignmentRule = ruleById(policy, "ELECTIVE-SLOT-UNIQUE-ASSIGNMENT");
  const electiveSlotIds = new Set(assignmentRule?.electiveSlotIds || []);
  const assignedSlots = new Set();
  const assignmentViolations = [];
  const submittedTerms = Array.isArray(plan.terms) ? plan.terms : [];
  for (const [termIndex, term] of submittedTerms.entries()) {
    const submittedCourses = Array.isArray(term?.courses) ? term.courses : [];
    for (const [courseIndex, course] of submittedCourses.entries()) {
      const slotId = normalizedText(course?.requirementId);
      if (!electiveSlotIds.has(slotId)) continue;
      if (assignedSlots.has(slotId)) assignmentViolations.push(violation(
        assignmentRule.ruleId,
        `$.plan.terms[${termIndex}].courses[${courseIndex}].requirementId`,
        `Elective slot ${slotId} is assigned more than once in this submitted plan.`,
        policy
      ));
      assignedSlots.add(slotId);
    }
  }
  // A waiver of academic credit cannot waive malformed submitted assignments.
  const uncoveredViolations = [
    ...violations.filter(item => !claims.coveredRuleIds.has(item.ruleId)),
    ...assignmentViolations
  ];

  return requirementResult({
    allocations: residencyViolation ? [] : results,
    violations: uncoveredViolations,
    reviewItems: claims.reviewItems
  });
}

function requirementResult({ allocations = [], violations = [], reviewItems = [] }) {
  const uncheckedRuleFamilies = UNCHECKED_FAMILIES.map(family => ({ family, status: "NOT_CHECKED" }));
  const remainingReviewItems = uncheckedRuleFamilies.map(item => ({
    code: "RULE_FAMILY_NOT_CHECKED",
    family: item.family,
    status: item.status,
    message: `${item.family} is intentionally not checked by the Task 4 requirement oracle.`
  }));
  const status = violations.length
    ? "INVALID_REQUIREMENTS"
    : reviewItems.length
      ? "REVIEW_REQUIRED"
      : allocations.length
        ? "VALID_REQUIREMENTS"
        : "INVALID_REQUIREMENTS";
  return {
    valid: status === "VALID_REQUIREMENTS",
    status,
    violations,
    warnings: [],
    reviewItems: [...reviewItems, ...remainingReviewItems],
    allocation: allocations.length ? allocations[0] : null,
    allocations,
    checkedRuleFamilies: [{ family: "REQUIREMENT_ALLOCATION", status: "CHECKED" }],
    uncheckedRuleFamilies
  };
}
