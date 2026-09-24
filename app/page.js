"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  buildEarlyGraduationContext,
  buildPlanningSlots,
  PLANNING_PACES,
  resolvePlanningContext,
  transferPlanningOptions
} from "../lib/planning/horizon.js";
import {
  buildPrerequisiteFollowUp,
  validateStudentPrerequisites
} from "../lib/planning/prerequisiteFormValidation.js";
import {
  createGeneratedPlannerSession,
  economicsResultFromReport,
  migratePlannerInputState,
  PLANNER_INPUT_STATE_VERSION,
  PLANNER_VIEWS,
  plannerViewFromSearch,
  replaceEconomicsPlan,
  restoreGeneratedPlannerSession
} from "../lib/planning/uiState.js";
import economicsCourseData from "../data/normalized/economics/courses.json";
import economicsPlanningConstraints from "../data/normalized/economics/planning-constraints.json";

const PLANNER_STORAGE_KEY = "econ-planner-ui-state";
const GENERATED_PLANNER_SESSION_KEY = "econ-planner-generated-session";
const PLANNER_STORAGE_VERSION = PLANNER_INPUT_STATE_VERSION;
const COURSE_CATALOG = economicsCourseData.courses || [];
const COURSE_ALIASES = new Map(COURSE_CATALOG.flatMap(course => (
  (course.aliases || []).map(alias => [alias, course.code])
)));
const NON_SELECTABLE_COURSE_CODES = new Set(COURSE_CATALOG
  .filter(course => course.studentSelectable === false)
  .map(course => course.code));
const AP_CREDIT_ALLOWED_COURSE_CODES = new Set(COURSE_CATALOG
  .filter(course => course.apEligible)
  .map(course => course.code));
const COURSE_PREREQUISITES = Object.fromEntries(COURSE_CATALOG
  .filter(course => (
    (course.prerequisites?.all || []).length
    || (course.prerequisites?.any || []).length
  ))
  .map(course => [course.code, course.prerequisites]));

const SELECTABLE_COURSE_CATALOG = COURSE_CATALOG.filter(course => course.studentSelectable !== false);
const STANDING_LABELS = Object.freeze({
  freshman: "Freshman",
  sophomore: "Sophomore",
  junior: "Junior",
  senior: "Senior"
});

const GROUPED_COURSE_CODES = new Set([
  "MAT 113", "MAT 121", "ECO 257", "MAT 217", "PSY 217", "ECO 321", "BUSN 323"
]);

const COURSE_DISPLAY_GROUPS = [
  {
    id: "ECO 113",
    code: "ECO 113",
    title: courseTitle("ECO 113"),
    courseCodes: ["ECO 113"]
  },
  {
    id: "ECO 114",
    code: "ECO 114",
    title: courseTitle("ECO 114"),
    courseCodes: ["ECO 114"]
  },
  {
    id: "ECO 160",
    code: "ECO 160",
    title: courseTitle("ECO 160"),
    courseCodes: ["ECO 160"]
  },
  {
    id: "ECO 161",
    code: "ECO 161",
    title: courseTitle("ECO 161"),
    courseCodes: ["ECO 161"]
  },
  {
    id: "ECO 213",
    code: "ECO 213",
    title: courseTitle("ECO 213"),
    courseCodes: ["ECO 213"]
  },
  {
    id: "ECO 214",
    code: "ECO 214",
    title: courseTitle("ECO 214"),
    courseCodes: ["ECO 214"]
  },
  {
    id: "ECO 461",
    code: "ECO 461",
    title: courseTitle("ECO 461"),
    courseCodes: ["ECO 461"]
  },
  {
    id: "math-requirement",
    code: "MAT 113 / MAT 121",
    title: "Required math course",
    courseCodes: ["MAT 113", "MAT 121"],
    options: [
      { code: "MAT 113", title: courseTitle("MAT 113") },
      { code: "MAT 121", title: courseTitle("MAT 121") }
    ]
  },
  {
    id: "statistics-requirement",
    code: "ECO 257 / MAT 217 / PSY 217",
    title: "Choose a statistics course",
    courseCodes: ["ECO 257", "MAT 217", "PSY 217"],
    options: [
      { code: "ECO 257", title: courseTitle("ECO 257") },
      { code: "MAT 217", title: courseTitle("MAT 217") },
      { code: "PSY 217", title: courseTitle("PSY 217") }
    ]
  },
  {
    id: "finance-requirement",
    code: "ECO 321 / BUSN 323",
    title: "Choose a money and finance course",
    courseCodes: ["ECO 321", "BUSN 323"],
    options: [
      { code: "ECO 321", title: courseTitle("ECO 321") },
      { code: "BUSN 323", title: courseTitle("BUSN 323") }
    ]
  },
  ...COURSE_CATALOG
    .filter(course => course.studentSelectable !== false && !GROUPED_COURSE_CODES.has(course.code) && !["ECO 113", "ECO 114", "ECO 160", "ECO 161", "ECO 213", "ECO 214"].includes(course.code))
    .map(course => ({
      id: course.code,
      code: course.code,
      title: course.title,
      courseCodes: [course.code]
    }))
];

const DECLARATION_COURSE_IDS = ["ECO 113", "ECO 114", "ECO 213", "ECO 214"];
const DECLARATION_REQUIREMENT_IDS = ["math-requirement", "statistics-requirement"];
const MAX_COURSE_NAME_CHARS = Math.max(...COURSE_DISPLAY_GROUPS.map(group => `${group.code} ${group.title}`.length));
const COURSE_COLUMNS_STYLE = { "--course-name-width": `calc(${MAX_COURSE_NAME_CHARS}ch + .4rem)` };

const blankCourse = course => ({
  id: course.code,
  code: course.code,
  title: course.title,
  status: "not_started",
  units: String(course.units ?? 1),
  grade: "",
  source: "manual_code",
  notes: ""
});

const SAVED_STATUS_PRIORITY = {
  completed: 5,
  transfer: 4,
  in_progress: 3,
  not_started: 2,
  uncertain: 1
};

function canonicalSavedCode(value) {
  const normalized = String(value || "").toUpperCase().replace(/^([A-Z]{2,5})\s*-?\s*(\d{3})$/, "$1 $2");
  return COURSE_ALIASES.get(normalized) || normalized;
}

function migrateSavedCourses(savedCourses = []) {
  const byCode = new Map();
  for (const savedCourse of savedCourses) {
    const code = canonicalSavedCode(savedCourse.code);
    if (!code || NON_SELECTABLE_COURSE_CODES.has(code) || !COURSE_CATALOG.some(course => course.code === code)) continue;
    const existing = byCode.get(code);
    if (!existing || (SAVED_STATUS_PRIORITY[savedCourse.status] || 0) > (SAVED_STATUS_PRIORITY[existing.status] || 0)) {
      byCode.set(code, { ...savedCourse, code });
    }
  }

  return SELECTABLE_COURSE_CATALOG.map(course => {
    const saved = byCode.get(course.code);
    return saved
      ? {
          ...blankCourse(course),
          ...saved,
          id: course.code,
          code: course.code,
          title: course.title,
          units: String(course.units ?? 1)
        }
      : blankCourse(course);
  });
}

function plannerInputSignature(formData) {
  const currentTermWindow = resolvePlanningContext(formData).currentTermPlanningWindow;
  return JSON.stringify({
    academicStanding: formData.academicStanding,
    majorDeclarationCatalogYear: formData.majorDeclarationCatalogYear,
    planningPace: formData.planningPace,
    planCreationDate: formData.planCreationDate,
    isTransferStudent: formData.isTransferStudent,
    customGraduationEnabled: formData.customGraduationEnabled,
    customExpectedGraduationYear: formData.customExpectedGraduationYear,
    transferExpectedGraduationYear: formData.transferExpectedGraduationYear,
    transferEntryAcademicYear: formData.transferEntryAcademicYear,
    reservedCourseUnits: formData.reservedCourseUnits,
    studyAbroadTerm: formData.studyAbroadTerm,
    currentTermScheduleSet: currentTermWindow
      ? [currentTermWindow.slotId, formData.scheduleSetByTerm?.[currentTermWindow.slotId] === true]
      : null,
    courses: selectedCourses(formData.courses)
      .map(course => [canonicalSavedCode(course.code), course.status, course.units, course.source])
      .sort((left, right) => left[0].localeCompare(right[0]))
  });
}

const initialForm = {
  displayName: "",
  academicStanding: "",
  majorDeclarationCatalogYear: "",
  planningPace: PLANNING_PACES.STANDARD,
  planCreationDate: "",
  planCreationDateEdited: false,
  isTransferStudent: false,
  customGraduationEnabled: false,
  customExpectedGraduationYear: "",
  transferExpectedGraduationYear: "",
  transferEntryAcademicYear: "",
  expectedGraduationTerm: "",
  reservedCourseUnits: {},
  reservationMemory: {},
  scheduleSetByTerm: {},
  studyAbroadTerm: "",
  courses: SELECTABLE_COURSE_CATALOG.map(blankCourse),
  advisorApprovals: ""
};

function courseLevel(code) {
  return Number(String(code).match(/\d+$/)?.[0] || 0);
}

function isTaken(course) {
  return course.status === "completed" || course.status === "transfer";
}

function visibleCourseStatus(course = {}) {
  if (isTaken(course)) return "completed";
  if (course.status === "in_progress") return "in_progress";
  if (course.status === "uncertain") return "uncertain";
  return "";
}

function completionSourceLabel(course = {}) {
  if (course.status === "transfer") return "Another college / transfer credit";
  if (course.source === "ap_credit" || /\bap\b|exam/i.test(course.source || "")) return "AP or exam credit";
  return "Hanover College";
}

function hasExplicitPrerequisiteConflict(question = {}) {
  return Boolean(
    question.blocking
    && (question.statuses || []).some(item => item.status && item.status !== "not_started")
  );
}

function prerequisiteStatusLabel(status) {
  return ({
    completed: "Completed",
    transfer: "Completed with transfer credit",
    in_progress: "Taking now",
    uncertain: "Not taken / not sure",
    repeated: "Repeated",
    failed: "Not completed",
    withdrawn: "Withdrawn"
  })[status] || plainCodeText(status);
}

function explicitPrerequisiteStatusText(question = {}) {
  return (question.statuses || [])
    .filter(item => item.status && item.status !== "not_started")
    .map(item => `${item.code} is marked ${prerequisiteStatusLabel(item.status)}`)
    .join("; ");
}

function selectedCourses(courses) {
  return courses.filter(course => !NON_SELECTABLE_COURSE_CODES.has(course.code) && ["completed", "transfer", "in_progress"].includes(course.status));
}

function courseTitle(code) {
  return COURSE_CATALOG.find(course => course.code === code)?.title || code;
}

