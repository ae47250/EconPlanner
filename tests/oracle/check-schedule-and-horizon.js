import {
  canonicalExternalTermKey,
  externalTermPosition
} from "./plan-signature.js";

const POLICY_SOURCE = "tests/oracle/economics-policy.v1.json";
const SCHEDULE_SOURCE = "tests/oracle/verified-schedule-2026-2027.json";
const VERIFIED_SOURCE = "verified-offering";
const PRELIMINARY_SOURCES = new Set([
  "projected-offering",
  "catalog-statement",
  "future-placeholder",
  "requirement-placeholder",
  "recurring-rule-unconfirmed",
  "unverified-offering",
  "summer-last-resort"
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

function normalizeYear(value) {
  const match = text(value).match(/^(\d{4})[-/](\d{4})$/u);
  return match ? `${match[1]}-${match[2]}` : "";
}

function normalizeTerm(value) {
  const term = canonicalExternalTermKey(value);
  return term === "Spring/May" ? "May" : term;
}

function policyRule(policy, ruleId) {
  return [
    ...(policy?.planningRules || []),
    ...(policy?.scheduleEvidenceRules || []),
    ...(policy?.requirementRules || [])
  ].find(rule => rule.ruleId === ruleId);
}

function sourceFor(policy, ruleId, fallback = POLICY_SOURCE) {
  const refs = policyRule(policy, ruleId)?.sourceRefs;
  return Array.isArray(refs) && refs.length ? refs.join(", ") : fallback;
}

function finding(policy, code, ruleId, objectPath, message, extra = {}) {
  return {
    code,
    ruleId,
    objectPath,
    message,
    sourceReference: sourceFor(policy, ruleId, extra.sourceReference),
    ...extra
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalIdentity(value) {
  return (Array.isArray(value) ? value : []).map(upper).filter(Boolean).sort();
}

function snapshotSection(verifiedSchedule, term, course) {
  const year = normalizeYear(term.academicYear);
  const termKey = normalizeTerm(term.termKey);
  const code = upper(course.course);
  const section = upper(course.section);
  if (normalizeYear(verifiedSchedule?.academicYear) !== year) return null;
  return (verifiedSchedule?.sections || []).find(row => (
    normalizeTerm(row.term) === termKey
    && upper(row.section) === section
    && canonicalIdentity(row.canonicalCrossListIdentity).includes(code)
  )) || null;
}

function embeddedFields(course) {
  return {
    canonicalCrossListIdentity: canonicalIdentity(course.canonicalCrossListIdentity),
    title: text(course.title),
    units: course.units,
    startDate: course.meeting?.startDate ?? course.courseDates?.startDate ?? null,
    endDate: course.meeting?.endDate ?? course.courseDates?.endDate ?? null,
    days: course.meeting?.days ?? null,
    startTime: course.meeting?.startTime ?? null,
    endTime: course.meeting?.endTime ?? null,
    availabilityState: text(course.availability?.state || course.availability?.status).toLowerCase(),
    seatsOpen: course.availability?.seatsOpen ?? null,
    capacity: course.availability?.capacity ?? null,
    verificationDate: course.provenance?.verificationDate ?? course.verificationDate ?? null,
    sourceReference: course.provenance?.sourceReference ?? course.sourceReference ?? null
  };
}

function oracleFields(row) {
  return {
    canonicalCrossListIdentity: canonicalIdentity(row.canonicalCrossListIdentity),
    title: text(row.title),
    units: row.units,
    startDate: row.courseDates?.startDate ?? null,
    endDate: row.courseDates?.endDate ?? null,
    days: row.meeting?.days ?? null,
    startTime: row.meeting?.startTime ?? null,
    endTime: row.meeting?.endTime ?? null,
    availabilityState: text(row.availability?.state).toLowerCase(),
    seatsOpen: row.availability?.seatsOpen ?? null,
    capacity: row.availability?.capacity ?? null,
    verificationDate: row.verificationDate ?? null,
    sourceReference: row.sourceReference ?? null
  };
}

function checkVerifiedPlacement({ policy, verifiedSchedule, term, termIndex, course, courseIndex, violations }) {
  const path = `$.plan.terms[${termIndex}].courses[${courseIndex}]`;
  const row = snapshotSection(verifiedSchedule, term, course);
  if (!row) {
    violations.push(finding(
      policy,
      "SCHEDULE_VERIFIED_SECTION_NOT_FOUND",
      "SCHEDULE-EVIDENCE-SCREENSHOT-FIELDS",
      path,
      `${course.course} ${course.section || "(no section)"} is not in the independent verified schedule snapshot.`,
      { sourceReference: SCHEDULE_SOURCE }
    ));
    return;
  }
  if (course.verificationStatus !== "verified") {
    violations.push(finding(
      policy,
      "SCHEDULE_VERIFICATION_STATUS_MISMATCH",
      "SCHEDULE-EVIDENCE-PROVENANCE",
      `${path}.verificationStatus`,
      "A snapshot-backed placement must explicitly say verificationStatus: verified.",
      { sourceReference: row.sourceReference }
    ));
  }
  const actual = embeddedFields(course);
  const expected = oracleFields(row);
  for (const field of Object.keys(expected)) {
    if (sameValue(actual[field], expected[field])) continue;
    violations.push(finding(
      policy,
      "SCHEDULE_VERIFIED_FIELD_MISMATCH",
      field === "sourceReference" || field === "verificationDate"
        ? "SCHEDULE-EVIDENCE-PROVENANCE"
        : "SCHEDULE-EVIDENCE-SCREENSHOT-FIELDS",
      `${path}.${field}`,
      `${term.academicYear} ${normalizeTerm(term.termKey)} ${course.course} ${course.section}: ${field} does not match the independent snapshot.`,
      {
        sourceReference: row.sourceReference,
        productionValue: actual[field],
        oracleValue: expected[field]
      }
    ));
  }
}

function concreteCourse(code) {
  return /^[A-Z]{2,5}\s+\d{3}[A-Z]?$/u.test(upper(code));
}

function checkOfferingSource({ policy, verifiedSchedule, term, termIndex, course, courseIndex, violations, projections }) {
  const path = `$.plan.terms[${termIndex}].courses[${courseIndex}]`;
  const source = text(course.source);
  const verifiedYear = normalizeYear(term.academicYear) === normalizeYear(verifiedSchedule?.academicYear);
  const electivePlaceholderLabel = policyRule(policy, "REQ-ECO-ELECTIVES")
    ?.futurePlaceholder?.displayLabel || "ECO elective";
  const isGenericElectivePlaceholder = upper(course.course) === upper(electivePlaceholderLabel);
  const isSummerFallback = canonicalExternalTermKey(term.termKey) === "Summer"
    && source === "summer-last-resort";
  if (verifiedYear
    && source !== VERIFIED_SOURCE
    && (concreteCourse(course.course) || isGenericElectivePlaceholder)
    && !isSummerFallback) {
    violations.push(finding(
      policy,
      "SCHEDULE_PROJECTED_SOURCE_IN_VERIFIED_YEAR",
      "PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY",
      `${path}.source`,
      `A named course or generic elective placeholder cannot use a projected source in verified academic year ${term.academicYear}.`,
      { sourceReference: SCHEDULE_SOURCE }
    ));
    return;
  }
  if (source === VERIFIED_SOURCE) {
    checkVerifiedPlacement({ policy, verifiedSchedule, term, termIndex, course, courseIndex, violations });
    return;
  }
  if (!PRELIMINARY_SOURCES.has(source)) {
    violations.push(finding(
      policy,
      "SCHEDULE_FUTURE_SOURCE_NOT_EXPLICIT",
      "PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY",
      `${path}.source`,
      "An unverified offering must use an explicit projected or placeholder source.",
      { sourceReference: POLICY_SOURCE }
    ));
    return;
  }
  projections.push({
    code: "SCHEDULE_FUTURE_PLANNING_PROJECTION",
    ruleId: "FUTURE-UNPUBLISHED-SCHEDULE-PLANNING-PROJECTION",
    objectPath: path,
    message: `${course.course} is an explicit planning projection for an unpublished schedule year.`,
    sourceReference: "OWNER-CONFIRMATION-CP4B-B-FOLLOWUP#PLANNING-FLEXIBILITY"
  });
}

function checkAvailability({ policy, course, path, violations, conditions, warnings, reviewItems }) {
  const state = text(course.availability?.state || course.availability?.status).toLowerCase() || "unknown";
  if (state === "closed") {
    violations.push(finding(
      policy,
      "SCHEDULE_SECTION_CLOSED",
      "SCHEDULE-AVAILABILITY-BEHAVIOR",
      `${path}.availability`,
      `${course.course} ${course.section || ""} is closed and cannot support the plan.`
    ));
  } else if (state === "full") {
    reviewItems.push(finding(
      policy,
      "SCHEDULE_SECTION_FULL_REVIEW",
      "SCHEDULE-AVAILABILITY-BEHAVIOR",
      `${path}.availability`,
      `${course.course} ${course.section || ""} is full and requires review under the unresolved FULL policy.`
    ));
  } else if (state === "waitlisted") {
    conditions.push(finding(
      policy,
      "SCHEDULE_SECTION_WAITLISTED",
      "SCHEDULE-AVAILABILITY-BEHAVIOR",
      `${path}.availability`,
      `${course.course} ${course.section || ""} is waitlisted.`
    ));
  } else if (state !== "open") {
    conditions.push(finding(
      policy,
      "SCHEDULE_AVAILABILITY_UNKNOWN",
      "SCHEDULE-AVAILABILITY-BEHAVIOR",
      `${path}.availability`,
      `${course.course} ${course.section || ""} has unknown availability.`
    ));
  }
  if (text(course.availability?.freshness).toLowerCase() === "stale") {
    const item = finding(
      policy,
      "SCHEDULE_AVAILABILITY_STALE",
      "SCHEDULE-AVAILABILITY-BEHAVIOR",
      `${path}.availability.freshness`,
      `${course.course} ${course.section || ""} has stale availability and must be rechecked.`
    );
    conditions.push(item);
    warnings.push(item);
  }
}

function minutes(value) {
  const match = text(value).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/iu);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (upper(match[3]) === "PM") hour += 12;
  return hour * 60 + Number(match[2]);
}

function datesOverlap(left, right) {
  const leftStart = left.startDate || "0000-01-01";
  const leftEnd = left.endDate || "9999-12-31";
  const rightStart = right.startDate || "0000-01-01";
  const rightEnd = right.endDate || "9999-12-31";
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function meetingOf(course) {
  const start = minutes(course.meeting?.startTime);
  const end = minutes(course.meeting?.endTime);
  return {
    days: new Set(course.meeting?.days || []),
    start,
    end,
    startDate: course.meeting?.startDate ?? course.courseDates?.startDate,
    endDate: course.meeting?.endDate ?? course.courseDates?.endDate
  };
}

function checkMeetingConflicts(policy, term, termIndex, violations) {
  const courses = Array.isArray(term.courses) ? term.courses : [];
  for (let leftIndex = 0; leftIndex < courses.length; leftIndex += 1) {
    const left = meetingOf(courses[leftIndex]);
    if (left.start === null || left.end === null || !left.days.size) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < courses.length; rightIndex += 1) {
      const right = meetingOf(courses[rightIndex]);
      if (right.start === null || right.end === null || !right.days.size) continue;
      const sharesDay = [...left.days].some(day => right.days.has(day));
      if (!sharesDay || !datesOverlap(left, right) || left.start >= right.end || right.start >= left.end) continue;
      violations.push(finding(
        policy,
        "SCHEDULE_MEETING_CONFLICT",
        "SCHEDULE-EVIDENCE-SCREENSHOT-FIELDS",
        `$.plan.terms[${termIndex}].courses[${rightIndex}].meeting`,
        `${courses[leftIndex].course} and ${courses[rightIndex].course} have a direct meeting-time conflict.`
      ));
    }
  }
}

function capacityRule(policy, termKey) {
  const key = termKey === "Spring/May" ? "May" : termKey;
  return (policy?.planningRules || []).find(rule => normalizeTerm(rule.term) === normalizeTerm(key)
    && Number.isFinite(rule.maxTotalCourses));
}

function checkCapacity(policy, term, termIndex, violations) {
  const termKey = canonicalExternalTermKey(term.termKey);
  if (termKey === "TBC") {
    const projectedGroups = new Map();
    for (const course of term.courses || []) {
      const projectedTerm = canonicalExternalTermKey(course.projectedTerm);
      if (!projectedTerm || projectedTerm === "TBC") continue;
      projectedGroups.set(projectedTerm, [...(projectedGroups.get(projectedTerm) || []), course]);
    }
    for (const [projectedTerm, courses] of projectedGroups) {
      checkCapacity(policy, {
        ...term,
        termKey: projectedTerm,
        courses,
        reservedOutsideCourseUnits: term.reservedOutsideCourseUnitsByProjectedTerm?.[projectedTerm] || 0
      }, termIndex, violations);
    }
    return;
  }
  const rule = capacityRule(policy, termKey);
  if (!rule) return;
  const reserved = Number(term.reservedOutsideCourseUnits || 0);
  const planned = (term.courses || []).reduce((sum, course) => (
    sum + (Number.isFinite(course.units) ? Number(course.units) : 1)
  ), 0);
  if (reserved < 0 || !Number.isFinite(reserved)) {
    violations.push(finding(
      policy,
      "CAPACITY_RESERVED_UNITS_INVALID",
      rule.ruleId,
      `$.plan.terms[${termIndex}].reservedOutsideCourseUnits`,
      "Reserved outside-course units must be a nonnegative number."
    ));
  } else if (planned + reserved > rule.maxTotalCourses) {
    violations.push(finding(
      policy,
      "CAPACITY_EXCEEDED",
      rule.ruleId,
      `$.plan.terms[${termIndex}]`,
      `${termKey} has ${planned} planned units plus ${reserved} reserved outside-course units; the confirmed maximum is ${rule.maxTotalCourses}.`
    ));
  }
}

function checkSummer(policy, term, termIndex, violations, reviewItems) {
  if (canonicalExternalTermKey(term.termKey) !== "Summer") return;
  (term.courses || []).forEach((course, courseIndex) => {
    const path = `$.plan.terms[${termIndex}].courses[${courseIndex}]`;
    if (upper(course.course) !== "ECO 113") {
      violations.push(finding(
        policy,
        "SUMMER_COURSE_NOT_CONFIRMED",
        "PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY",
        path,
        "The independent policy does not confirm this course as a Summer fallback."
      ));
      return;
    }
    reviewItems.push({
      code: "SUMMER_ECO113_CONFIRMATION_REQUIRED",
      ruleId: "POLICY_REVIEW_REQUIRED",
      objectPath: path,
      status: "POLICY_REVIEW_REQUIRED",
      message: "ECO 113 is the only possible Summer fallback, but the independent manifest does not yet contain a confirmed Summer rule.",
      sourceReference: POLICY_SOURCE
    });
  });
}

function checkHorizon({ policy, plan, expectedContext, requirementAllocation, violations }) {
  const startYear = expectedContext?.startYear;
  const graduationYear = expectedContext?.expectedGraduationYear;
  if (!Number.isInteger(startYear) || !Number.isInteger(graduationYear)) return;
  const earliest = externalTermPosition(`${startYear}/${startYear + 1}`, "Fall");
  const latest = externalTermPosition(`${graduationYear - 1}/${graduationYear}`, "Spring/May");
  (plan.terms || []).forEach((term, termIndex) => {
    const position = externalTermPosition(term.academicYear, term.termKey);
    if (!Number.isFinite(position) || (position >= earliest && position <= latest)) return;
    violations.push(finding(
      policy,
      "GRADUATION_TERM_OUTSIDE_HORIZON",
      "PLANNING-CURRENT-TERM-EXCLUDED",
      `$.plan.terms[${termIndex}]`,
      "This term is outside the permitted planning horizon or occurs after graduation."
    ));
  });
  const allocation = requirementAllocation?.allocation;
  if (!Array.isArray(allocation) || allocation.length !== 12) {
    violations.push(finding(
      policy,
      "GRADUATION_REQUIREMENTS_INCOMPLETE",
      "REQ-MAJOR-COURSE-COUNT",
      "$.requirementAllocation",
      "All 12 major and cognate requirements must be allocated by the expected graduation term."
    ));
  }
}

function result({ violations, warnings, reviewItems, conditions, projections }) {
  const status = violations.length
    ? "NOT_FEASIBLE"
    : reviewItems.length
      ? "POLICY_REVIEW"
      : conditions.length
          ? "CONDITIONALLY_FEASIBLE"
          : "VERIFIED_FEASIBLE";
  return {
    valid: violations.length === 0 && reviewItems.length === 0,
    status,
    feasibilityStatus: status,
    violations,
    warnings,
    reviewItems,
    enrollmentConditions: conditions,
    preliminaryFindings: [],
    projectionFindings: projections,
    checkedRuleFamilies: ["SCHEDULE", "CAPACITY", "GRADUATION_RULES"].map(
      family => ({ family, status: "CHECKED" })
    ),
    uncheckedRuleFamilies: []
  };
}

export function checkExternalEconomicsScheduleAndHorizon(input) {
  const args = isObject(input) ? input : {};
  const policy = isObject(args.policy) ? args.policy : {};
  const plan = isObject(args.plan) ? args.plan : {};
  const verifiedSchedule = isObject(args.verifiedSchedule) ? args.verifiedSchedule : {};
  const violations = [];
  const warnings = [];
  const reviewItems = [];
  const conditions = [];
  const projections = [];

  (plan.terms || []).forEach((term, termIndex) => {
    checkCapacity(policy, term, termIndex, violations);
    checkSummer(policy, term, termIndex, violations, reviewItems);
    (term.courses || []).forEach((course, courseIndex) => {
      const path = `$.plan.terms[${termIndex}].courses[${courseIndex}]`;
      checkOfferingSource({
        policy,
        verifiedSchedule,
        term,
        termIndex,
        course,
        courseIndex,
        violations,
        projections
      });
      checkAvailability({ policy, course, path, violations, conditions, warnings, reviewItems });
    });
    checkMeetingConflicts(policy, term, termIndex, violations);
  });
  checkHorizon({
    policy,
    plan,
    expectedContext: args.expectedContext,
    requirementAllocation: args.requirementAllocation,
    violations
  });
  return result({ violations, warnings, reviewItems, conditions, projections });
}