function economicsResult(report) {
  return economicsResultFromReport(report);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasValidGeneratedPlan(plan) {
  return isPlainObject(plan)
    && typeof plan.id === "string"
    && plan.id.length > 0
    && Array.isArray(plan.terms)
    && plan.terms.every(term => (
      isPlainObject(term)
      && typeof (term.slotId || term.term) === "string"
      && Array.isArray(term.courses)
      && term.courses.every(course => isPlainObject(course) && typeof course.course === "string" && course.course.length > 0)
    ));
}

function isValidGeneratedPlannerReport(report) {
  if (!isPlainObject(report) || !Array.isArray(report.programs)) return false;
  const result = economicsResult(report);
  if (!isPlainObject(result) || !isPlainObject(result.program)) return false;
  if (result.program.id !== "economics-base" && result.program.name !== "Economics") return false;
  if (!Array.isArray(result.economicsPlans)
    || !Array.isArray(result.economicsPlanningGaps)
    || !Array.isArray(result.economicsCandidateOutcomes)) return false;

  if (!result.economicsPlans.every(hasValidGeneratedPlan)) return false;
  if (!result.economicsPlans.length) return result.economicsPlan === null;
  return hasValidGeneratedPlan(result.economicsPlan)
    && result.economicsPlan.id === result.economicsPlans[0].id;
}

function studentFacingRequestError(error, fallback, connectionMessage = "The planner could not connect. Please try again.", timeoutSubject = "The planner") {
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  if (error?.name === "AbortError" || /abort(?:ed|error)?/i.test(message)) {
    return "The request was interrupted. Please try again.";
  }
  if (error?.name === "TimeoutError" || /timed?\s*out|timeout/i.test(message)) {
    return `${timeoutSubject} took too long to respond. Please try again.`;
  }
  if (!message || /failed to fetch|networkerror|network request failed|load failed|network stack/i.test(message)) {
    return connectionMessage;
  }
  return message || fallback;
}

function planCourseIdentity(course) {
  return course.requirementId || `${course.course}-${course.source || "course"}`;
}

function domId(value) {
  return String(value || "item").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function localToday() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatAvailabilityVerificationDate(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return value || "Status unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(new Date(year, month - 1, day));
}

function formatAcademicYear(value) {
  return value ? String(value).replace("-", "/") : "Academic year";
}

function formatAcademicYearCompact(startYear) {
  return `${startYear}\u2013${String(startYear + 1).slice(-2)}`;
}

function PlanningGaps({ items = [] }) {
  if (!items.length) return null;
  return (
    <div className="plan-notes planning-gaps" role="status">
      <strong>What still needs attention</strong>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.requirementId || item.code || "gap"}-${index}`}>
            {item.course ? `${item.course}: ` : ""}{item.reason || item.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function warningCourseCodes(message) {
  return [...new Set(String(message || "").match(/\b(?:BUSN|ECO|MAT|PSY)\s+\d{3}\b/g) || [])]
    .sort((left, right) => left.localeCompare(right));
}

function projectedWarningDetails(message) {
  const match = String(message || "").match(
    /^(.+?) in ((?:(?:Fall|Winter|Spring\/May|May|Summer) \d{4})|(?:\d{4}\/\d{4} term to be confirmed)) is a projected placement/i
  );
  return match ? { course: match[1].trim(), term: match[2] } : null;
}

function projectedTermOrder(term) {
  const academicYear = String(term || "").match(/^(\d{4})\/(\d{4}) term to be confirmed$/i);
  if (academicYear) return Number(academicYear[1]) * 10 + 4;
  const match = String(term || "").match(/^(Fall|Winter|Spring\/May|May|Summer) (\d{4})$/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const termOrder = { winter: 0, "spring/may": 1, may: 1, summer: 2, fall: 3 };
  return Number(match[2]) * 10 + termOrder[match[1].toLowerCase()];
}

function isFlattenedPlanNotice(notice) {
  return String(notice?.code || "").startsWith("PLAN_")
    || ["Graduation planning assumption", "Graduation plan advisor review"].includes(notice?.title);
}

function academicYearKey(value) {
  return String(value || "").replace("/", "-");
}

function scheduleTermKey(term) {
  const value = String(term?.termKey || term?.scheduleTerm || term?.displayTerm || term?.term || "");
  if (/spring|may/i.test(value)) return "May";
  return value;
}

function planPublishedScheduleNotices(plan, schedule) {
  const scheduleYear = academicYearKey(schedule?.academicYear);
  if (!scheduleYear || !plan) return [];
  const scheduleTerms = schedule?.terms || {};
  return (plan.terms || []).flatMap(term => {
    if (academicYearKey(term.academicYear) !== scheduleYear) return [];
    const sections = scheduleTerms[scheduleTermKey(term)] || [];
    return (term.courses || []).flatMap(course => {
      if (!course.course || course.course === "ECO elective" || course.course.includes("requirement")) return [];
      const selectedSection = sections.find(section => (
        section.course === course.course && String(section.section || "") === String(course.section || "")
      ));
      if (!selectedSection) return [];
      return [{
        code: `SELECTED_PLAN_SCHEDULE_${term.slotId || term.term}_${course.course}`.replace(/[^A-Z0-9_]/gi, "_"),
        title: "Graduation planning assumption",
        severity: "warning",
        message: `${course.course}${course.section ? `-${course.section}` : ""} in ${term.term || term.displayTerm}: current seat availability is ${courseAvailabilityLabel(selectedSection)}. Confirm before registration.`
      }];
    });
  });
}

function selectedPlanNotices(plan, schedule) {
  if (!plan) return [];
  const messages = [
    ...(plan.validation?.warnings || []).filter(message => !/^Seat availability for /i.test(message)),
    ...(plan.advisorChecks || []).map(item => item.reason).filter(Boolean)
  ];
  const notices = messages.map((message, index) => ({
    code: `SELECTED_PLAN_WARNING_${plan.id}_${index}`,
    title: "Graduation planning assumption",
    severity: "warning",
    message
  }));
  return [...new Map([
    ...(plan.advisorNotifications || []),
    ...notices,
    ...planPublishedScheduleNotices(plan, schedule)
  ].map(notice => [notice.message, notice])).values()];
}

function termReservationLimit(slot = {}) {
  const key = slot.termKey === "Spring" ? "May" : slot.termKey;
  const contract = economicsPlanningConstraints.terms?.[key];
  return Math.max(0, Number(contract?.normalCourseUnits ?? contract?.maxTotalCourses ?? 0));
}

function planningSlotsLabel(slotId, planningContext) {
  return buildPlanningSlots(planningContext).find(slot => slot.id === slotId)?.label || slotId;
}

function structuredItemText(item, fallback) {
  if (typeof item === "string") return item;
  return item?.message || item?.question || item?.prompt || item?.reason || item?.label || item?.code || fallback;
}

function plainCodeText(value) {
  const words = String(value || "").trim().replaceAll("_", " ").toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "";
}

function planningTermText(value) {
  const match = /^(\d{4})-(FALL|WINTER|SPRING|MAY|SUMMER)$/u.exec(String(value || "").trim().toUpperCase());
  return match ? `${plainCodeText(match[2])} ${match[1]}` : String(value || "").trim();
}

function affectedPlanningItemText(item) {
  const affected = item?.affectedObject || item?.subject || {};
  const parts = [
    affected.course,
    affected.termId ? `in ${planningTermText(affected.termId)}` : "",
    !affected.course && affected.requirementId ? `requirement ${affected.requirementId}` : "",
    !affected.course && !affected.requirementId && affected.catalogDecision
      ? plainCodeText(affected.catalogDecision)
      : ""
  ].filter(Boolean);
  return parts.join(" ");
}

function conditionText(condition) {
  const supplied = structuredItemText(condition, "");
  if (supplied) return supplied;
  const affected = affectedPlanningItemText(condition);
  const reason = plainCodeText(condition?.reasonCode || condition?.type);
  return affected && reason
    ? `${affected}: ${reason}.`
    : affected || (reason ? `${reason}.` : "Confirm this plan condition.");
}

function advisorActionText(action) {
  const supplied = structuredItemText(action, "");
  if (supplied) return supplied;
  const affected = affectedPlanningItemText(action);
  const reason = plainCodeText(action?.reasonCode);
  const authority = plainCodeText(action?.responsibleAuthority);
  const evidence = (action?.evidenceRequired || []).map(plainCodeText).filter(Boolean);
  const summary = affected && reason ? `${affected}: ${reason}.` : affected || (reason ? `${reason}.` : "Review this plan item.");
  return [
    summary,
    authority ? `Review with ${authority.toLowerCase()}.` : "",
    evidence.length ? `Evidence needed: ${evidence.join(", ")}.` : ""
  ].filter(Boolean).join(" ");
}

function AdvisorAttention({ catalog, plan, schedule }) {
  const degreeInformation = plan?.degreeRequirementInformation;
  const degreeItems = degreeInformation?.items || [];
  const advisorActions = plan?.advisorActions || plan?.validation?.advisorActions || [];
  const conditions = plan?.conditions || plan?.validation?.conditions || [];
  const globalNotices = (catalog?.advisorAttention || []).filter(notice => !isFlattenedPlanNotice(notice));
  const notices = [...new Map([
    ...globalNotices,
    ...selectedPlanNotices(plan, schedule)
  ].map(notice => [notice.message, notice])).values()];
  if (!notices.length && !degreeItems.length && !advisorActions.length && !conditions.length) return null;
  const planningNotices = notices.filter(notice => notice.title === "Graduation planning assumption");
  const otherNotices = notices.filter(notice => notice.title !== "Graduation planning assumption");
  const projectedNotices = planningNotices.filter(notice => /projected placement/i.test(notice.message || ""));
  const publishedScheduleNotices = planningNotices.filter(notice => !/projected placement/i.test(notice.message || ""));
  const seatAvailabilityCourses = [...new Set(publishedScheduleNotices
    .filter(notice => /seat|availability|waitlist|closed/i.test(notice.message || ""))
    .flatMap(notice => warningCourseCodes(notice.message)))].sort((left, right) => left.localeCompare(right));
  const scheduleConfirmationCourses = [...new Set(publishedScheduleNotices
    .filter(notice => !/seat|availability|waitlist|closed/i.test(notice.message || ""))
    .flatMap(notice => warningCourseCodes(notice.message)))].sort((left, right) => left.localeCompare(right));
  const publishedScheduleMessages = [...new Set(publishedScheduleNotices
    .filter(notice => warningCourseCodes(notice.message).length === 0)
    .map(notice => notice.message))];
  const projectedNoticeDetails = projectedNotices.map(notice => ({
    message: notice.message,
    placement: projectedWarningDetails(notice.message)
  }));
  const projectedPlacementByTerm = new Map();
  for (const placement of projectedNoticeDetails.map(item => item.placement).filter(Boolean)) {
    if (!projectedPlacementByTerm.has(placement.term)) projectedPlacementByTerm.set(placement.term, new Set());
    projectedPlacementByTerm.get(placement.term).add(placement.course);
  }
  const projectedPlacementTerms = [...projectedPlacementByTerm.entries()]
    .map(([term, courses]) => ({ term, courses: [...courses].sort((left, right) => left.localeCompare(right)) }))
    .sort((left, right) => projectedTermOrder(left.term) - projectedTermOrder(right.term) || left.term.localeCompare(right.term));
  const ungroupedProjectedMessages = [...new Set(projectedNoticeDetails
    .filter(item => !item.placement)
    .map(item => item.message))];
  const hasPublishedScheduleChecks = seatAvailabilityCourses.length > 0
    || scheduleConfirmationCourses.length > 0
    || publishedScheduleMessages.length > 0;
  const hasProjectedPlacementChecks = projectedPlacementTerms.length > 0
    || ungroupedProjectedMessages.length > 0;
  const plannedCourses = new Set((plan?.terms || []).flatMap(term => (
    (term.courses || []).map(course => course.course)
  )));
  const bothIntermediatesRemain = plannedCourses.has("ECO 213") && plannedCourses.has("ECO 214");
  const publishedScheduleLabel = schedule?.academicYear
    ? `Published ${formatAcademicYear(schedule.academicYear)} schedule checks`
    : "Published schedule checks";
  const advisorActionRequired = Boolean(
    advisorActions.length
    || plan?.advisorActionRequired
    || plan?.readinessStatus === "ADVISOR_ACTION_REQUIRED"
    || plan?.validation?.readinessStatus === "ADVISOR_ACTION_REQUIRED"
  );
  const sectionHeading = advisorActionRequired
    ? "Advisor Attention"
    : conditions.length
      ? "Plan Conditions"
      : "Plan Notes";

  return (
    <section className="advisor-attention" aria-live="polite" data-plan-id={plan?.id || ""}>
      <h2>{sectionHeading}</h2>
      {plan?.label && <p className="advisor-attention-scope">Information and warnings shown for {plan.label}.</p>}
      {conditions.length > 0 && (
        <div className="advisor-attention-item plan-conditions" data-plan-conditions>
          <h3>Conditions to confirm</h3>
          <ul>
            {conditions.map((condition, index) => (
              <li key={condition.conditionId || `${condition.code || "condition"}-${index}`}>{conditionText(condition)}</li>
            ))}
          </ul>
        </div>
      )}
      {advisorActions.length > 0 && (
        <div className="advisor-attention-item plan-advisor-actions" data-plan-advisor-actions>
          <h3>Actions for you and your advisor</h3>
          <ul>
            {advisorActions.map((action, index) => (
              <li key={action.actionId || `${action.code || "action"}-${index}`}>{advisorActionText(action)}</li>
            ))}
          </ul>
        </div>
      )}
      {degreeItems.length > 0 && (
        <div className="advisor-attention-item degree-requirement-information" data-degree-requirement-information>
          <h3>CCR/ACE information</h3>
          <p>{degreeInformation.terminology?.ccr} / {degreeInformation.terminology?.ace}</p>
          <ul>
            {degreeItems.map(item => (
              <li key={item.code} data-degree-designation-code={item.code}><strong>{item.code}</strong> {item.detail}</li>
            ))}
          </ul>
        </div>
      )}
      {otherNotices.map(notice => (
        <div className={`advisor-attention-item is-${notice.severity || "warning"}`} key={notice.code}>
          {notice.title && notice.title !== "Advisor Attention" && <strong>{notice.title}</strong>}
          <p>{notice.message}</p>
          {notice.findings?.length > 0 && (
            <ul>
              {notice.findings.map(finding => <li key={`${finding.code}-${finding.message}`}>{finding.message}</li>)}
            </ul>
          )}
        </div>
      ))}
      {planningNotices.length > 0 && (
        <div className="advisor-attention-item graduation-assumptions">
          <h3>Things to confirm</h3>
          <div className="advisor-attention-groups">
            {hasPublishedScheduleChecks && (
              <section>
                <h4>{publishedScheduleLabel}</h4>
                <ul>
                  {seatAvailabilityCourses.length > 0 && (
                    <li><strong>Confirm seat availability:</strong> {seatAvailabilityCourses.join(", ")}.</li>
                  )}
                  {scheduleConfirmationCourses.length > 0 && (
                    <li><strong>Confirm offerings and time conflicts:</strong> {scheduleConfirmationCourses.join(", ")}.</li>
                  )}
                  {publishedScheduleMessages.map(message => <li key={message}>{message}</li>)}
                </ul>
              </section>
            )}
            {hasProjectedPlacementChecks && (
              <section>
                <h4>Projected placement</h4>
                <p>Later schedules are not yet published. Confirm these planned courses when their official schedules become available:</p>
                {projectedPlacementTerms.length > 0 && (
                  <ul className="projected-placement-list">
                    {projectedPlacementTerms.map(({ term, courses }) => (
                      <li key={term} data-term={term}><strong>{term}:</strong> {courses.join(", ")}</li>
                    ))}
                  </ul>
                )}
                {ungroupedProjectedMessages.length > 0 && (
                  <ul className="projected-placement-fallback">
                    {ungroupedProjectedMessages.map(message => <li key={message}>{message}</li>)}
                  </ul>
                )}
                {bothIntermediatesRemain && (
                  <p className="offering-pattern-note">
                    <strong>Known pattern:</strong> ECO 213 and ECO 214 tend to be offered in different terms. The available evidence does not yet establish which course will be offered first.
                  </p>
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function PlanTimeline({
  plans = [],
  planningGaps = [],
  activePlanId,
  schedule,
  onSelectPlan,
  onEditPlanCourse,
  editingPlanCourseKey,
  planEditFeedback
}) {
  if (!plans.length) {
    return planningGaps.length ? (
      <section className="plan-section" aria-live="polite">
        <PlanningGaps items={planningGaps} />
      </section>
    ) : null;
  }

  const activePlan = plans.find(plan => plan.id === activePlanId) || plans[0];
  const studentNoticeMessages = new Set((activePlan.studentNotices || []).map(notice => notice.message));
  const studentWarnings = (activePlan.studentMessages || []).filter(message => !studentNoticeMessages.has(message));
  const academicYearGroups = (activePlan.terms || []).reduce((groups, term) => {
    const label = term.academicYear || formatAcademicYear(activePlan.academicYear);
    const group = groups.find(item => item.label === label);
    if (group) {
      group.terms.push(term);
    } else {
      groups.push({ label, terms: [term] });
    }
    return groups;
  }, []);

  return (
    <section className="plan-section" aria-live="polite">
      {plans.length > 1 && (
        <div className="plan-tabs" role="group" aria-label="Generated plans">
          {plans.map(plan => (
            <button
              type="button"
              className={`plan-tab${plan.id === activePlan.id ? " is-active" : ""}`}
              aria-pressed={plan.id === activePlan.id}
              key={plan.id}
              onClick={() => onSelectPlan?.(plan.id)}
            >
              {plan.label}
            </button>
          ))}
        </div>
      )}
      <div
        id={activePlan.id}
        role="region"
        aria-label={`${activePlan.label} plan`}
      >
        <div className="section-heading">
          <span className="step-number">3.</span>
          <div>
            <h2>Your Plan</h2>
            <p>{activePlan.description}</p>
            <p className="plan-source-note">Published course schedule: {formatAcademicYear(activePlan.academicYear)}. Later unpublished schedules are shown as planning projections.</p>
          </div>
        </div>
        <div className="academic-year-groups">
          {academicYearGroups.map(group => (
            <section className="academic-year-group" key={group.label}>
              <h3 className="academic-year-label">{group.label}</h3>
              <div className="plan-grid">
                {group.terms.map(term => (
                  <article
                    className={`term-card${term.isPlaceholder ? " is-placeholder" : ""}`}
                    data-academic-year={term.academicYear || ""}
                    data-placeholder={term.isPlaceholder ? "true" : "false"}
                    data-term-key={term.termKey || ""}
                    data-publication-status={term.publicationStatus || ""}
                    key={term.slotId || term.term}
                  >
                    <h4>{term.displayTerm || term.term}</h4>
                    {term.courses.length > 0 ? (
                      <ul>
                        {term.courses.map(course => {
                          const termId = term.slotId || term.term;
                          const courseId = planCourseIdentity(course);
                          const feedback = planEditFeedback?.planId === activePlan.id
                            && planEditFeedback.fromTermId === termId
                            && planEditFeedback.courseId === courseId
                            ? planEditFeedback.message : null;
                          return (
                            <li key={`${termId}-${courseId}`}>
                              <div className="plan-course-summary">
                                <strong>{course.course}</strong>
                                <span>{course.title}</span>
                                {course.fixedInProgress && <span>Taking now — fixed in this term</span>}
                                <CourseAvailabilityStatus course={course} term={term} schedule={schedule} />
                                {course.preliminaryScheduleEvidence && <span className="plan-course-availability">Preliminary schedule ({course.preliminaryScheduleEvidence.issuedOn}); course and term subject to change</span>}
                                {course.approvalRequired?.length > 0 && <span className="plan-course-approval">Approval required</span>}
                              </div>
                              {onEditPlanCourse && !course.fixedInProgress && (
                                <div className="plan-course-actions">
                                  {course.alternativeOptions?.length > 1 && (
                                    <label>
                                      <span className="sr-only">Choose the elective for {term.displayTerm || term.term}</span>
                                      <select
                                        aria-label={`Choose elective for ${term.displayTerm || term.term}`}
                                        disabled={Boolean(editingPlanCourseKey)}
                                        value={course.selectedOptionId || ""}
                                        onChange={event => onEditPlanCourse({
                                          type: "option",
                                          planId: activePlan.id,
                                          fromTermId: termId,
                                          courseId,
                                          optionId: event.target.value
                                        }, event.currentTarget)}
                                      >
                                        {course.alternativeOptions.map(option => (
                                          <option value={option.id} key={option.id}>
                                            {option.course}{option.section ? `-${option.section}` : ""}: {option.title}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                  )}
                                  <label>
                                    <span className="sr-only">Move {course.course} to another term</span>
                                    <select
                                      aria-label={`Move ${course.course} to another term`}
                                      disabled={Boolean(editingPlanCourseKey)}
                                      value={termId}
                                        onChange={event => onEditPlanCourse({
                                          type: "move",
                                          planId: activePlan.id,
                                          fromTermId: termId,
                                          toTermId: event.target.value,
                                          courseId
                                        }, event.currentTarget)}
                                    >
                                      {(activePlan.terms || []).map(optionTerm => {
                                        const optionTermId = optionTerm.slotId || optionTerm.term;
                                        return (
                                          <option value={optionTermId} key={optionTermId}>
                                            {optionTerm.academicYear} {optionTerm.displayTerm || optionTerm.term}
                                          </option>
                                        );
                                      })}
                                    </select>
                                  </label>
                                  {feedback && <span className="plan-course-edit-feedback" role="alert">{feedback}</span>}
                                  <span className="required-course-note">
                                    Required for this plan. Move it to another valid term{course.alternativeOptions?.length > 1 ? " or choose a replacement above" : ""}.
                                  </span>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="empty-term">No courses placed</p>
                    )}
                    {term.isSummer && (
                      <p className="summer-term-note">Summer, online, last-resort option.</p>
                    )}
                    {term.isPlaceholder && (
                      <p className="placeholder-term-note">Exact course offerings and terms must be confirmed after the schedule is published.</p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
        {activePlan.validation?.valid === false && (
          <div className="plan-validation-errors" role="alert">
            <strong>This edited plan needs attention.</strong>
            <ul>
              {activePlan.validation.errors.map(error => <li key={error}>{error}</li>)}
            </ul>
          </div>
        )}
        {activePlan.feasibility && (
          <div className="plan-notes" aria-label="Plan feasibility details">
            <strong>Plan verification and conditions</strong>
            <ul>
              <li>Offerings: {activePlan.feasibility.verification?.offerings || "unknown"}</li>
              <li>Meeting times: {activePlan.feasibility.verification?.meetings || "unknown"}</li>
              <li>Availability: {activePlan.feasibility.verification?.availability || "unknown"}</li>
              {activePlan.feasibility.requiredApprovals?.map(item => (
                <li key={`${item.course}-${item.prerequisite}-${item.term}`}>{item.message}</li>
              ))}
              {activePlan.feasibility.enrollmentConditions?.map(item => (
                <li key={`${item.type}-${item.course}-${item.section}-${item.term}`}>
                  {item.course}{item.section ? `-${item.section}` : ""} in {item.term}: {item.type.replaceAll("_", " ")}
                </li>
              ))}
            </ul>
          </div>
        )}
        <PlanningGaps items={activePlan.unscheduled || []} />
        {activePlan.summerFallbacks?.length > 0 && (
          <div className="plan-notes summer-fallback-note">
            <strong>Summer fallback used</strong>
            <ul>
              {activePlan.summerFallbacks.map(item => (
                <li key={`${activePlan.id}-summer-${item.course}-${item.term}`}>
                  {item.course} in {item.term}: Summer, online, last-resort option. {item.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {studentWarnings.length > 0 && (
          <div className="plan-notes" role="status">
            <strong>Plan conditions and warnings</strong>
            <ul>{studentWarnings.map(message => <li key={message}>{message}</li>)}</ul>
          </div>
        )}
      </div>
    </section>
  );
}

function compactPlanCourse(course) {
  if (course.course === "ECO elective" && course.minimumLevel === 200) {
    return "ECO elective (200+)";
  }
  return course.course;
}

function feasibilityLabel(status) {
  return ({
    VERIFIED_FEASIBLE: "Verified feasible",
    CONDITIONALLY_FEASIBLE: "Conditionally feasible",
    PRELIMINARY_ONLY: "Preliminary only",
    SEARCH_INCOMPLETE: "Search incomplete - advisor review needed",
    NOT_FEASIBLE: "Not feasible"
  })[status] || "Status pending";
}

function hasExactAvailabilityEvidence(course) {
  return course?.source === "verified-offering"
    || course?.source === "summer-last-resort"
    || course?.verificationStatus === "verified";
}

function exactPublishedScheduleSection(course, term, schedule) {
  if (!course?.course || !course.section) return null;
  if (academicYearKey(term?.academicYear) !== academicYearKey(schedule?.academicYear)) return null;
  return (schedule?.terms?.[scheduleTermKey(term)] || []).find(section => (
    section.course === course.course && String(section.section || "") === String(course.section)
  )) || null;
}

function courseAvailabilityLabel(course, exactSection = false) {
  const availability = course?.availability;
  if (!exactSection || !hasExactAvailabilityEvidence(course) || !availability?.status) return "Status unavailable";
  if (availability.status === "open") return "✓ OPEN";
  if (availability.status === "full") return "FULL";
  return "Status unavailable";
}

function availabilityClassName(course, exactSection = false) {
  if (!exactSection || !hasExactAvailabilityEvidence(course)) return "is-unavailable";
  if (course?.availability?.status === "open") return "is-open";
  if (course?.availability?.status === "full") return "is-full";
  return "is-unavailable";
}

function scheduleVerificationDate(schedule) {
  return schedule?.availabilityAsOf
    || schedule?.verifiedOn
    || schedule?.lastVerifiedAt
    || schedule?.source?.humanVerifiedOn
    || schedule?.source?.screenshotRetrievedOn
    || null;
}

function CourseAvailabilityStatus({ course, term, schedule }) {
  if (academicYearKey(term?.academicYear) !== academicYearKey(schedule?.academicYear)) return null;
  const selectedSection = exactPublishedScheduleSection(course, term, schedule);
  return <span className={`plan-course-availability ${availabilityClassName(selectedSection, Boolean(selectedSection))}`}>{courseAvailabilityLabel(selectedSection, Boolean(selectedSection))}</span>;
}

function CandidateOutcomes({ outcomes = [], convergences = [] }) {
  if (!outcomes.length && !convergences.length) return null;
  return (
    <section className="candidate-outcomes" aria-label="Plan candidate results">
      <h2>Plan candidate results</h2>
      {outcomes.length > 0 && (
        <ul>
          {outcomes.map(outcome => (
            <li key={`${outcome.id}-${outcome.label}`}>
              <strong>{outcome.label}:</strong> {feasibilityLabel(outcome.status)}{outcome.displayed ? " · shown" : " · not shown"}
              {outcome.substitutionReason === "NEXT_DISTINCT_RESERVE" && " · using its next-best distinct schedule"}
              {outcome.displayed && outcome.selectedCandidateRank > 1 && ` · reserve candidate ${outcome.selectedCandidateRank}`}
              {outcome.candidatePool?.retainedDistinctSchedules > 1 && ` · ${outcome.candidatePool.retainedDistinctSchedules} validated options retained`}
              {!outcome.displayed && outcome.suppressionReason?.code === "NO_DISTINCT_RETAINED_CANDIDATE" && " · search stopped before a distinct retained option was found"}
              {outcome.reasons?.length > 0 && ` — ${outcome.reasons.map(item => item.reason || item.message || item).join("; ")}`}
            </li>
          ))}
        </ul>
      )}
      {convergences.map(item => <p key={`${item.keptPlanId}-${item.convergedPlanId}`}>{item.message}</p>)}
    </section>
  );
}

function ScheduleAvailability({ schedule, plan }) {
  const scheduleYear = academicYearKey(schedule?.academicYear);
  const plannedByTerm = new Map((plan?.terms || [])
    .filter(term => academicYearKey(term.academicYear) === scheduleYear)
    .map(term => [scheduleTermKey(term), term.courses || []]));
  const terms = Object.entries(schedule?.terms || {})
    .map(([term, sections]) => [term, (plannedByTerm.get(term) || []).map(course => ({
      course,
      section: sections.find(item => (
        item.course === course.course && String(item.section || "") === String(course.section || "")
      )) || null
    }))])
    .filter(([, courses]) => courses.length > 0);
  if (!terms.length) return null;
  const verificationDate = scheduleVerificationDate(schedule);
  return (
    <details className="schedule-availability">
      <summary>Current section availability for {plan?.label || "this plan"} ({formatAcademicYear(schedule.academicYear)})</summary>
      {terms.map(([term, courses]) => (
        <section key={term}>
          <h3>{term}</h3>
          <ul>
            {courses.map(({ course, section }, index) => (
              <li key={`${term}-${course.course}-${course.section || index}`}>
                <strong>{course.course}{course.section ? `-${course.section}` : ""}</strong>: <span className={availabilityClassName(section || course, Boolean(section))}>{courseAvailabilityLabel(section || course, Boolean(section))}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="schedule-availability-note">
        {verificationDate
          ? `Course schedule and seat availability verified from the published Hanover schedule as of ${formatAvailabilityVerificationDate(verificationDate)}. OPEN and FULL can change. Courses in later years are projections and do not have verified seat availability.`
          : "Course schedule and seat availability verification date is unavailable in the published Hanover schedule. OPEN and FULL can change. Courses in later years are projections and do not have verified seat availability."}
      </p>
    </details>
  );
}

function comparisonScheduleRows(plan) {
  const rows = (plan?.terms || [])
    .map(term => ({
      key: `${term.academicYear || ""}-${term.isPlaceholder ? "TBC" : term.displayTerm || term.term}`,
      academicYear: formatAcademicYear(term.academicYear),
      term: term.isPlaceholder ? "Term to be confirmed" : term.displayTerm || term.term,
      courses: (term.courses || []).map(compactPlanCourse)
    }));

  return rows.map((row, index) => {
    if (index > 0 && rows[index - 1].academicYear === row.academicYear) {
      return row;
    }

    const yearRowSpan = rows.slice(index).findIndex(item => item.academicYear !== row.academicYear);
    return { ...row, yearRowSpan: yearRowSpan === -1 ? rows.length - index : yearRowSpan };
  });
}

function PlanComparisonScreen({
  report,
  planResult,
  fallbackPlanningContext,
  courses,
  displayName,
  view,
  selectedPlanId,
  isExiting,
  isGenerating,
  editingPlanCourseKey,
  planEditStatus,
  planEditFeedback,
  canUndoPlanEdit,
  onEditCourses,
  onReviewTimeline,
  onClearAll,
  onBackToCompare,
  onChoosePlan,
  onSelectPlan,
  onRegenerate,
  onDownloadPdf,
  downloadButtonRef,
  isDownloadingPdf,
  pdfStatus,
  onEditPlanCourse,
  onUndoPlanEdit
}) {
  const result = economicsResult(report);
  const plans = result?.economicsPlans || [];
  const planningGaps = result?.economicsPlanningGaps || [];
  const candidateOutcomes = result?.economicsCandidateOutcomes || [];
  const convergences = result?.economicsPlanConvergences || [];
  const comparisonContext = result?.planningContext || fallbackPlanningContext;
  const canonicalPlanResult = result?.economicsPlanResult || planResult || null;
  const acceleratedResult = result?.economicsAcceleratedResult || null;
  const [highlightDifferences, setHighlightDifferences] = useState(false);
  const resultHeadingRef = useRef(null);
  const isPlanView = view === PLANNER_VIEWS.PLAN;
  const selectedPlan = plans.find(plan => plan.id === selectedPlanId) || plans[0];
  const planningContext = isPlanView ? selectedPlan?.planningContext || comparisonContext : comparisonContext;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => resultHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [view]);

  const rowsByPlan = new Map(plans.map(plan => [plan.id, comparisonScheduleRows(plan)]));
  const allRowKeys = new Set([...rowsByPlan.values()].flatMap(rows => rows.map(row => row.key)));
  const sharedCoursesByRow = new Map([...allRowKeys].map(key => {
    const courseSets = plans.map(plan => new Set(
      rowsByPlan.get(plan.id)?.find(item => item.key === key)?.courses || []
    ));
    const shared = courseSets.length > 1
      ? [...courseSets[0]].filter(course => courseSets.every(set => set.has(course)))
      : [];
    return [key, new Set(shared)];
  }));
  const standing = displayName?.trim() || (planningContext?.customGraduationEnabled ? "Custom timeline" : planningContext?.effectiveStandingLabel)
    || planningContext?.standingLabel
    || "Student";
  const graduationTarget = planningContext?.expectedGraduationTerm || "To be confirmed";
  const completedCodes = courses.filter(isTaken).map(course => course.code);
  const inProgressCodes = courses.filter(course => course.status === "in_progress").map(course => course.code);
  const overallStatus = overallPlanReadiness(isPlanView && selectedPlan ? [selectedPlan] : plans);
  const hasProjectedOfferings = (isPlanView && selectedPlan ? [selectedPlan] : plans)
    .some(plan => plan.terms?.some(term => term.courses?.some(course => course.scheduleProvenance === "PLANNING_PROJECTION")));
  const noPlan = noPlanPresentation(canonicalPlanResult?.category);
  const displayedOverallStatus = plans.length
    ? overallStatus
    : canonicalPlanResult?.category === "INPUT_BLOCKED"
      ? "Needs one more detail"
      : canonicalPlanResult?.category === "INFEASIBLE_PROVEN"
        ? "No complete plan"
        : "Needs advisor attention";
  const planBadge = plan => {
    if (plan.planningMode !== "graduation_priority") return plan.label || "Validated";
    const mayCourse = plan.terms
      ?.find(term => term.scheduleTerm === "May")
      ?.courses?.[0]?.course;
    return mayCourse ? `${mayCourse} in May` : "Graduation priority";
  };

  return (
    <main className={`comparison-page${isExiting ? " is-exiting" : ""}`}>
      <style jsx global>{`
        body {
          margin: 0;
          background: #f1f3f5;
          color: #18202b;
          font-family: Arial, sans-serif;
        }
        button, input { font-family: Arial, sans-serif; }
        .comparison-page {
          box-sizing: border-box;
          min-height: 100vh;
          overflow-wrap: anywhere;
          animation: comparison-enter .28s ease-out both;
        }
        .comparison-page * { box-sizing: border-box; }
        .comparison-page.is-exiting { animation: comparison-exit .24s ease-in both; }
        @keyframes comparison-enter {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes comparison-exit {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        .comparison-topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 1rem 2rem;
          border-bottom: 1px solid #cbd5e1;
          background: #fff;
          box-shadow: 0 1px 8px rgba(15, 35, 75, .06);
        }
        .comparison-brand {
          display: flex;
          align-items: flex-start;
          flex-direction: column;
          gap: .35rem;
          color: #4b2e83;
          font-size: 25px;
          font-weight: 700;
          letter-spacing: -.03em;
        }
        .comparison-brand-logo { display: block; width: 168px; height: auto; }
        .comparison-student {
          display: flex;
          align-items: center;
          gap: .45rem;
          margin-left: auto;
          color: #2f1c57;
          font-size: 15px;
        }
        .comparison-student strong { font-weight: 700; }
        .comparison-actions {
          display: flex;
          align-items: center;
          gap: .65rem;
          margin-left: 1.25rem;
        }
        .edit-courses-button,
        .regenerate-plans-button,
        .compare-plans-button,
        .download-pdf-button,
        .undo-plan-edit-button {
          width: auto;
          min-height: 0;
          margin: 0;
          padding: .65rem 1rem;
          border: 1px solid #6d5a86;
          border-radius: .45rem;
          background: #fff;
          color: #2f1c57;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
        }
        .edit-courses-button:hover,
        .regenerate-plans-button:hover,
        .compare-plans-button:hover,
        .download-pdf-button:hover,
        .undo-plan-edit-button:hover { background: #f2eef7; }
        .regenerate-plans-button:disabled,
        .download-pdf-button:disabled,
        .undo-plan-edit-button:disabled { cursor: wait; opacity: .65; }
        .pdf-download-status { color: #33425d; font-size: 12px; }
        .comparison-content {
          width: min(1460px, calc(100% - 3rem));
          margin: 0 auto;
          padding: 1.15rem 0 3rem;
        }
        .comparison-back {
          width: auto;
          min-height: 0;
          margin: 0;
          padding: .25rem 0;
          border: 0;
          background: transparent;
          color: #4b2e83;
          font-size: 14px;
          cursor: pointer;
        }
        .comparison-back:hover { text-decoration: underline; }
        .comparison-course-status {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: .25rem;
          margin: .65rem 0 .9rem;
          padding: .65rem .8rem;
          border: 1px solid #cbd5e1;
          border-radius: .5rem;
          background: rgba(255, 255, 255, .82);
          color: #33425d;
          font-size: 12px;
        }
        .comparison-course-status p { margin: 0; }
        .comparison-course-status strong { color: #2f1c57; }
        .comparison-course-status span { display: block; margin-top: .2rem; font-size: 14px; }
        .result-status-value { font-weight: 700; }
        .comparison-heading-row {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 1.5rem;
          margin: .55rem 0 1rem;
        }
        .comparison-heading-row h1 {
          margin: 0;
          color: #2f1c57;
          font-size: clamp(29px, 3vw, 42px);
          line-height: 1.05;
          letter-spacing: -.035em;
        }
        .comparison-heading-row p {
          margin: .45rem 0 0;
          color: #53627a;
          font-size: 15px;
        }
        .difference-toggle {
          display: flex;
          align-items: center;
          gap: .6rem;
          flex: 0 0 auto;
          color: #2f1c57;
          font-size: 14px;
          cursor: pointer;
        }
        .difference-toggle input {
          width: 2.7rem;
          height: 1.45rem;
          accent-color: #4b2e83;
          cursor: pointer;
        }
        .comparison-difference-key {
          margin: -.35rem 0 1rem;
          padding: .65rem .8rem;
          border: 1px solid #b8cdf4;
          border-radius: .5rem;
          background: #f3f7ff;
          color: #33425d;
          font-size: 13px;
        }
        .comparison-difference-key strong { color: #4169a6; }
        .comparison-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
          gap: 1rem;
          align-items: stretch;
        }
        .comparison-plan-card {
          display: flex;
          min-width: 0;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid #bdc9da;
          border-radius: .7rem;
          background: rgba(255, 255, 255, .96);
          box-shadow: 0 .45rem 1.2rem rgba(20, 44, 92, .06);
        }
        .comparison-plan-card.is-selected {
          border-color: #8e7aa6;
          box-shadow: 0 .65rem 1.5rem rgba(75, 46, 131, .12);
        }
        .comparison-plan-summary {
          min-height: 8rem;
          padding: 1.15rem 1.15rem .9rem;
          text-align: center;
        }
        .plan-title-row {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: .6rem;
          flex-wrap: wrap;
        }
        .comparison-plan-summary h2 {
          margin: 0;
          color: #2f1c57;
          font-size: 25px;
          line-height: 1.1;
        }
        .comparison-plan-summary p {
          max-width: 26rem;
          margin: .65rem auto 0;
          color: #41506a;
          font-size: 13px;
          line-height: 1.45;
        }
        .plan-strategy-badge {
          padding: .35rem .55rem;
          border: 1px solid #9dc7ff;
          border-radius: .4rem;
          background: #f3f8ff;
          color: #4b2e83;
          font-size: 12px;
        }
        .comparison-plan-card:nth-child(3) .plan-strategy-badge {
          border-color: #94cfbd;
          background: #f1fbf7;
          color: #087257;
        }
        .compact-schedule {
          width: calc(100% - 1.4rem);
          margin: 0 .7rem .85rem;
          border-collapse: collapse;
          table-layout: fixed;
          font-size: 11px;
        }
        .compact-schedule th,
        .compact-schedule td {
          padding: .38rem .42rem;
          border: 1px solid #d2dbe6;
          text-align: left;
          vertical-align: top;
        }
        .compact-schedule th {
          background: #eef7fc;
          color: #17345b;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: .035em;
        }
        .compact-schedule th:first-child,
        .compact-schedule td:first-child { width: 30%; white-space: nowrap; }
        .compact-schedule th:nth-child(2),
        .compact-schedule td:nth-child(2) { width: 24%; }
        .compact-schedule td:last-child {
          color: #111d36;
          font-weight: 700;
          line-height: 1.35;
          overflow-wrap: normal;
          word-break: normal;
        }
        .comparison-shared-course {
          color: #4169a6;
          font-weight: 500;
        }
        .comparison-empty-term {
          color: #68758a;
          font-weight: 500;
        }
        .plan-validation {
          margin: auto .9rem .7rem;
          color: #087257;
          font-size: 11px;
          font-weight: 700;
          text-align: center;
        }
        .plan-validation.is-invalid { color: #a52a1f; }
        .comparison-page .plan-section {
          margin-top: 1rem;
          padding: 1rem;
          border: 1px solid #bdc9da;
          border-radius: .7rem;
          background: rgba(255, 255, 255, .96);
        }
        .comparison-page .plan-tabs {
          display: flex;
          gap: .4rem;
          margin-bottom: 1rem;
          border-bottom: 1px solid #cbd5e1;
        }
        .comparison-page .plan-tab {
          width: auto;
          margin: 0;
          padding: .65rem .9rem;
          border: 0;
          border-bottom: 3px solid transparent;
          background: transparent;
          color: #41506a;
          cursor: pointer;
        }
        .comparison-page .plan-tab.is-active {
          border-bottom-color: #4b2e83;
          color: #2f1c57;
          font-weight: 700;
        }
        .comparison-page .academic-year-group { margin-top: 1rem; }
        .comparison-page .academic-year-label { margin: 0 0 .55rem; color: #4b2e83; font-size: 17px; }
        .comparison-page .plan-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .8rem; }
        .comparison-page .term-card { min-width: 0; min-height: 8rem; padding: .8rem; border: 1px solid #cbd5e1; border-radius: .5rem; }
        .comparison-page .term-card.is-placeholder { border-style: dashed; background: #f7fbff; }
        .comparison-page .term-card h4 { margin: 0 0 .65rem; color: #17345b; }
        .comparison-page .term-card ul { display: grid; gap: .55rem; margin: 0; padding: 0; list-style: none; }
        .comparison-page .term-card li { padding: .55rem; border: 1px solid #d2dbe6; border-radius: .35rem; }
        .comparison-page .plan-course-summary strong,
        .comparison-page .plan-course-summary span { display: block; }
        .comparison-page .plan-course-summary span { margin-top: .15rem; color: #53627a; font-size: 12px; }
        .comparison-page .plan-course-summary .plan-course-availability { font-weight: 700; }
        .comparison-page .plan-course-availability.is-open,
        .comparison-page .schedule-availability .is-open { color: #167c32; font-weight: 700; }
        .comparison-page .plan-course-availability.is-full,
        .comparison-page .schedule-availability .is-full { color: #b42318; font-weight: 700; }
        .comparison-page .plan-course-availability.is-unavailable,
        .comparison-page .schedule-availability .is-unavailable { color: #53627a; }
        .comparison-page .plan-course-summary .plan-course-approval { color: #8a4c00; font-weight: 700; }
        .comparison-page .plan-course-actions { display: grid; gap: .35rem; margin-top: .5rem; }
        .comparison-page .plan-course-actions select,
        .comparison-page .plan-course-actions button { width: 100%; min-height: 2rem; font-size: 12px; }
        .comparison-page .plan-course-actions button { border: 1px solid #b64235; background: #fff; color: #8d251b; }
        .comparison-page .plan-course-edit-feedback { padding: .45rem .55rem; border: 1px solid #c85a4c; border-radius: .25rem; background: #fff2ef; color: #6f2119; font-weight: 600; }
        .comparison-page .plan-validation-errors { margin-top: 1rem; padding: .8rem; border: 1px solid #c85a4c; background: #fff2ef; color: #6f2119; }
        .comparison-page .plan-validation-errors ul { margin: .45rem 0 0; padding-left: 1.2rem; }
        .plan-edit-status { margin: .75rem 0; color: #33425d; }
        .candidate-outcomes { margin: 1rem 0; padding: .9rem 1rem; border: 1px solid #cfd8e6; border-radius: 12px; background: rgba(255,255,255,.8); }
        .candidate-outcomes h2 { margin: 0 0 .5rem; font-size: 1rem; }
        .candidate-outcomes ul { margin: 0; padding-left: 1.2rem; }
        .candidate-outcomes p { margin: .55rem 0 0; }
        .schedule-availability { margin: 1rem 0; padding: .8rem 1rem; border: 1px solid #cfd8e6; border-radius: 12px; background: rgba(255,255,255,.8); }
        .schedule-availability summary { cursor: pointer; font-weight: 700; }
        .schedule-availability h3 { margin: .75rem 0 .25rem; font-size: .95rem; }
        .schedule-availability ul { margin: 0; padding-left: 1.2rem; }
        .schedule-availability-note { margin: .8rem 0 0; color: #53627a; font-size: 12px; }
        .choose-plan-button {
          width: calc(100% - 2rem);
          min-height: 0;
          margin: 0 1rem 1rem;
          padding: .72rem 1rem;
          border: 1px solid #6d5a86;
          border-radius: .42rem;
          background: #fff;
          color: #2f1c57;
          font-size: 16px;
          font-weight: 700;
          cursor: pointer;
        }
        .choose-plan-button:hover { background: #f2eef7; }
        .comparison-plan-card.is-selected .choose-plan-button {
          border-color: transparent;
          background: #4b2e83;
          color: #fff;
        }
        .comparison-plan-card.is-selected .choose-plan-button:hover {
          background: #2f1c57;
        }
        .comparison-empty {
          padding: 1.25rem;
          border: 1px solid #bdc9da;
          border-radius: .7rem;
          background: #fff;
          color: #41506a;
        }
        .result-progress ol { display: flex; gap: .65rem; margin: 0; padding: 0; list-style: none; }
        .result-progress li { color: #667085; font-size: 14.4px; }
        .result-progress li::before { content: "✓ "; color: #4b2e83; }
        .result-progress li.is-current { color: #18202b; font-weight: 700; }
        .result-progress li.is-current::before { content: "● "; }
        .result-progress button {
          margin: 0;
          padding: 0;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
        }
        .no-plan-state {
          padding: 1.25rem;
          border: 1px solid #bdc9da;
          border-radius: .7rem;
          background: #fff;
        }
        .no-plan-state h2 { margin: 0; color: #18202b; font-size: 22px; line-height: 1.3; }
        .no-plan-state > p { color: #53627a; line-height: 1.5; }
        .no-plan-question-list, .no-plan-action-list { margin: .8rem 0; padding-left: 1.25rem; }
        .no-plan-primary {
          width: auto;
          min-height: 42px;
          padding: .65rem .9rem;
          border: 1px solid #172a40;
          border-radius: 7px;
          background: #2f1c57;
          color: #fff;
          font-weight: 700;
          cursor: pointer;
        }
        .result-diagnostics {
          margin-top: 1rem;
          padding: .75rem .9rem;
          border: 1px solid #cfd8e6;
          border-radius: 9px;
          background: #fff;
          color: #33425d;
        }
        .result-diagnostics > summary { cursor: pointer; color: #4b2e83; font-weight: 700; }
        .result-diagnostics .candidate-outcomes,
        .result-diagnostics .planning-gaps { margin: .75rem 0 0; }
        .comparison-actions .clear-all-results { color: #5a397d; }
        .accelerated-result {
          margin: 0 0 1rem;
          padding: 1rem 1.1rem;
          border-left: 4px solid #4f2d7f;
          border-radius: 8px;
          background: #f5f1fa;
        }
        .accelerated-result h2 { margin: 0; font-size: 18px; color: #302044; }
        .accelerated-result p { margin: .35rem 0 0; color: #4c4357; line-height: 1.45; }
        .accelerated-result-status { display: inline-block; margin-left: .35rem; color: #4f2d7f; }
        .planning-guide-disclaimer { margin: 1.2rem 0 0; color: #626a75; font-size: 13px; text-align: center; }
        .comparison-page .advisor-attention,
        .comparison-page .plan-notes {
          margin: 1rem 0;
          padding: .8rem 1rem;
          border: 1px solid #d7a633;
          border-radius: .55rem;
          background: #fff8e3;
          color: #2b3445;
          font-size: 12px;
        }
        .comparison-page .advisor-attention h2 {
          margin: 0 0 .4rem;
          color: #8b5500;
          font-size: 14px;
        }
        .comparison-page .advisor-attention-scope {
          margin: -.15rem 0 .5rem;
          color: #6b7280;
          font-size: 11px;
          font-style: italic;
        }
        .comparison-page .advisor-attention h3 {
          margin: 0;
          color: #1d4ed8;
          font-size: 13px;
        }
        .comparison-page .advisor-attention h4 {
          margin: 0 0 .3rem;
          color: #714600;
          font-size: 12px;
        }
        .comparison-page .advisor-attention-item + .advisor-attention-item {
          margin-top: .5rem;
          padding-top: .5rem;
          border-top: 1px solid #e4c679;
        }
        .comparison-page .advisor-attention-item p { margin: .25rem 0 0; }
        .comparison-page .advisor-attention-groups {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: .65rem 1rem;
          margin-top: .5rem;
        }
        .comparison-page .advisor-attention-groups ul {
          margin: .3rem 0 0;
          padding-left: 1rem;
        }
        .comparison-page .projected-placement-list { margin: .35rem 0 0; padding-left: 1rem; }
        .comparison-page .projected-placement-list li + li { margin-top: .15rem; }
        .comparison-page .offering-pattern-note {
          padding-left: .55rem;
          border-left: 3px solid #8fb2ee;
        }
        .comparison-page .planning-gaps {
          margin-top: 1rem;
          border-color: #d17a65;
          background: #fff2ed;
        }
        .comparison-page .plan-notes ul {
          margin: .45rem 0 0;
          padding-left: 1.1rem;
        }
        @media (max-width: 760px) {
          .comparison-grid { grid-template-columns: 1fr; }
          .comparison-course-status { grid-template-columns: 1fr 1fr; }
          .comparison-plan-summary { min-height: 0; }
          .comparison-page .plan-grid { grid-template-columns: 1fr; }
          .comparison-page .advisor-attention-groups { grid-template-columns: 1fr; }
        }
        @media (max-width: 700px) {
          .comparison-topbar {
            align-items: flex-start;
            flex-wrap: wrap;
            padding: .8rem 1rem;
          }
          .comparison-brand { flex-basis: 100%; }
          .comparison-student {
            width: 100%;
            min-width: 0;
            order: 3;
            margin: 0;
          }
          .comparison-actions {
            width: 100%;
            min-width: 0;
            margin: 0;
            flex-wrap: wrap;
          }
          .comparison-actions > button {
            min-width: 0;
            flex: 1 1 9rem;
            white-space: normal;
          }
          .comparison-content { width: min(100% - 1.25rem, 1460px); }
          .comparison-heading-row {
            align-items: flex-start;
            flex-direction: column;
          }
          .comparison-grid,
          .comparison-plan-card { max-width: 100%; min-width: 0; }
          .compact-schedule { font-size: 10px; }
          .compact-schedule th,
          .compact-schedule td {
            white-space: normal !important;
            overflow-wrap: anywhere;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .comparison-page,
          .comparison-page.is-exiting { animation: none; }
        }
      `}</style>

      <header className="comparison-topbar">
        <div className="comparison-brand">
          <Image
            className="comparison-brand-logo"
            src="/urveska-midnight-gold-underlined.png"
            alt="Urveska"
            width={1868}
            height={294}
            priority
          />
          <span>EconPlanner</span>
        </div>
        <nav className="result-progress" aria-label="Planner progress">
          <ol>
            <li><button type="button" onClick={onReviewTimeline}>About you</button></li>
            <li><button type="button" onClick={onEditCourses}>Your courses</button></li>
            <li className="is-current" aria-current="step"><span>Your plans</span></li>
          </ol>
        </nav>
        <div className="comparison-student">
          <strong>{standing}</strong>
          <span aria-hidden="true">·</span>
          <span>Graduation target: {graduationTarget}</span>
        </div>
        <div className="comparison-actions">
          {isPlanView && (
            <>
              <button
                type="button"
                className="download-pdf-button"
                ref={downloadButtonRef}
                disabled={isDownloadingPdf || Boolean(editingPlanCourseKey)}
                onClick={() => onDownloadPdf()}
              >
                {isDownloadingPdf ? "Creating PDF..." : "Download PDF"}
              </button>
              <button type="button" className="compare-plans-button" onClick={onBackToCompare}>
                Compare plans
              </button>
            </>
          )}
          <button
            type="button"
            className="regenerate-plans-button"
            disabled={isGenerating || Boolean(editingPlanCourseKey)}
            onClick={onRegenerate}
          >
            {isGenerating ? "Regenerating..." : "Regenerate plans"}
          </button>
          <button type="button" className="edit-courses-button" onClick={onEditCourses}>
            Edit answers
          </button>
          <button type="button" className="edit-courses-button clear-all-results" onClick={onClearAll}>
            Clear all
          </button>
        </div>
      </header>

      <div className="comparison-content">
        {pdfStatus && <p className="pdf-download-status" role="status" aria-live="polite">{pdfStatus}</p>}
        <button
          type="button"
          className="comparison-back"
          onClick={isPlanView ? onBackToCompare : onEditCourses}
        >
          {isPlanView ? "← Back to plan comparison" : "← Back to course selection"}
        </button>
        <section className="comparison-course-status" aria-label="Selected course status">
          <p><strong>Graduation target</strong><span>{graduationTarget}</span></p>
          <p><strong>Completed</strong><span>{completedCodes.join(" · ") || "None"}</span></p>
          <p><strong>Taking now</strong><span>{inProgressCodes.join(" · ") || "None"}</span></p>
          <p><strong>Overall status</strong><span className="result-status-value">{displayedOverallStatus}</span></p>
        </section>
        {hasProjectedOfferings && <p className="projection-readiness-note">Future course offerings are projected and must be confirmed.</p>}
        <div className="comparison-heading-row">
          <div>
            <h1 ref={resultHeadingRef} tabIndex={-1}>{isPlanView
              ? `Review ${selectedPlan?.label || "your plan"}`
              : plans.length > 1
                ? "Compare your plans"
                : plans.length === 1
                  ? "Your feasible plan"
                  : "Your planning result"}</h1>
            <p>{isPlanView
              ? "Switch plans, adjust one plan, or return to the side-by-side comparison."
              : plans.length > 1
                ? "Same degree requirements; compare pace, course placement and graduation target."
                : plans.length === 1
                  ? "The planner returned one validated schedule for this graduation target."
                  : "Review this result and the next step below."}</p>
          </div>
          {!isPlanView && plans.length > 1 && (
            <label className="difference-toggle">
              <span>Highlight differences</span>
              <input
                type="checkbox"
                checked={highlightDifferences}
                onChange={event => setHighlightDifferences(event.target.checked)}
              />
            </label>
          )}
        </div>

        {highlightDifferences && (
          <p className="comparison-difference-key" role="status">
            <strong>Blue courses are shared by every plan in the same term.</strong> They remain visible so you can compare the complete timeline; the darker courses are the schedule differences to review.
          </p>
        )}

        {planEditStatus && <p className="plan-edit-status" role="status">{planEditStatus}</p>}
        {isPlanView && canUndoPlanEdit && (
          <button
            type="button"
            className="undo-plan-edit-button"
            disabled={Boolean(editingPlanCourseKey)}
            onClick={onUndoPlanEdit}
          >
            Undo last plan edit
          </button>
        )}

        {acceleratedResult && (
          <section className="accelerated-result" aria-labelledby="accelerated-result-heading">
            <h2 id="accelerated-result-heading">
              {acceleratedResult.label}:
              <span className="accelerated-result-status">{({
                POSSIBLE: "Possible",
                NOT_POSSIBLE: "Not possible",
                MORE_INFORMATION_NEEDED: "More information needed"
              })[acceleratedResult.status] || "More information needed"}</span>
            </h2>
            <p><strong>Standard target:</strong> {acceleratedResult.standardTarget}. <strong>Accelerated target:</strong> {acceleratedResult.acceleratedTarget || "To be confirmed"}.</p>
            <p>{acceleratedResult.message}</p>
          </section>
        )}

        {isPlanView ? (
          <PlanTimeline
            plans={plans}
            planningGaps={planningGaps}
            activePlanId={selectedPlan?.id}
            schedule={result?.annualSchedule}
            onSelectPlan={onSelectPlan}
            onEditPlanCourse={onEditPlanCourse}
            editingPlanCourseKey={editingPlanCourseKey || (isGenerating ? "generation-in-progress" : "")}
            planEditFeedback={planEditFeedback}
          />
        ) : plans.length > 0 ? (
          <div className="comparison-grid">
            {plans.map(plan => {
              const rows = rowsByPlan.get(plan.id) || [];
              const selected = selectedPlanId === plan.id;
              const invalid = plan.validation?.valid === false;
              return (
                <article
                  className={`comparison-plan-card${selected ? " is-selected" : ""}`}
                  data-plan-id={plan.id}
                  key={plan.id}
                >
                  <div className="comparison-plan-summary">
                    <div className="plan-title-row">
                      <h2>{plan.label}</h2>
                      <span className="plan-strategy-badge">{planBadge(plan)}</span>
                    </div>
                    <p>{plan.description}</p>
                  </div>

                  {rows.length > 0 ? (
                    <table className="compact-schedule">
                      <thead>
                        <tr>
                          <th>Year</th>
                          <th>Term</th>
                          <th>Courses</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(row => (
                          <tr key={`${plan.id}-${row.key}`}>
                            {row.yearRowSpan && <td rowSpan={row.yearRowSpan}>{row.academicYear}</td>}
                            <td>{row.term}</td>
                            <td>
                              {row.courses.length > 0
                                ? row.courses.map((course, index) => (
                                    <span
                                      className={highlightDifferences && sharedCoursesByRow.get(row.key)?.has(course)
                                        ? "comparison-shared-course"
                                        : undefined}
                                      key={`${row.key}-${course}-${index}`}
                                    >
                                      {index > 0 ? ", " : ""}{course}
                                    </span>
                                  ))
                                : <span className="comparison-empty-term">No major course assigned</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}

                  <p className={`plan-validation${plan.validation?.valid === false ? " is-invalid" : ""}`}>
                    {planReadinessLabel(plan)}
                  </p>
                  <button
                    type="button"
                    className="choose-plan-button"
                    aria-pressed={selected}
                    onClick={() => onChoosePlan(plan.id)}
                  >
                    {invalid
                      ? `Review ${plan.label} issues`
                      : selected
                        ? `Review selected ${plan.label}`
                        : `Choose ${plan.label}`}
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <section className="no-plan-state" aria-live="polite">
            <h2>{noPlan.title}</h2>
            <p>{noPlan.message}</p>
            {canonicalPlanResult?.questions?.length > 0 && (
              <ul className="no-plan-question-list">
                {canonicalPlanResult.questions.map((question, index) => (
                  <li key={question.id || `${question.code || "question"}-${index}`}>
                    {structuredItemText(question, "Provide the requested planning detail.")}
                  </li>
                ))}
              </ul>
            )}
            {canonicalPlanResult?.actions?.length > 0 && (
              <ul className="no-plan-action-list">
                {canonicalPlanResult.actions.map((action, index) => (
                  <li key={action.id || `${action.code || "action"}-${index}`}>
                    {structuredItemText(action, "Review this planning item with your advisor.")}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="no-plan-primary"
              onClick={noPlan.actionTarget === "timeline" ? onReviewTimeline : onEditCourses}
            >
              {noPlan.action}
            </button>
          </section>
        )}

        {selectedPlan && (
          <>
            <AdvisorAttention catalog={report?.catalog} plan={selectedPlan} schedule={result?.annualSchedule} />
            <ScheduleAvailability schedule={result?.annualSchedule} plan={selectedPlan} />
          </>
        )}

        <ResultDiagnostics
          outcomes={candidateOutcomes}
          convergences={convergences}
          planningGaps={planningGaps}
          planResult={canonicalPlanResult}
          planCount={plans.length}
        />
        <p className="planning-guide-disclaimer">EconPlanner is a planning guide, not an official degree audit.</p>
      </div>
    </main>
  );
}

function SummaryCourseCodes({ courses = [] }) {
  if (!courses.length) return <span className="summary-none">None selected</span>;
  const visible = courses.slice(0, 5);
  if (courses.length <= visible.length) return <span>{visible.join(" · ")}</span>;
  return (
    <>
      <span>{visible.join(" · ")}</span>
      <details className="summary-show-all">
        <summary>Show all {courses.length}</summary>
        <span>{courses.join(" · ")}</span>
      </details>
    </>
  );
}

function planReadinessLabel(plan) {
  const readiness = plan?.readinessStatus || plan?.validation?.readinessStatus || "";
  const disposition = plan?.planDisposition || plan?.validation?.planDisposition || "";
  if (readiness === "ADVISOR_ACTION_REQUIRED" || disposition.includes("ADVISOR_ACTION_REQUIRED")) {
    return "Needs advisor attention";
  }
  if (readiness === "READY_WITH_CONDITIONS" || disposition.includes("READY_WITH_CONDITIONS")) {
    return "Ready with conditions";
  }
  if (readiness === "STUDENT_READY" || disposition.includes("STUDENT_READY")) return "Ready to plan";
  return "Needs advisor attention";
}

function overallPlanReadiness(plans = []) {
  const labels = plans.map(planReadinessLabel);
  if (labels.includes("Needs advisor attention")) return "Needs advisor attention";
  if (labels.includes("Ready with conditions")) return "Ready with conditions";
  return plans.length ? "Ready to plan" : "Not available";
}

function noPlanPresentation(category) {
  if (category === "INPUT_BLOCKED") {
    return {
      title: "We need one more detail before we can build your plan.",
      message: "Review the question below. Your previous answers are still saved.",
      action: "Review my answers"
    };
  }
  if (category === "INFEASIBLE_PROVEN") {
    return {
      title: "No complete plan fits this graduation target under the current requirements and course timing.",
      message: "Review your graduation timeline and bring this result to your academic advisor.",
      action: "Review graduation timeline",
      actionTarget: "timeline"
    };
  }
  if (category === "SEARCH_INCOMPLETE") {
    return {
      title: "We could not finish checking every possible plan.",
      message: "This does not mean a plan is impossible. Review your answers or ask an advisor to help check the remaining possibilities.",
      action: "Review my answers"
    };
  }
  return {
    title: "This planning result needs advisor attention before we can show a complete schedule.",
    message: "Your answers are saved. Review the details below with your academic advisor.",
    action: "Review my answers"
  };
}

function ResultDiagnostics({ outcomes, convergences, planningGaps, planResult, planCount = 0 }) {
  const blockingReasons = !planCount && planResult?.category === "INFEASIBLE_PROVEN"
    ? planResult.evidence?.blockingReasons || [] : [];
  const hasDiagnostics = outcomes.length || convergences.length || planningGaps.length || planResult?.evidence;
  if (!hasDiagnostics) return null;
  return (
    <details className="result-diagnostics">
      <summary>{planCount ? "Why am I seeing these plans?" : "Why am I seeing this result?"}</summary>
      {blockingReasons.length ? <ul>{blockingReasons.map(reason => <li key={reason.code}>{reason.message}</li>)}</ul> : <>
        <CandidateOutcomes outcomes={outcomes} convergences={convergences} />
        <PlanningGaps items={planningGaps} />
      </>}
    </details>
  );
}

function ClearAllDialog({ open, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      className="clear-all-dialog"
      aria-labelledby="clear-all-title"
      onCancel={event => {
        event.preventDefault();
        onCancel();
      }}
    >
      <style jsx global>{`
        .clear-all-dialog { display: block; width: min(calc(100% - 2rem), 28rem); padding: 1.25rem; border: 1px solid #cfc8dc; border-radius: 12px; box-shadow: 0 18px 50px rgba(29,20,48,.25); color: #201b2b; }
        .clear-all-dialog::backdrop { background: rgba(22,16,33,.45); }
        .clear-all-dialog h2 { margin: 0; font-size: 21px; }
        .clear-all-dialog p { margin: .65rem 0 1rem; line-height: 1.45; }
        .clear-all-dialog-actions { display: flex; justify-content: flex-end; gap: .65rem; }
        .clear-all-dialog button { min-height: 42px; padding: .55rem .9rem; border: 1px solid #7c708f; border-radius: 7px; background: #fff; color: #2f1c57; font-weight: 700; cursor: pointer; }
        .clear-all-dialog .confirm-clear-all { border-color: #2f1c57; background: #2f1c57; color: #fff; }
        @media (max-width: 520px) {
          .clear-all-dialog { width: calc(100% - 1.5rem); padding: 1rem; }
          .clear-all-dialog-actions { display: grid; grid-template-columns: 1fr 1fr; }
        }
      `}</style>
      <h2 id="clear-all-title">Clear all answers and generated plans?</h2>
      <p>This returns EconPlanner to a blank first page on this browser.</p>
      <div className="clear-all-dialog-actions">
        <button type="button" ref={cancelRef} onClick={onCancel}>Cancel</button>
        <button type="button" className="confirm-clear-all" onClick={onConfirm}>Clear all</button>
      </div>
    </dialog>
  );
}

function PlannerSummary({
  courses,
  formData,
  planningContext,
  planningStart,
  attentionItems = [],
  intakeStep,
  isGenerating,
  status,
  migrationNotice,
  generateButtonRef,
  onContinue,
  onFocusAttention,
  onClearAll
}) {
  const completedCodes = courses.filter(isTaken).map(course => course.code);
  const inProgressCodes = courses.filter(course => course.status === "in_progress").map(course => course.code);
  const earlyContext = planningContext?.earlyComparisonRequested
    ? buildEarlyGraduationContext(planningContext)
    : null;
  const hasStanding = Boolean(formData.academicStanding);
  const standardPlanningContext = hasStanding
    ? resolvePlanningContext({
        ...formData,
        isTransferStudent: false,
        customGraduationEnabled: false,
        planningPace: PLANNING_PACES.STANDARD
      })
    : null;

  return (
    <aside className="summary-card cp7-summary" aria-labelledby="plan-setup-heading">
      <h2 id="plan-setup-heading">Your plan setup</h2>
      <dl className="summary-details">
        <div>
          <dt>Class standing</dt>
          <dd>{hasStanding ? STANDING_LABELS[formData.academicStanding] : "Choose your standing"}</dd>
        </div>
        <div>
          <dt>Standard graduation target</dt>
          <dd>{standardPlanningContext?.expectedGraduationTerm || "To be confirmed"}</dd>
        </div>
        {earlyContext?.expectedGraduationTerm && (
          <div>
            <dt>One-year-early target</dt>
            <dd>{earlyContext.expectedGraduationTerm}</dd>
          </div>
        )}
        {planningContext.customGraduationEnabled && (
          <div>
            <dt>Custom graduation target</dt>
            <dd>{planningContext.customGraduationValidation.valid ? planningContext.expectedGraduationTerm : "Needs more information"}</dd>
          </div>
        )}
        <div>
          <dt>Planning starts</dt>
          <dd>{hasStanding ? planningStart : "To be confirmed"}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd><SummaryCourseCodes courses={completedCodes} /></dd>
        </div>
        <div>
          <dt>Taking now</dt>
          <dd><SummaryCourseCodes courses={inProgressCodes} /></dd>
        </div>
        {formData.studyAbroadTerm && (
          <div>
            <dt>Study abroad</dt>
            <dd>No Economics courses in {planningSlotsLabel(formData.studyAbroadTerm, planningContext)}</dd>
          </div>
        )}
        {Object.entries(formData.reservedCourseUnits || {}).some(([, value]) => Number(value) > 0) && (
          <div>
            <dt>Room for other courses</dt>
            <dd>{Object.entries(formData.reservedCourseUnits)
              .filter(([slotId, value]) => Number(value) > 0 && slotId !== formData.studyAbroadTerm)
              .map(([slotId, value]) => `${planningSlotsLabel(slotId, planningContext)}: ${value}`)
              .join(" · ") || "Study-abroad term only"}</dd>
          </div>
        )}
      </dl>

      {(migrationNotice || attentionItems.length > 0) && (
        <div className="summary-attention" aria-live="polite">
          <strong>Needs attention</strong>
          {migrationNotice && <p>{migrationNotice}</p>}
          {attentionItems.length > 0 && (
            <ul>
              {attentionItems.map(item => (
                <li key={`${item.target}-${item.message}`}>
                  <button type="button" onClick={() => onFocusAttention(item)}>{item.message}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {status && <p className="summary-status" role="status" aria-live="polite">{status}</p>}
      <button type="button" className="clear-all-button" onClick={onClearAll}>Clear all</button>
      {intakeStep === 1 ? (
        <button key="continue" type="button" className="primary-action" onClick={onContinue}>
          Continue to your courses
        </button>
      ) : (
        <button
          key="generate"
          type="submit"
          className="primary-action generate-button"
          ref={generateButtonRef}
          disabled={isGenerating}
        >
          {isGenerating ? "Generating plans…" : "Generate my plans"}
        </button>
      )}
    </aside>
  );
}

export default function Page() {
  const [formData, setFormData] = useState(initialForm);
  const courseAccordionRefs = useRef({});
  const generatedInputSignatureRef = useRef("");
  const generationInFlightRef = useRef(false);
  const generationRequestRef = useRef(0);
  const generationAbortRef = useRef(null);
  const planEditInFlightRef = useRef(false);
  const pdfDownloadInFlightRef = useRef(false);
  const pdfDownloadAbortRef = useRef(null);
  const pdfOperationRef = useRef(null);
  const generateButtonRef = useRef(null);
  const planEditTriggerRef = useRef(null);
  const downloadButtonRef = useRef(null);
  const [failureFocusTarget, setFailureFocusTarget] = useState("");
  const latestFormRef = useRef(initialForm);
  const [courseSearch, setCourseSearch] = useState("");
  const [completionSourceCourseCode, setCompletionSourceCourseCode] = useState("");
  const [intakeStep, setIntakeStep] = useState(1);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [migrationNotice, setMigrationNotice] = useState("");
  const [inputBlock, setInputBlock] = useState(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState(null);
  const [plannerView, setPlannerView] = useState(PLANNER_VIEWS.INPUT);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [pdfStatus, setPdfStatus] = useState("");
  const [editingPlanCourseKey, setEditingPlanCourseKey] = useState("");
  const [planEditStatus, setPlanEditStatus] = useState("");
  const [planEditFeedback, setPlanEditFeedback] = useState(null);
  const [planEditUndo, setPlanEditUndo] = useState(null);
  const [isComparisonExiting, setIsComparisonExiting] = useState(false);
  const planningContext = resolvePlanningContext(formData);
  const planningSlots = buildPlanningSlots(planningContext);
  const juniorStudyAbroadSlots = planningSlots.filter(slot => !slot.isSummer && slot.absoluteStandingIndex === 2);
  const planningSlotIdSignature = planningSlots.map(slot => slot.id).join("|");
  const planningStart = planningSlots[0]?.label || "To be confirmed";
  const inputPrerequisiteValidation = validateStudentPrerequisites(formData.courses, COURSE_PREREQUISITES);
  const transferOptions = transferPlanningOptions(planningContext);
  const standingQuestion = planningContext.isSummer
    ? "What year will you be in this fall?"
    : "What year are you in this academic year?";
  const standingHelp = planningContext.isSummer
    ? `Choose the year you'll start in Fall ${planningContext.startYear}.`
    : `Choose your year for the ${formatAcademicYearCompact(planningContext.startYear)} academic year.`;
  latestFormRef.current = formData;

  function updatePlanCreationDate(current, planCreationDate) {
    const next = {
      ...current,
      planCreationDate,
      planCreationDateEdited: true
    };
    if (!current.isTransferStudent) return next;

    const nextContext = resolvePlanningContext(next);
    const nextOptions = transferPlanningOptions(nextContext);
    const selectedGraduationYear = Number(current.transferExpectedGraduationYear);
    const graduationYearStillValid = selectedGraduationYear >= nextContext.startYear + 1
      && selectedGraduationYear <= nextContext.startYear + 5;
    return {
      ...next,
      transferExpectedGraduationYear: graduationYearStillValid
        ? current.transferExpectedGraduationYear
        : "",
      transferEntryAcademicYear: nextOptions.entryAcademicYears.includes(current.transferEntryAcademicYear)
        ? current.transferEntryAcademicYear
        : ""
    };
  }

  function plannerUrl(view, planId = "") {
    const url = new URL(window.location.href);
    if (view === PLANNER_VIEWS.INPUT) {
      url.searchParams.delete("view");
      url.searchParams.delete("plan");
    } else {
      url.searchParams.set("view", view);
      if (view === PLANNER_VIEWS.PLAN && planId) url.searchParams.set("plan", planId);
      else url.searchParams.delete("plan");
    }
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function navigatePlanner(nextView, nextPlanId = selectedPlanId, { replace = false } = {}) {
    const plans = economicsResult(report)?.economicsPlans || [];
    const safePlanId = plans.some(plan => plan.id === nextPlanId)
      ? nextPlanId
      : plans[0]?.id || "";
    const safeView = nextView === PLANNER_VIEWS.INPUT || report
      ? nextView
      : PLANNER_VIEWS.INPUT;
    const historyState = {
      econPlanner: true,
      view: safeView,
      planId: safePlanId,
      previousView: plannerView
    };
    if (!replace && plannerView === PLANNER_VIEWS.COMPARE && nextView === PLANNER_VIEWS.PLAN) {
      window.history.replaceState(
        { ...window.history.state, econPlanner: true, view: plannerView, planId: safePlanId },
        "",
        plannerUrl(plannerView, safePlanId)
      );
    }
    window.history[replace ? "replaceState" : "pushState"](
      historyState,
      "",
      plannerUrl(safeView, safePlanId)
    );
    setSelectedPlanId(safePlanId);
    setPlannerView(safeView);
    setPlanEditStatus("");
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
  }

  useEffect(() => {
    let restoredForm = { ...initialForm, planCreationDate: localToday() };
    let restoredCourseSearch = "";
    let restoredIntakeStep = 1;

    try {
      const saved = window.localStorage.getItem(PLANNER_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.formData && Array.isArray(parsed.formData.courses)) {
          const {
            entryCatalogYear: _entryCatalogYear,
            summerStandingConfirmed: _summerStandingConfirmed,
            ...savedFormData
          } = parsed.formData;
          const migrated = migratePlannerInputState(savedFormData);
          const savedPlanCreationDateEdited = savedFormData.planCreationDateEdited === true;
          restoredForm = {
            ...restoredForm,
            ...migrated.formData,
            courses: migrateSavedCourses(migrated.formData.courses),
            planCreationDate: savedPlanCreationDateEdited && migrated.formData.planCreationDate
              ? migrated.formData.planCreationDate
              : localToday(),
            planCreationDateEdited: savedPlanCreationDateEdited
          };
          const savedMigrationNotice = migrated.notices[0]?.message;
          if (savedMigrationNotice) setMigrationNotice(savedMigrationNotice);
        }
        if (typeof parsed.courseSearch === "string") restoredCourseSearch = parsed.courseSearch;
        if (parsed.intakeStep === 2) restoredIntakeStep = 2;
      }
    } catch {
      window.localStorage.removeItem(PLANNER_STORAGE_KEY);
    }

    setFormData(restoredForm);
    setCourseSearch(restoredCourseSearch);
    setIntakeStep(restoredIntakeStep);

    const requestedView = plannerViewFromSearch(window.location.search);
    const restoredSession = restoreGeneratedPlannerSession(
      window.sessionStorage.getItem(GENERATED_PLANNER_SESSION_KEY),
      plannerInputSignature(restoredForm)
    );
    let initialView = PLANNER_VIEWS.INPUT;
    let initialPlanId = "";
    if (restoredSession) {
      setReport(restoredSession.report);
      setInputBlock(restoredSession.inputBlock);
      generatedInputSignatureRef.current = restoredSession.inputSignature;
      initialPlanId = new URLSearchParams(window.location.search).get("plan") || restoredSession.selectedPlanId;
      const plans = economicsResult(restoredSession.report)?.economicsPlans || [];
      if (!plans.some(plan => plan.id === initialPlanId)) initialPlanId = plans[0]?.id || "";
      const restoredView = requestedView === PLANNER_VIEWS.INPUT ? restoredSession.view : requestedView;
      initialView = restoredView === PLANNER_VIEWS.PLAN && !plans.length
        ? PLANNER_VIEWS.COMPARE
        : restoredView;
      setSelectedPlanId(initialPlanId);
      setPlannerView(initialView);
      setPlanEditUndo(restoredSession.planEditUndo);
    } else {
      window.sessionStorage.removeItem(GENERATED_PLANNER_SESSION_KEY);
      if (requestedView !== PLANNER_VIEWS.INPUT) {
        setStatus("That generated plan is no longer available. Review your saved inputs and generate new plans.");
      }
    }

    window.history.replaceState(
      { econPlanner: true, view: initialView, planId: initialPlanId, previousView: null },
      "",
      plannerUrl(initialView, initialPlanId)
    );
    window.history.scrollRestoration = "manual";
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;

    try {
      window.localStorage.setItem(PLANNER_STORAGE_KEY, JSON.stringify({
        schemaVersion: PLANNER_STORAGE_VERSION,
        formData,
        courseSearch,
        intakeStep
      }));
    } catch {
      // Local storage may be unavailable in restricted browser sessions.
    }
  }, [courseSearch, formData, intakeStep, isHydrated]);

  useEffect(() => {
    if (!isHydrated || !formData.studyAbroadTerm) return;
    const valid = planningSlots.some(slot => slot.id === formData.studyAbroadTerm);
    if (valid) return;
    setFormData(current => {
      const restoredUnits = Number(current.reservationMemory?.[current.studyAbroadTerm] || 0);
      const reservedCourseUnits = { ...(current.reservedCourseUnits || {}) };
      if (current.studyAbroadTerm) reservedCourseUnits[current.studyAbroadTerm] = restoredUnits;
      return {
        ...current,
        studyAbroadTerm: "",
        reservedCourseUnits,
        reservationMemory: {}
      };
    });
  }, [formData.studyAbroadTerm, isHydrated, planningSlotIdSignature]);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      if ((report || inputBlock) && generatedInputSignatureRef.current) {
        window.sessionStorage.setItem(GENERATED_PLANNER_SESSION_KEY, JSON.stringify(
          createGeneratedPlannerSession({
            report,
            inputBlock,
            inputSignature: generatedInputSignatureRef.current,
            selectedPlanId,
            view: plannerView,
            planEditUndo
          })
        ));
      } else {
        window.sessionStorage.removeItem(GENERATED_PLANNER_SESSION_KEY);
      }
    } catch {
      // Session storage may be unavailable in restricted browser sessions.
    }
  }, [inputBlock, isHydrated, planEditUndo, plannerView, report, selectedPlanId]);

  useEffect(() => {
    if (!isHydrated) return undefined;

    function handlePlannerHistory(event) {
      const requestedView = event.state?.econPlanner
        ? event.state.view
        : plannerViewFromSearch(window.location.search);
      const plans = economicsResult(report)?.economicsPlans || [];
      const requestedPlanId = event.state?.planId || new URLSearchParams(window.location.search).get("plan");
      if (requestedView === PLANNER_VIEWS.PLAN && !plans.length) {
        setPlannerView(PLANNER_VIEWS.COMPARE);
        setSelectedPlanId("");
        setStatus("");
        window.history.replaceState(
          { econPlanner: true, view: PLANNER_VIEWS.COMPARE, planId: "", previousView: PLANNER_VIEWS.INPUT },
          "",
          plannerUrl(PLANNER_VIEWS.COMPARE)
        );
        return;
      }

      const safePlanId = plans.some(plan => plan.id === requestedPlanId)
        ? requestedPlanId
        : plans[0]?.id || "";
      setSelectedPlanId(safePlanId);
      setPlannerView(requestedView);
      setPlanEditStatus("");
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }

    window.addEventListener("popstate", handlePlannerHistory);
    return () => window.removeEventListener("popstate", handlePlannerHistory);
  }, [isHydrated, report]);

  useEffect(() => () => {
    generationAbortRef.current?.abort();
    pdfDownloadAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    pdfDownloadAbortRef.current?.abort();
    pdfDownloadAbortRef.current = null;
    pdfDownloadInFlightRef.current = false;
    pdfOperationRef.current = null;
    setIsDownloadingPdf(false);
    setPdfStatus("");
  }, [selectedPlanId, report, formData]);

  function restoreFocusAfterFailure(target) {
    setFailureFocusTarget(target);
  }

  useEffect(() => {
    const control = failureFocusTarget === "generate"
      ? generateButtonRef.current
      : failureFocusTarget === "download"
        ? downloadButtonRef.current
        : failureFocusTarget === "plan-edit"
          ? planEditTriggerRef.current
          : null;
    if (!control || isGenerating || isDownloadingPdf || editingPlanCourseKey) return;
    setFailureFocusTarget("");
    window.requestAnimationFrame(() => control.focus());
  }, [editingPlanCourseKey, failureFocusTarget, isDownloadingPdf, isGenerating, pdfStatus, planEditStatus, status]);

  useEffect(() => {
    if ((!report && !inputBlock) || !generatedInputSignatureRef.current) return;
    if (plannerInputSignature(formData) === generatedInputSignatureRef.current) return;
    generationAbortRef.current?.abort();
    generationInFlightRef.current = false;
    generatedInputSignatureRef.current = "";
    setReport(null);
    setInputBlock(null);
    setSelectedPlanId("");
    setPlannerView(PLANNER_VIEWS.INPUT);
    setPlanEditUndo(null);
    setPlanEditStatus("");
    setIsGenerating(false);
    setStatus("");
    window.history.replaceState(
      { econPlanner: true, view: PLANNER_VIEWS.INPUT, planId: "", previousView: null },
      "",
      plannerUrl(PLANNER_VIEWS.INPUT)
    );
  }, [formData, inputBlock, report]);

  function clearInputFeedback() {
    setStatus("");
    setInputBlock(null);
    setMigrationNotice("");
  }

  function clearAllPlanner() {
    generationAbortRef.current?.abort();
    pdfDownloadAbortRef.current?.abort();
    generationInFlightRef.current = false;
    generatedInputSignatureRef.current = "";
    const blankForm = {
      ...initialForm,
      planCreationDate: localToday(),
      courses: SELECTABLE_COURSE_CATALOG.map(blankCourse)
    };
    try {
      window.localStorage.removeItem(PLANNER_STORAGE_KEY);
      window.sessionStorage.removeItem(GENERATED_PLANNER_SESSION_KEY);
    } catch {
      // Browser storage may be unavailable in restricted sessions.
    }
    setFormData(blankForm);
    setCourseSearch("");
    setCompletionSourceCourseCode("");
    setIntakeStep(1);
    setMigrationNotice("");
    setInputBlock(null);
    setStatus("");
    setReport(null);
    setPlannerView(PLANNER_VIEWS.INPUT);
    setSelectedPlanId("");
    setPlanEditUndo(null);
    setPlanEditStatus("");
    setPdfStatus("");
    setIsGenerating(false);
    setIsDownloadingPdf(false);
    setClearDialogOpen(false);
    window.history.replaceState(
      { econPlanner: true, view: PLANNER_VIEWS.INPUT, planId: "", previousView: null },
      "",
      plannerUrl(PLANNER_VIEWS.INPUT)
    );
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  function changeStudyAbroadTerm(nextTermId) {
    setFormData(current => {
      const reservedCourseUnits = { ...(current.reservedCourseUnits || {}) };
      const reservationMemory = { ...(current.reservationMemory || {}) };
      if (current.studyAbroadTerm) {
        reservedCourseUnits[current.studyAbroadTerm] = Number(reservationMemory[current.studyAbroadTerm] || 0);
        delete reservationMemory[current.studyAbroadTerm];
      }
      if (nextTermId) {
        const nextSlot = planningSlots.find(slot => slot.id === nextTermId);
        reservationMemory[nextTermId] = Number(reservedCourseUnits[nextTermId] || 0);
        reservedCourseUnits[nextTermId] = termReservationLimit(nextSlot);
      }
      return {
        ...current,
        studyAbroadTerm: nextTermId,
        reservedCourseUnits,
        reservationMemory
      };
    });
    clearInputFeedback();
  }

  function setCourseStatus(code, nextStatus) {
    setFormData(current => ({
      ...current,
      courses: current.courses.map(course => {
        if (course.code !== code) return course;
        const currentVisibleStatus = visibleCourseStatus(course);
        const status = currentVisibleStatus === nextStatus ? "not_started" : nextStatus;
        return {
          ...course,
          status,
          source: "manual_code"
        };
      })
    }));
    setCompletionSourceCourseCode(current => current === code ? "" : current);
    clearInputFeedback();
  }

  function setCompletionSource(code, source) {
    setFormData(current => ({
      ...current,
      courses: current.courses.map(course => course.code === code
        ? {
            ...course,
            status: source === "transfer_equivalency_unapproved" ? "transfer" : "completed",
            source
          }
        : course)
    }));
    clearInputFeedback();
  }

  function chooseStanding(academicStanding) {
    setFormData(current => {
      const candidate = {
        ...current,
        academicStanding,
        isTransferStudent: false,
        transferExpectedGraduationYear: "",
        transferEntryAcademicYear: ""
      };
      const candidateContext = resolvePlanningContext(candidate);
      return {
        ...candidate,
        planningPace: candidateContext.oneYearEarlyEligible
          ? current.planningPace
          : PLANNING_PACES.STANDARD
      };
    });
    clearInputFeedback();
  }

  function focusAttention(item) {
    if (item.step) setIntakeStep(item.step);
    window.requestAnimationFrame(() => {
      const target = document.getElementById(item.target);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus();
    });
  }

  function continueToCourses() {
    if (!formData.academicStanding) {
      setStatus("Choose your class standing to continue.");
      focusAttention({ step: 1, target: "standing-freshman", message: "Choose your class standing." });
      return;
    }
    if (formData.isTransferStudent && !planningContext.transferValidation.valid) {
      setStatus(planningContext.transferValidation.errors[0]);
      focusAttention({
        step: 1,
        target: !formData.transferExpectedGraduationYear ? "custom-graduation-year" : "custom-entry-year",
        message: planningContext.transferValidation.errors[0]
      });
      return;
    }
    if (formData.customGraduationEnabled && !planningContext.customGraduationValidation.valid) {
      setStatus(planningContext.customGraduationValidation.errors[0]);
      focusAttention({
        step: 1,
        target: "custom-graduation-year",
        message: planningContext.customGraduationValidation.errors[0]
      });
      return;
    }
    setStatus("");
    setIntakeStep(2);
    window.requestAnimationFrame(() => document.getElementById("course-search")?.focus());
  }

  async function mapMajors(event) {
    event?.preventDefault();

    if (generationInFlightRef.current) return;

    if (!formData.academicStanding) {
      setStatus("Choose your class standing before generating your plans.");
      focusAttention({ step: 1, target: "standing-freshman", message: "Choose your class standing." });
      return;
    }

    if (!formData.planCreationDate) {
      setStatus("Enter the plan creation date before generating a plan.");
      focusAttention({ step: 1, target: "plan-creation-date", message: "Enter the plan creation date." });
      return;
    }

    if (formData.isTransferStudent && !planningContext.transferValidation.valid) {
      setStatus(planningContext.transferValidation.errors[0]);
      focusAttention({
        step: 1,
        target: !formData.transferExpectedGraduationYear ? "custom-graduation-year" : "custom-entry-year",
        message: planningContext.transferValidation.errors[0]
      });
      return;
    }
    if (formData.customGraduationEnabled && !planningContext.customGraduationValidation.valid) {
      setStatus(planningContext.customGraduationValidation.errors[0]);
      focusAttention({
        step: 1,
        target: "custom-graduation-year",
        message: planningContext.customGraduationValidation.errors[0]
      });
      return;
    }

    if (!planningContext.planningValidation.valid) {
      setStatus(planningContext.planningValidation.errors[0]);
      return;
    }

    if (!inputPrerequisiteValidation.valid) {
      setStatus("Correct the highlighted prerequisite issues before generating a plan.");
      focusAttention({
        step: 2,
        target: `course-${domId(inputPrerequisiteValidation.issues[0]?.course)}`,
        message: inputPrerequisiteValidation.issues[0]?.message || "Review the prerequisite information."
      });
      return;
    }

    generationInFlightRef.current = true;
    setIsGenerating(true);
    setStatus("Building your economics plan...");
    setPlanEditStatus("");

    const student = {
      ...formData,
      courses: selectedCourses(formData.courses)
    };
    const requestSignature = plannerInputSignature(formData);
    const requestId = generationRequestRef.current + 1;
    generationRequestRef.current = requestId;
    generationAbortRef.current?.abort();
    const controller = new AbortController();
    generationAbortRef.current = controller;

    try {
      const response = await fetch("/api/majors/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ student }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => {
        throw new Error("The planner returned an invalid response. Please try again.");
      });
      if (requestId !== generationRequestRef.current || controller.signal.aborted) return;
      if (!response.ok && data.economicsPlanResult?.category === "INPUT_BLOCKED") {
        generatedInputSignatureRef.current = requestSignature;
        setInputBlock(data);
        setReport(null);
        setSelectedPlanId("");
        setPlannerView(PLANNER_VIEWS.COMPARE);
        window.history.pushState(
          { econPlanner: true, view: PLANNER_VIEWS.COMPARE, planId: "", previousView: plannerView },
          "",
          plannerUrl(PLANNER_VIEWS.COMPARE)
        );
        setStatus("");
        window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
        return;
      }
      if (!response.ok) throw new Error(data.error || "The planner could not complete.");
      if (plannerInputSignature(latestFormRef.current) !== requestSignature) {
        setStatus("Your answers changed while plans were being generated. Generate again with the current answers.");
        return;
      }

      if (!isValidGeneratedPlannerReport(data)) {
        throw new Error("The planner returned an invalid response. Please try again.");
      }
      const plans = economicsResult(data).economicsPlans;
      const firstPlanId = plans[0]?.id || "";
      generatedInputSignatureRef.current = requestSignature;
      setIsComparisonExiting(false);
      setInputBlock(null);
      setReport(data);
      setSelectedPlanId(firstPlanId);
      setPlannerView(PLANNER_VIEWS.COMPARE);
      setPlanEditUndo(null);
      window.history.pushState(
        {
          econPlanner: true,
          view: PLANNER_VIEWS.COMPARE,
          planId: firstPlanId,
          previousView: plannerView
        },
        "",
        plannerUrl(PLANNER_VIEWS.COMPARE, firstPlanId)
      );
      setStatus("");
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      });
    } catch (error) {
      if (requestId === generationRequestRef.current) {
        setStatus(studentFacingRequestError(error, "The planner could not complete. Please try again."));
        restoreFocusAfterFailure("generate");
      }
    } finally {
      if (requestId === generationRequestRef.current) {
        generationInFlightRef.current = false;
        generationAbortRef.current = null;
        setIsGenerating(false);
      }
    }
  }

  async function downloadSelectedPlanPdf() {
    if (pdfDownloadInFlightRef.current) return;
    const selectedPlan = (economicsResult(report)?.economicsPlans || [])
      .find(plan => plan.id === selectedPlanId);
    if (!selectedPlan) {
      setPdfStatus("Choose a plan before downloading its PDF.");
      return;
    }

    pdfDownloadInFlightRef.current = true;
    const controller = new AbortController();
    pdfDownloadAbortRef.current = controller;
    setIsDownloadingPdf(true);
    setPdfStatus("Creating your PDF...");
    if (!pdfOperationRef.current) {
      pdfOperationRef.current = {
        student: { ...formData, courses: selectedCourses(formData.courses) },
        preparedDate: formData.planCreationDate,
        selectedPlan,
        format: "pdf",
        downloadOperationId: crypto.randomUUID()
      };
    }
    try {
      const response = await fetch("/api/reports/economics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pdfOperationRef.current),
        signal: controller.signal
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (result.code === "PDF_REPORT_CHANGED") pdfOperationRef.current = null;
        throw new Error(result.error || "The PDF could not be created.");
      }
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf")) {
        throw new Error("The PDF service returned an invalid response.");
      }

      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = "EconPlanner-Economics-Plan.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setPdfStatus("PDF ready. Download started.");
      pdfOperationRef.current = null;
    } catch (error) {
      if (controller.signal.aborted) return;
      setPdfStatus(studentFacingRequestError(error, "The PDF could not be created.", "The PDF service could not connect. Please try again.", "PDF creation"));
      restoreFocusAfterFailure("download");
    } finally {
      if (pdfDownloadAbortRef.current === controller) {
        pdfDownloadAbortRef.current = null;
        pdfDownloadInFlightRef.current = false;
        setIsDownloadingPdf(false);
      }
    }
  }

  const query = courseSearch.trim().toLowerCase();
  const visibleGroups = COURSE_DISPLAY_GROUPS.filter(group =>
    !query || `${group.code} ${group.title} ${(group.options || []).map(option => `${option.code} ${option.title}`).join(" ")}`.toLowerCase().includes(query)
  );
  const declarationCourseGroups = visibleGroups.filter(group => DECLARATION_COURSE_IDS.includes(group.id));
  const declarationRequirementGroups = visibleGroups.filter(group => DECLARATION_REQUIREMENT_IDS.includes(group.id));
  const sortCourseGroups = groups => [...groups].sort((a, b) => courseLevel(a.code) - courseLevel(b.code) || a.code.localeCompare(b.code));
  const financeGroups = visibleGroups.filter(group => group.id === "finance-requirement");
  const secondaryCourseGroups = sortCourseGroups(visibleGroups.filter(group => !new Set([
    ...DECLARATION_COURSE_IDS,
    ...DECLARATION_REQUIREMENT_IDS,
    "finance-requirement"
  ]).has(group.id)));
  const attentionItems = [];
  if (!formData.academicStanding) {
    attentionItems.push({ step: 1, target: "standing-freshman", message: "Choose your class standing." });
  }
  if (formData.isTransferStudent && !formData.transferExpectedGraduationYear) {
    attentionItems.push({ step: 1, target: "custom-graduation-year", message: "Choose your expected graduation year." });
  }
  if (formData.isTransferStudent && !formData.transferEntryAcademicYear) {
    attentionItems.push({ step: 1, target: "custom-entry-year", message: "Choose when you first enrolled at Hanover." });
  }
  if (formData.customGraduationEnabled && !formData.customExpectedGraduationYear) {
    attentionItems.push({ step: 1, target: "custom-graduation-year", message: "Choose your expected graduation year." });
  }
  for (const issue of inputPrerequisiteValidation.issues) {
    attentionItems.push({
      step: 2,
      target: `course-${domId(issue.course)}`,
      message: issue.message
    });
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      Object.values(courseAccordionRefs.current).forEach(node => {
        if (node) node.open = Boolean(query);
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [query]);

  function renderCourseAccordion(id, label, groups) {
    if (!groups.length) return null;
    return (
      <details
        className="course-accordion"
        key={`${id}-${query}`}
        ref={node => {
          courseAccordionRefs.current[id] = node;
        }}
      >
        <summary>
          <span className="course-accordion-title">{label}</span>
          <span className="course-accordion-count">{groups.length} courses</span>
        </summary>
        {renderCourseColumns(groups)}
      </details>
    );
  }

  function renderStatusControls(code, labelPrefix = code, compact = false, includeUncertain = false) {
    const course = formData.courses.find(item => item.code === code) || blankCourse({ code, title: courseTitle(code), units: 1 });
    const activeStatus = visibleCourseStatus(course);
    const statusChoices = [
      ["completed", "Completed"],
      ["in_progress", "Taking now"],
      ...(includeUncertain ? [["uncertain", "Not taken / not sure"]] : [])
    ];
    return (
      <div className={`course-toggles${compact ? " is-compact" : ""}${includeUncertain ? " has-three" : ""}`} role="group" aria-label={`Status for ${labelPrefix}`}>
        {statusChoices.map(([value, label]) => {
          const selected = activeStatus === value;
          return (
            <button
              type="button"
              className={`course-toggle is-${value}${selected ? " is-selected" : ""}`}
              aria-pressed={selected}
              key={value}
              onClick={() => setCourseStatus(code, value)}
            >
              <span className="selection-check" aria-hidden="true">{selected ? "✓" : ""}</span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  function renderPrerequisiteFollowUp(course) {
    const targetStatus = course.status;
    if (!["completed", "transfer", "in_progress"].includes(targetStatus)) return null;
    const followUp = buildPrerequisiteFollowUp({
      course: course.code,
      targetStatus,
      courses: formData.courses,
      prerequisites: COURSE_PREREQUISITES
    });
    if (!followUp.required && !followUp.conditionalApprovals.length) return null;
    const hasExplicitConflict = followUp.questions.some(hasExplicitPrerequisiteConflict);

    return (
      <div className={`inline-prerequisite${hasExplicitConflict ? " has-conflict" : ""}`} aria-live="polite">
        {followUp.questions.length > 0 && (
          <p><strong>Before we can use {course.code}, tell us about {followUp.questions.length === 1 ? "this prerequisite" : "these prerequisites"}.</strong></p>
        )}
        {followUp.questions.map(question => (
          <section className="prerequisite-question" key={question.id} aria-labelledby={`${question.id}-label`}>
            <div id={`${question.id}-label`} className="prerequisite-question-heading">
              <strong>{question.kind === "one_of" ? "Choose a prerequisite option" : "Required course"}</strong>
            </div>
            {question.options.map(option => (
              <div className="prerequisite-option" key={option}>
                <div className="prerequisite-name">
                  <strong>{option}</strong>
                  <small>{courseTitle(option)}</small>
                </div>
                {renderStatusControls(option, `prerequisite ${option}`, true, true)}
              </div>
            ))}
            {hasExplicitPrerequisiteConflict(question) && (
              <div className="prerequisite-conflict" role="alert">
                <p>{question.issueMessage}</p>
                <p>You marked {course.code} as {prerequisiteStatusLabel(targetStatus)}, but {explicitPrerequisiteStatusText(question)}.</p>
                <p>Update one of these course statuses before generating your plan.</p>
              </div>
            )}
          </section>
        ))}
        {followUp.conditionalApprovals.map(approval => (
          <p className="prerequisite-approval" key={`${approval.course}-${approval.prerequisite}`}>{approval.message}</p>
        ))}
      </div>
    );
  }

  function renderCourseRow(code, title) {
    const course = formData.courses.find(item => item.code === code);
    const isHanoverOnly = NON_SELECTABLE_COURSE_CODES.has(code);
    if (!course && !isHanoverOnly) return null;
    const completed = course ? visibleCourseStatus(course) === "completed" : false;
    const source = course ? completionSourceLabel(course) : "Hanover College";
    const sourceChoicesOpen = completionSourceCourseCode === code;
    const sourcePanelId = `completion-source-${domId(code)}`;
    return (
      <div className="course-row" id={`course-${domId(code)}`} key={code} tabIndex={-1}>
        <div className="course-row-main">
          <div className="course-name">
            <strong>{code}</strong>
            <span>{title}</span>
          </div>
          {isHanoverOnly ? (
            <span className="course-status-note">Must be taken at Hanover College</span>
          ) : renderStatusControls(code)}
        </div>
        {completed && (
          <div className="completion-source">
            <button
              type="button"
              className="completion-source-trigger"
              aria-expanded={sourceChoicesOpen}
              aria-controls={sourcePanelId}
              onClick={() => setCompletionSourceCourseCode(current => current === code ? "" : code)}
            >
              Transfer or AP credit?
            </button>
            {source !== "Hanover College" && <span className="completion-source-current">Selected: {source}</span>}
            {sourceChoicesOpen && (
              <div className="completion-source-panel" id={sourcePanelId}>
                <div className="completion-source-options" role="group" aria-label={`Completion source for ${code}`}>
                  {[
                    ["manual_code", "Hanover College"],
                    ["transfer_equivalency_unapproved", "Another college / transfer credit"],
                    ...(AP_CREDIT_ALLOWED_COURSE_CODES.has(code) ? [["ap_credit", "AP or exam credit"]] : [])
                  ].map(([value, label]) => {
                    const selected = value === "transfer_equivalency_unapproved"
                      ? course.status === "transfer"
                      : value === "manual_code"
                        ? course.status === "completed" && completionSourceLabel(course) === "Hanover College"
                        : course.status === "completed" && course.source === value;
                    return (
                      <button
                        type="button"
                        className={selected ? "is-selected" : ""}
                        aria-pressed={selected}
                        key={value}
                        onClick={() => setCompletionSource(code, value)}
                      >
                        <span className="selection-check" aria-hidden="true">{selected ? "✓" : ""}</span>
                        {label}
                      </button>
                    );
                  })}
                </div>
                {source !== "Hanover College" && (
                  <p>This credit will stay review-required until its supporting evidence is approved.</p>
                )}
              </div>
            )}
          </div>
        )}
        {course && renderPrerequisiteFollowUp(course)}
      </div>
    );
  }

  function renderCourseGroup(group) {
    if (group.options) {
      return (
        <section className="course-requirement-group" key={group.id} aria-labelledby={`${domId(group.id)}-heading`}>
          <div className="course-requirement-heading" id={`${domId(group.id)}-heading`}>
            <strong>{group.title}</strong>
            <span>Choose the course that applies to you.</span>
          </div>
          {group.options.map(option => renderCourseRow(option.code, option.title))}
        </section>
      );
    }
    return renderCourseRow(group.courseCodes[0], group.title);
  }

  function renderCourseColumns(groups, stackInFirstColumn = false) {
    const midpoint = stackInFirstColumn ? groups.length : Math.ceil(groups.length / 2);
    const leftGroups = groups.slice(0, midpoint);
    const rightGroups = groups.slice(midpoint);
    return (
      <div className="course-columns" style={COURSE_COLUMNS_STYLE}>
        <div className="course-column">{leftGroups.map(renderCourseGroup)}</div>
        <div className="course-column">{rightGroups.map(renderCourseGroup)}</div>
      </div>
    );
  }

  function navigateBackTo(targetView) {
    // Keep in-app navigation in React. A native history traversal can remount
    // Next before the saved view updates and restore the comparison instead.
    navigatePlanner(targetView, selectedPlanId, { replace: true });
  }

  async function editPlanCourse(edit, trigger) {
    if (planEditInFlightRef.current || generationInFlightRef.current) return;
    planEditInFlightRef.current = true;
    planEditTriggerRef.current = trigger;

    try {
      const result = economicsResult(report);
      const plans = result?.economicsPlans || [];
      const sourcePlan = plans.find(plan => plan.id === edit.planId);
      if (!sourcePlan || (edit.type === "move" && edit.fromTermId === edit.toTermId)) return;

      const sourceTerm = sourcePlan.terms.find(term => (term.slotId || term.term) === edit.fromTermId);
      const selectedCourse = sourceTerm?.courses.find(course => planCourseIdentity(course) === edit.courseId);
      if (!selectedCourse) {
        setPlanEditStatus("That course could not be found in the selected plan.");
        return;
      }

      const editKey = `${sourcePlan.id}:${edit.fromTermId}:${edit.courseId}`;

      setEditingPlanCourseKey(editKey);
      setPlanEditFeedback(null);
      setPlanEditStatus("Checking this plan edit against the Economics planning rules...");
      try {
        const response = await fetch("/api/majors/map", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "validate-plan",
            student: {
              ...formData,
              courses: selectedCourses(formData.courses)
            },
            plan: sourcePlan,
            plans,
            edit
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "The plan edit could not be validated.");
        if (!data.plan?.validation?.valid) {
          throw new Error(data.plan?.validation?.errors?.[0] || "That plan change violates the Economics planning rules.");
        }
        if (data.planSetValidation?.valid !== true) {
          throw new Error(data.planSetValidation?.errors?.[0] || "That plan change would make the comparison invalid.");
        }

        setPlanEditUndo({
          planId: sourcePlan.id,
          plan: sourcePlan,
          planSetValidation: result.economicsPlanValidation
        });
        setReport(current => replaceEconomicsPlan(
          current,
          sourcePlan.id,
          data.plan,
          data.planSetValidation
        ));
        setPlanEditStatus(`${sourcePlan.label} was updated and remains valid.`);
      } catch (error) {
        const message = studentFacingRequestError(
          error,
          "The plan edit could not be validated.",
          "The plan edit could not be validated. Please try again."
        );
        setPlanEditStatus(message);
        setPlanEditFeedback({ planId: sourcePlan.id, fromTermId: edit.fromTermId, courseId: edit.courseId, message });
        restoreFocusAfterFailure("plan-edit");
      } finally {
        setEditingPlanCourseKey("");
      }
    } finally {
      planEditInFlightRef.current = false;
    }
  }

  function undoPlanEdit() {
    if (!planEditUndo) return;
    const restoredPlan = planEditUndo.plan;
    setReport(current => replaceEconomicsPlan(
      current,
      planEditUndo.planId,
      restoredPlan,
      planEditUndo.planSetValidation
    ));
    setPlanEditUndo(null);
    setPlanEditStatus(`${restoredPlan.label} was restored.`);
  }

  function returnToInputStep(step) {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const finish = () => {
      setStatus("");
      setInputBlock(null);
      setIntakeStep(step);
      setPlanEditStatus("");
      setIsComparisonExiting(false);
      navigateBackTo(PLANNER_VIEWS.INPUT);
    };

    if (reducedMotion) {
      finish();
      return;
    }
    setIsComparisonExiting(true);
    window.setTimeout(finish, 240);
  }

  function returnToCourseSelection() {
    returnToInputStep(2);
  }

  if (!isHydrated) {
    return (
      <main className="planner-loading" aria-busy="true" aria-label="Loading EconPlanner">
        <style jsx global>{`
          body { margin: 0; background: #f7f8fa; }
          .planner-loading { min-height: 100vh; }
        `}</style>
      </main>
    );
  }

  if (isHydrated && (report || inputBlock) && plannerView !== PLANNER_VIEWS.INPUT) {
    return (
      <>
        <PlanComparisonScreen
          report={report}
          planResult={inputBlock?.economicsPlanResult}
          fallbackPlanningContext={planningContext}
          courses={formData.courses}
          displayName={formData.displayName}
          view={plannerView}
          selectedPlanId={selectedPlanId}
          isExiting={isComparisonExiting}
          isGenerating={isGenerating}
          editingPlanCourseKey={editingPlanCourseKey}
          planEditStatus={planEditStatus}
          planEditFeedback={planEditFeedback}
          canUndoPlanEdit={Boolean(planEditUndo)}
          onEditCourses={returnToCourseSelection}
          onReviewTimeline={() => returnToInputStep(1)}
          onClearAll={() => setClearDialogOpen(true)}
          onBackToCompare={() => navigateBackTo(PLANNER_VIEWS.COMPARE)}
          onChoosePlan={planId => navigatePlanner(PLANNER_VIEWS.PLAN, planId)}
          onSelectPlan={planId => navigatePlanner(PLANNER_VIEWS.PLAN, planId)}
          onRegenerate={() => mapMajors()}
          onDownloadPdf={downloadSelectedPlanPdf}
          downloadButtonRef={downloadButtonRef}
          isDownloadingPdf={isDownloadingPdf}
          pdfStatus={pdfStatus}
          onEditPlanCourse={editPlanCourse}
          onUndoPlanEdit={undoPlanEdit}
        />
        <ClearAllDialog open={clearDialogOpen} onCancel={() => setClearDialogOpen(false)} onConfirm={clearAllPlanner} />
      </>
    );
  }

  return (
    <>
    <main className="container cp7-container">
      <style jsx global>{`
        :root {
          --cp7-ink: #18202b;
          --cp7-muted: #5b6470;
          --cp7-border: #ddd8e4;
          --cp7-border-strong: #8a8096;
          --cp7-surface: #ffffff;
          --cp7-soft: #f7f5f9;
          --cp7-selected: #f0edf7;
          --cp7-accent: #4b2e83;
          --cp7-accent-dark: #2f1c57;
          --cp7-aqua: #2a8f9e;
          --cp7-gold: #b77912;
          --cp7-warning: #fff8e8;
          --cp7-warning-border: #c18b2d;
          --cp7-danger: #8a2c25;
        }
        body {
          margin: 0;
          background: #f1f3f5 !important;
          color: var(--cp7-ink) !important;
          font-family: Arial, sans-serif;
        }
        main.cp7-container {
          box-sizing: border-box;
          width: min(1180px, calc(100% - 2rem));
          max-width: none;
          margin: 0 auto;
          padding: 0 0 4rem;
          color: var(--cp7-ink);
          font-size: 15px;
        }
        main.cp7-container *, main.cp7-container *::before, main.cp7-container *::after { box-sizing: border-box; }
        main.cp7-container button,
        main.cp7-container input,
        main.cp7-container select { font-size: inherit; }
        main.cp7-container button:focus-visible,
        main.cp7-container input:focus-visible,
        main.cp7-container select:focus-visible,
        main.cp7-container summary:focus-visible,
        main.cp7-container [tabindex]:focus-visible {
          outline: 3px solid var(--cp7-aqua);
          outline-offset: 3px;
        }
        .cp7-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 2rem;
          padding: 1rem 0;
          border-bottom: 1px solid var(--cp7-border);
        }
        .cp7-brand-block { display: flex; align-items: flex-start; flex: 0 0 auto; flex-direction: column; gap: .35rem; }
        .cp7-brand-logo { display: block; width: 168px; height: auto; }
        .cp7-brand { margin: 0; color: var(--cp7-accent); font-size: 21px; letter-spacing: -.02em; }
        .cp7-progress ol { display: flex; gap: .4rem; margin: 0; padding: 0; list-style: none; }
        .cp7-progress li {
          display: flex;
          align-items: center;
          gap: .4rem;
          padding: .35rem .55rem;
          color: var(--cp7-muted);
          font-size: 15.6px;
        }
        .cp7-progress li::before {
          width: .52rem;
          height: .52rem;
          border: 1px solid #98a1ab;
          border-radius: 50%;
          background: #fff;
          content: "";
        }
        .cp7-progress li.is-current { color: var(--cp7-ink); font-weight: 700; }
        .cp7-progress li.is-current::before,
        .cp7-progress li.is-complete::before { border-color: var(--cp7-accent); background: var(--cp7-accent); }
        .cp7-progress button {
          margin: 0;
          padding: 0;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
        }
        .cp7-page-heading { padding: 2rem 0 1.25rem; }
        .cp7-page-heading h1 {
          margin: 0;
          color: var(--cp7-ink);
          font-size: clamp(28px, 4vw, 40px);
          letter-spacing: -.035em;
          line-height: 1.08;
        }
        .cp7-page-heading p { max-width: 46rem; margin: .55rem 0 0; color: var(--cp7-muted); font-size: 16px; line-height: 1.5; }
        .cp7-intake-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 1.25rem;
          align-items: start;
        }
        .cp7-left { min-width: 0; }
        main.cp7-container .cp7-task-card,
        main.cp7-container .cp7-summary {
          padding: 1.35rem;
          border: 1px solid var(--cp7-border);
          border-radius: 10px;
          background: var(--cp7-surface);
          box-shadow: 0 3px 12px rgba(27, 39, 51, .045);
        }
        .cp7-task-card h2,
        main.cp7-container .cp7-summary h2 { margin: 0; color: var(--cp7-ink); font-size: 23px; line-height: 1.2; }
        .cp7-task-intro { margin: .45rem 0 1.35rem; color: var(--cp7-muted); line-height: 1.5; }
        .cp7-question-label { display: block; margin-bottom: .65rem; font-weight: 700; }
        .standing-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .55rem; }
        main.cp7-container .standing-option,
        main.cp7-container .early-toggle,
        main.cp7-container .custom-timeline-trigger,
        main.cp7-container .standard-timeline-trigger,
        main.cp7-container .secondary-action {
          width: auto;
          min-height: 44px;
          margin: 0;
          padding: .65rem .8rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 7px;
          background: #fff;
          color: var(--cp7-ink);
          cursor: pointer;
        }
        main.cp7-container .standing-option.is-selected,
        main.cp7-container .early-toggle.is-selected {
          border-color: transparent;
          background: var(--cp7-selected);
          font-weight: 700;
        }
        .standing-feedback { margin: .75rem 0 0; padding: .7rem .8rem; border-left: 3px solid var(--cp7-aqua); background: var(--cp7-soft); color: #344151; }
        .early-option, .custom-timeline-disclosure { margin-top: 1.25rem; padding-top: 1.1rem; border-top: 1px solid var(--cp7-border); }
        .current-term-option { margin-top: 1rem; padding: .75rem .85rem; border: 1px solid var(--cp7-border); border-radius: 7px; background: var(--cp7-soft); }
        .current-term-option label { display: flex; align-items: flex-start; gap: .65rem; min-width: 0; line-height: 1.45; }
        .current-term-option input { flex: 0 0 auto; width: 18px; height: 18px; margin-top: .12rem; accent-color: var(--cp7-accent); }
        .current-term-option input:focus-visible { outline: 3px solid var(--cp7-aqua); outline-offset: 3px; }
        .current-term-option span { min-width: 0; overflow-wrap: anywhere; }
        main.cp7-container .early-toggle { display: inline-flex; align-items: center; gap: .55rem; text-align: left; }
        .early-option p, .custom-timeline-copy { margin: .4rem 0 0; color: var(--cp7-muted); font-size: 14px; line-height: 1.45; }
        main.cp7-container .custom-timeline-trigger,
        main.cp7-container .standard-timeline-trigger { border-color: transparent; padding-left: 0; color: var(--cp7-accent); font-weight: 700; }
        .catalog-planning-note { margin-top: 1.1rem; padding: .8rem .9rem; border-left: 3px solid var(--cp7-gold); background: #fffaf0; color: #473c2d; line-height: 1.45; }
        .catalog-planning-note p { margin: .3rem 0 0; font-size: 13px; }
        .custom-timeline-panel {
          display: grid;
          gap: 1rem;
          margin-top: .65rem;
          padding: 1rem;
          border: 1px solid var(--cp7-border);
          border-radius: 8px;
          background: var(--cp7-soft);
        }
        .custom-fields, .advanced-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .85rem; }
        .custom-fields label, .advanced-fields label {
          display: grid;
          gap: .4rem;
          color: #303a46;
          font-weight: 700;
        }
        .custom-fields select, .advanced-fields input, .advanced-fields select {
          width: 100%;
          min-height: 42px;
          padding: .55rem .65rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 6px;
          background: #fff;
          color: var(--cp7-ink);
          font-weight: 400;
        }
        .custom-target { margin: 0; color: #344151; }
        .custom-errors { margin: 0; padding-left: 1.2rem; color: var(--cp7-danger); }
        .more-details { margin-top: 1.25rem; border-top: 1px solid var(--cp7-border); padding-top: 1rem; }
        .more-details > summary { color: var(--cp7-accent); cursor: pointer; font-weight: 700; }
        .advanced-fields { margin-top: 1rem; }
        .advanced-fields .wide-field { grid-column: 1 / -1; }
        .non-major-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; margin-top: .75rem; }
        .non-major-fields label, .study-abroad-fields label { display: grid; gap: .3rem; font-size: 13px; font-weight: 700; }
        .non-major-fields select, .study-abroad-fields select { min-height: 40px; padding: .45rem .55rem; border: 1px solid var(--cp7-border-strong); border-radius: 6px; background: #fff; }
        .study-abroad-fields { display: grid; gap: .65rem; margin: .9rem 0; padding: .8rem; border: 1px solid #cae0e4; border-radius: 8px; background: #f2fafb; }
        .study-abroad-fields p { margin: 0; color: #285b63; }
        main.cp7-container .study-abroad-toggle { display: inline-flex; width: fit-content; min-height: 42px; align-items: center; gap: .4rem; padding: .55rem .7rem; border: 1px solid #8ab7bf; border-radius: 7px; background: #fff; color: #24434a; font-weight: 700; cursor: pointer; }
        main.cp7-container .study-abroad-toggle.is-selected { border-color: transparent; background: #e2f2f4; }
        .step-two-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
        main.cp7-container .secondary-action { flex: 0 0 auto; color: #244f85; }
        .course-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; align-items: end; margin: 1rem 0 1.25rem; }
        .course-toolbar label { display: grid; gap: .35rem; font-weight: 700; }
        .course-toolbar input {
          width: 100%;
          min-height: 42px;
          padding: .55rem .65rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 6px;
        }
        main.cp7-container .clear-courses {
          width: auto;
          min-height: 42px;
          margin: 0;
          padding: .55rem .8rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 6px;
          background: #fff;
          color: var(--cp7-ink);
          cursor: pointer;
        }
        .course-priority-section + .course-priority-section { margin-top: 1.35rem; }
        .course-priority-section > h3 { margin: 0 0 .45rem; color: var(--cp7-ink); font-size: 16px; }
        main.cp7-container .course-columns { display: grid; grid-template-columns: 1fr; gap: 0; }
        main.cp7-container .course-row {
          position: static;
          display: block;
          min-width: 0;
          padding: .8rem 0;
          border: 0;
          border-bottom: 1px solid #e4e7eb;
          background: transparent;
        }
        main.cp7-container .course-row-main {
          display: grid;
          grid-template-columns: minmax(175px, 1fr) minmax(370px, auto);
          gap: 1rem;
          align-items: center;
        }
        main.cp7-container .course-name { display: grid; gap: .18rem; min-width: 0; }
        main.cp7-container .course-name strong { color: var(--cp7-ink); font-size: 15px; }
        main.cp7-container .course-name span { color: var(--cp7-muted); font-size: 13px; line-height: 1.3; }
        main.cp7-container .course-toggles {
          display: grid;
          grid-template-columns: repeat(2, minmax(105px, 1fr));
          gap: .35rem;
          justify-content: stretch;
          outline: 0;
          box-shadow: none;
        }
        main.cp7-container .course-toggles.has-three { grid-template-columns: repeat(3, minmax(105px, 1fr)); }
        main.cp7-container .course-toggles:focus,
        main.cp7-container .course-toggles:focus-visible,
        main.cp7-container .course-toggles:focus-within { outline: 0; box-shadow: none; }
        main.cp7-container button.course-toggle,
        main.cp7-container .completion-source-options button {
          display: inline-flex;
          width: auto;
          min-width: 0;
          min-height: 38px;
          align-items: center;
          justify-content: center;
          gap: .35rem;
          margin: 0;
          padding: .48rem .55rem;
          border: 1px solid #aeb6bf;
          border-radius: 6px;
          background: #fff;
          color: #303a46;
          font-size: 13px;
          font-weight: 600;
          line-height: 1.2;
          cursor: pointer;
        }
        main.cp7-container button.course-toggle.is-selected,
        main.cp7-container .completion-source-options button.is-selected {
          border-color: transparent;
          background: var(--cp7-selected);
          color: var(--cp7-ink);
        }
        main.cp7-container button.course-toggle:focus-visible {
          position: relative;
          z-index: 1;
          outline: 3px solid var(--cp7-aqua);
          outline-offset: 2px;
          box-shadow: none;
        }
        .selection-check { display: inline-block; width: 1em; color: var(--cp7-accent); font-weight: 800; }
        .course-status-note { color: var(--cp7-muted); font-size: 13px; }
        .course-requirement-group { margin: .55rem 0; padding: .7rem .85rem; border: 1px solid var(--cp7-border); border-radius: 8px; background: #fafbfc; }
        .course-requirement-heading { display: flex; justify-content: space-between; gap: 1rem; color: var(--cp7-muted); font-size: 13px; }
        .course-requirement-heading strong { color: var(--cp7-ink); font-size: 14px; }
        .completion-source { display: flex; align-items: center; flex-wrap: wrap; gap: .25rem .55rem; margin: .35rem 0 0; }
        main.cp7-container .completion-source-trigger { width: auto; margin: 0; padding: .15rem 0; border: 0; background: transparent; color: #4b617a; cursor: pointer; font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }
        .completion-source-current { color: var(--cp7-muted); font-size: 12px; }
        .completion-source-panel { flex: 0 0 100%; }
        .completion-source-options { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .25rem; }
        main.cp7-container .completion-source-options button { min-height: 32px; padding: .35rem .5rem; font-size: 12px; }
        .completion-source p { margin: .4rem 0 0; color: var(--cp7-muted); font-size: 12px; }
        .inline-prerequisite { margin: .7rem 0 0; padding: .8rem; border: 1px solid #b9c3ce; border-radius: 7px; background: #f6f8fa; }
        .inline-prerequisite.has-conflict { border-color: #b76458; background: #fff6f3; }
        .inline-prerequisite > p { margin: 0 0 .65rem; }
        .prerequisite-question + .prerequisite-question { margin-top: .75rem; padding-top: .75rem; border-top: 1px solid var(--cp7-border); }
        .prerequisite-question-heading { display: grid; grid-template-columns: minmax(165px, 1fr) minmax(370px, 2fr); gap: 1rem; margin-bottom: .25rem; color: var(--cp7-muted); font-size: 13px; }
        .prerequisite-question-heading strong { grid-column: 2; color: var(--cp7-ink); text-align: center; }
        .prerequisite-option { display: grid; grid-template-columns: minmax(165px, 1fr) minmax(370px, 2fr); gap: 1rem; align-items: center; padding: .45rem 0; }
        .prerequisite-name { display: grid; gap: .1rem; }
        .prerequisite-name small { color: var(--cp7-muted); }
        .prerequisite-conflict { margin-top: .55rem; padding: .65rem .75rem; border-left: 3px solid var(--cp7-danger); background: #fff; color: #64251f; }
        .prerequisite-conflict p { margin: .2rem 0; }
        .prerequisite-approval { margin: .55rem 0 0 !important; color: #704c08; }
        main.cp7-container .course-accordion { margin-top: 1.35rem; border: 1px solid var(--cp7-border); border-radius: 8px; background: #fafbfc; }
        main.cp7-container .course-accordion > summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .8rem .9rem; color: var(--cp7-ink); cursor: pointer; font-weight: 700; }
        main.cp7-container .course-accordion-title { min-width: 0; }
        main.cp7-container .course-accordion-count { flex: 0 0 auto; }
        main.cp7-container .course-accordion .course-columns { padding: 0 .9rem .55rem; }
        main.cp7-container .cp7-summary { position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow: auto; }
        .summary-details { display: grid; gap: 0; margin: .8rem 0 0; }
        .summary-details > div { padding: .62rem 0; border-bottom: 1px solid #e5e8eb; }
        .summary-details dt { color: var(--cp7-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .035em; }
        .summary-details dd { margin: .24rem 0 0; color: var(--cp7-ink); line-height: 1.4; }
        .summary-none { color: var(--cp7-muted); }
        .summary-show-all { margin-top: .35rem; }
        .summary-show-all summary { color: #244f85; cursor: pointer; font-size: 13px; font-weight: 700; }
        .summary-show-all span { display: block; margin-top: .35rem; }
        .summary-attention { margin-top: .8rem; padding: .7rem; border: 1px solid var(--cp7-warning-border); border-radius: 7px; background: var(--cp7-warning); font-size: 13px; }
        .summary-attention p { margin: .4rem 0 0; }
        .summary-attention ul { display: grid; gap: .3rem; margin: .45rem 0 0; padding: 0; list-style: none; }
        .summary-attention button { padding: 0; border: 0; background: transparent; color: #704c08; text-align: left; text-decoration: underline; cursor: pointer; }
        .summary-status { margin: .8rem 0 0; color: #6c2c25; font-size: 13px; line-height: 1.4; }
        main.cp7-container .clear-all-button { width: 100%; min-height: 43px; margin: .85rem 0 0; padding: .6rem .8rem; border: 1px solid var(--cp7-accent); border-radius: 7px; background: #fff; color: var(--cp7-accent); font-weight: 700; cursor: pointer; }
        main.cp7-container .primary-action {
          width: 100%;
          min-height: 45px;
          margin: 1rem 0 0;
          padding: .7rem 1rem;
          border: 1px solid var(--cp7-accent-dark);
          border-radius: 7px;
          background: var(--cp7-accent-dark);
          color: #fff;
          font-size: 15px;
          font-weight: 700;
          cursor: pointer;
        }
        main.cp7-container .primary-action:hover { background: #21123f; }
        main.cp7-container .primary-action:disabled { cursor: wait; opacity: .68; }
        @media (min-width: 861px) {
          main.cp7-container .cp7-intake-layout {
            grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
          }
        }
        @media (max-width: 860px) {
          main.cp7-container { width: min(100% - 1rem, 720px); }
          .cp7-header { align-items: flex-start; flex-direction: column; gap: .55rem; }
          .cp7-progress { width: 100%; overflow-x: auto; }
          .cp7-progress ol { justify-content: space-between; min-width: 330px; }
          main.cp7-container .cp7-intake-layout { grid-template-columns: minmax(0, 1fr) !important; }
          main.cp7-container .cp7-summary {
            position: static;
            grid-column: 1 !important;
            grid-row: auto !important;
            max-height: none;
            overflow: visible;
          }
        }
        @media (max-width: 620px) {
          main.cp7-container { width: 100%; padding: 0 .65rem 2rem; }
          .cp7-page-heading { padding: 1.35rem .25rem 1rem; }
          .cp7-page-heading h1 { font-size: 28px; }
          main.cp7-container .cp7-task-card,
          main.cp7-container .cp7-summary { padding: 1rem; border-radius: 8px; }
          .standing-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .custom-fields, .advanced-fields, .non-major-fields { grid-template-columns: 1fr; }
          .advanced-fields .wide-field { grid-column: auto; }
          .step-two-heading { display: block; }
          main.cp7-container .secondary-action { margin-top: .7rem; }
          .course-toolbar { grid-template-columns: 1fr; }
          main.cp7-container .clear-courses { justify-self: start; }
          main.cp7-container .course-row-main,
          .prerequisite-option { grid-template-columns: 1fr; gap: .55rem; }
          .prerequisite-question-heading { grid-template-columns: 1fr; }
          .prerequisite-question-heading strong { grid-column: 1; }
          main.cp7-container .course-toggles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          main.cp7-container .course-toggles.has-three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
          main.cp7-container button.course-toggle { min-height: 44px; }
          .course-requirement-heading,
          .prerequisite-question-heading { display: grid; gap: .25rem; }
        }
        @media (max-width: 360px) {
          main.cp7-container .course-toggles { grid-template-columns: 1fr; }
          main.cp7-container button.course-toggle { justify-content: flex-start; }
        }
      `}</style>

      <header className="cp7-header">
        <div className="cp7-brand-block">
          <Image
            className="cp7-brand-logo"
            src="/urveska-midnight-gold-underlined.png"
            alt="Urveska"
            width={1868}
            height={294}
            priority
          />
          <p className="cp7-brand"><strong>EconPlanner</strong></p>
        </div>
        <nav className="cp7-progress" aria-label="Planner progress">
          <ol>
            <li className={intakeStep === 1 ? "is-current" : "is-complete"} aria-current={intakeStep === 1 ? "step" : undefined}>
              <button type="button" onClick={() => setIntakeStep(1)}>About you</button>
            </li>
            <li className={intakeStep === 2 ? "is-current" : ""} aria-current={intakeStep === 2 ? "step" : undefined}>
              <button type="button" onClick={continueToCourses}>Your courses</button>
            </li>
            <li><span aria-disabled="true">Your plans</span></li>
          </ol>
        </nav>
      </header>

      <div className="cp7-page-heading">
        <h1>{intakeStep === 1 ? "Where are you in your degree?" : "Which courses have you finished or are taking now?"}</h1>
        <p>{intakeStep === 1
          ? "We’ll use your class standing to estimate your graduation timeline."
          : "Choose Completed or Taking now only when it applies. Leave both off for courses you have not taken or are not sure about. Click a selected status again to clear it."}</p>
      </div>

      <form onSubmit={mapMajors}>
        <div className="cp7-intake-layout">
          <div className="cp7-left">
            {intakeStep === 1 ? (
              <section className="cp7-task-card" aria-labelledby="about-you-heading">
                <h2 id="about-you-heading">Tell us about your timeline</h2>
                <p className="cp7-task-intro">Choose your current class standing. You can adjust the graduation year if your expected timeline is different.</p>
                <fieldset>
                  <legend className="cp7-question-label">{standingQuestion}</legend>
                  <div className="standing-options" role="group" aria-label="Class standing">
                    {[
                      ["freshman", "Freshman"],
                      ["sophomore", "Sophomore"],
                      ["junior", "Junior"],
                      ["senior", "Senior"]
                    ].map(([value, label]) => (
                      <button
                        type="button"
                        id={`standing-${value}`}
                        className={`standing-option${formData.academicStanding === value ? " is-selected" : ""}`}
                        aria-pressed={formData.academicStanding === value}
                        key={value}
                        onClick={() => chooseStanding(value)}
                      >
                        <span className="selection-check" aria-hidden="true">{formData.academicStanding === value ? "✓" : ""}</span>
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="custom-timeline-copy">{standingHelp}</p>
                </fieldset>
                {formData.academicStanding && !formData.isTransferStudent && !formData.customGraduationEnabled && (
                  <p className="standing-feedback">
                    Based on {planningContext.standingLabel.toLowerCase()} standing, we’ll plan through <strong>{planningContext.expectedGraduationTerm}</strong>.
                  </p>
                )}
                {planningContext.currentTermPlanningWindow && (
                  <div className="current-term-option">
                    <label htmlFor="current-term-schedule-set">
                      <input
                        id="current-term-schedule-set"
                        type="checkbox"
                        checked={formData.scheduleSetByTerm?.[planningContext.currentTermPlanningWindow.slotId] === true}
                        onChange={event => {
                          const slotId = planningContext.currentTermPlanningWindow.slotId;
                          setFormData(current => ({
                            ...current,
                            scheduleSetByTerm: {
                              ...(current.scheduleSetByTerm || {}),
                              [slotId]: event.target.checked
                            }
                          }));
                          clearInputFeedback();
                        }}
                      />
                      <span>My schedule for {planningContext.currentTermPlanningWindow.displayTerm} is already set — don&apos;t add courses to this term.</span>
                    </label>
                  </div>
                )}
                {formData.academicStanding && !formData.isTransferStudent && planningContext.oneYearEarlyEligible && (
                  <div className="early-option">
                    <button
                      type="button"
                      className={`early-toggle${planningContext.earlyComparisonRequested ? " is-selected" : ""}`}
                      aria-pressed={planningContext.earlyComparisonRequested}
                      onClick={() => {
                        setFormData(current => ({
                          ...current,
                          planningPace: current.planningPace === PLANNING_PACES.EARLY ? PLANNING_PACES.STANDARD : PLANNING_PACES.EARLY
                        }));
                        clearInputFeedback();
                      }}
                    >
                      <span className="selection-check" aria-hidden="true">{planningContext.earlyComparisonRequested ? "✓" : ""}</span>
                      {formData.academicStanding === "junior"
                        ? "I’d like to graduate next year"
                        : "I’d like to graduate one year early"}
                    </button>
                    <p>Standard target: {planningContext.expectedGraduationTerm}. Accelerated target: {buildEarlyGraduationContext(planningContext)?.expectedGraduationTerm}.</p>
                  </div>
                )}
                <div className="custom-timeline-disclosure">
                  <button
                    type="button"
                    className="custom-timeline-trigger"
                    aria-expanded={formData.customGraduationEnabled}
                    aria-controls="custom-timeline-panel"
                    onClick={() => {
                      const turningOn = !formData.customGraduationEnabled;
                      const earlyWasSelected = formData.planningPace === PLANNING_PACES.EARLY;
                      setFormData(current => ({
                        ...current,
                        customGraduationEnabled: !current.customGraduationEnabled,
                        planningPace: PLANNING_PACES.STANDARD
                      }));
                      clearInputFeedback();
                      if (turningOn && earlyWasSelected) {
                        setStatus("The accelerated comparison was turned off because a custom graduation year uses its own timeline.");
                      }
                    }}
                  >
                    My expected graduation year is different
                  </button>
                  {!formData.customGraduationEnabled && <p className="custom-timeline-copy">Use this only when the standard target shown above does not fit your situation.</p>}
                  {formData.customGraduationEnabled && (
                    <div className="custom-timeline-panel" id="custom-timeline-panel">
                      <p className="custom-timeline-copy">This changes only the planning horizon. It does not claim transfer credit or change academic requirements.</p>
                      <div className="custom-fields">
                        <label htmlFor="custom-graduation-year">
                          <span>When do you expect to graduate?</span>
                          <select
                            id="custom-graduation-year"
                            value={formData.customExpectedGraduationYear}
                            onChange={event => {
                              setFormData(current => ({ ...current, customExpectedGraduationYear: event.target.value }));
                              clearInputFeedback();
                            }}
                          >
                            <option value="">Choose a graduation year</option>
                            {[...transferOptions.graduationYears, transferOptions.otherGraduationYear].map(year => (
                              <option value={year} key={year}>Spring/May {year}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <p className="custom-target"><strong>Custom target:</strong> {planningContext.customGraduationValidation.valid ? planningContext.expectedGraduationTerm : "Choose a graduation year above."}</p>
                      {!planningContext.customGraduationValidation.valid && (
                        <ul className="custom-errors">
                          {planningContext.customGraduationValidation.errors.map(error => <li key={error}>{error}</li>)}
                        </ul>
                      )}
                      <button
                        type="button"
                        className="standard-timeline-trigger"
                        onClick={() => {
                          setFormData(current => ({ ...current, customGraduationEnabled: false, planningPace: PLANNING_PACES.STANDARD }));
                          clearInputFeedback();
                        }}
                      >
                        Use my standard class-year timeline
                      </button>
                    </div>
                  )}
                </div>
                <div className="catalog-planning-note">
                  <strong>Planning requirements: 2025–2026 Economics catalog and confirmed department policies.</strong>
                  <p>Your official degree audit may differ. If an older declaration catalog applies, your advisor can confirm whether routine SAC paperwork is needed.</p>
                </div>
                <details className="more-details">
                  <summary>More details</summary>
                  <div className="advanced-fields">
                    <label>
                      <span>Student name (optional)</span>
                      <input type="text" autoComplete="name" value={formData.displayName} onChange={event => setFormData(current => ({ ...current, displayName: event.target.value }))} />
                    </label>
                    <label htmlFor="plan-creation-date">
                      <span>Plan creation date</span>
                      <input id="plan-creation-date" type="date" value={formData.planCreationDate} onChange={event => setFormData(current => updatePlanCreationDate(current, event.target.value))} />
                    </label>
                  </div>
                  {planningSlots.length > 0 && (
                    <details className="more-details">
                      <summary>Adjust your schedule (optional)</summary>
                      <p className="custom-timeline-copy">Tell EconPlanner about a future study-abroad term or space you want to leave for other courses.</p>
                      {juniorStudyAbroadSlots.length > 0 && (
                        <div className="study-abroad-fields">
                          <button
                            type="button"
                            className={`study-abroad-toggle${formData.studyAbroadTerm ? " is-selected" : ""}`}
                            aria-pressed={Boolean(formData.studyAbroadTerm)}
                            onClick={() => changeStudyAbroadTerm(formData.studyAbroadTerm ? "" : juniorStudyAbroadSlots[0].id)}
                          >
                            <span className="selection-check" aria-hidden="true">{formData.studyAbroadTerm ? "✓" : ""}</span>
                            I plan to study abroad during my junior year
                          </button>
                          {formData.studyAbroadTerm && (
                            <label htmlFor="study-abroad-term">
                              <span>Study-abroad term</span>
                              <select id="study-abroad-term" value={formData.studyAbroadTerm} onChange={event => changeStudyAbroadTerm(event.target.value)}>
                                {juniorStudyAbroadSlots.map(slot => <option value={slot.id} key={slot.id}>{slot.label}</option>)}
                              </select>
                            </label>
                          )}
                          {formData.studyAbroadTerm && <p>No Economics courses will be scheduled in {planningSlotsLabel(formData.studyAbroadTerm, planningContext)}.</p>}
                        </div>
                      )}
                      <h3>Leave room for other courses</h3>
                      <p className="custom-timeline-copy">Choose 0, 1, or 2 course units, within the normal capacity for each term.</p>
                      <div className="non-major-fields">
                        {planningSlots.filter(slot => !slot.isSummer).map(slot => (
                          <label key={slot.id}>
                            <span>{slot.label}</span>
                            <select
                              value={formData.studyAbroadTerm === slot.id
                                ? termReservationLimit(slot)
                                : Number(formData.reservedCourseUnits?.[slot.id] || 0)}
                              disabled={formData.studyAbroadTerm === slot.id}
                              aria-label={`Course units reserved in ${slot.label}`}
                              onChange={event => {
                                setFormData(current => ({
                                  ...current,
                                  reservedCourseUnits: {
                                    ...(current.reservedCourseUnits || {}),
                                    [slot.id]: Number(event.target.value)
                                  }
                                }));
                                clearInputFeedback();
                              }}
                            >
                              {Array.from({ length: Math.min(2, termReservationLimit(slot)) + 1 }, (_, value) => (
                                <option value={value} key={value}>{value}</option>
                              ))}
                              {formData.studyAbroadTerm === slot.id && termReservationLimit(slot) > 2 && (
                                <option value={termReservationLimit(slot)}>{termReservationLimit(slot)}</option>
                              )}
                            </select>
                          </label>
                        ))}
                      </div>
                    </details>
                  )}
                </details>
              </section>
            ) : (
              <section className="cp7-task-card" aria-labelledby="your-courses-heading">
                <div className="step-two-heading">
                  <div>
                    <h2 id="your-courses-heading">Your course history</h2>
                    <p className="cp7-task-intro">Only choose courses that apply to you.</p>
                  </div>
                  <button type="button" className="secondary-action" onClick={() => setIntakeStep(1)}>Back to about you</button>
                </div>
                <div className="course-toolbar">
                  <label htmlFor="course-search">
                    <span>Search courses</span>
                    <input
                      id="course-search"
                      type="search"
                      value={courseSearch}
                      onChange={event => setCourseSearch(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === "Enter") event.preventDefault();
                      }}
                      placeholder="Search by course code or title"
                    />
                  </label>
                  <button
                    type="button"
                    className="clear-courses"
                    onClick={() => {
                      setFormData(current => ({
                        ...current,
                        courses: current.courses.map(course => ({ ...course, status: "not_started", source: "manual_code" }))
                      }));
                      clearInputFeedback();
                    }}
                  >
                    Clear course choices
                  </button>
                </div>
                {declarationCourseGroups.length > 0 && (
                  <section className="course-priority-section" aria-labelledby="foundations-heading">
                    <h3 id="foundations-heading">Required Economics foundations</h3>
                    {renderCourseColumns(declarationCourseGroups, true)}
                  </section>
                )}
                {declarationRequirementGroups.length > 0 && (
                  <section className="course-priority-section" aria-labelledby="cognates-heading">
                    <h3 id="cognates-heading">Mathematics and statistics</h3>
                    {renderCourseColumns(declarationRequirementGroups, true)}
                  </section>
                )}
                {financeGroups.length > 0 && (
                  <section className="course-priority-section" aria-labelledby="finance-heading">
                    <h3 id="finance-heading">Finance</h3>
                    {renderCourseColumns(financeGroups, true)}
                  </section>
                )}
                {renderCourseAccordion("other-economics", "Other Economics courses", secondaryCourseGroups)}
                {visibleGroups.length === 0 && <p role="status">No courses match your search.</p>}
              </section>
            )}
          </div>
          <PlannerSummary
            courses={formData.courses}
            formData={formData}
            planningContext={planningContext}
            planningStart={planningStart}
            attentionItems={attentionItems}
            intakeStep={intakeStep}
            isGenerating={isGenerating}
            status={status}
            migrationNotice={migrationNotice}
            generateButtonRef={generateButtonRef}
            onContinue={continueToCourses}
            onFocusAttention={focusAttention}
            onClearAll={() => setClearDialogOpen(true)}
          />
        </div>
      </form>


    </main>
    <ClearAllDialog open={clearDialogOpen} onCancel={() => setClearDialogOpen(false)} onConfirm={clearAllPlanner} />
    </>
  );
}
