import academicCalendarData from "../../data/normalized/academic-calendars.json" with { type: "json" };
import {
  isOneYearEarlyEligible,
  normalizePlanningPaceForEligibility
} from "./strategyEligibility.js";

const STANDING_ORDER = ["freshman", "sophomore", "junior", "senior"];
const STANDING_LABELS = {
  freshman: "Freshman",
  sophomore: "Sophomore",
  junior: "Junior",
  senior: "Senior"
};

export const MAX_TRANSFER_PLANNING_YEARS = 5;
// A generous safety ceiling for real academic histories, repeated attempts,
// transfer work, and supporting courses. This is independent of catalog size.
export const MAX_STUDENT_COURSE_RECORDS = 100;

export function validateStudentCourseHistoryLimit(student = {}) {
  const count = Array.isArray(student.courses) ? student.courses.length : 0;
  if (count <= MAX_STUDENT_COURSE_RECORDS) return { valid: true, count, limit: MAX_STUDENT_COURSE_RECORDS };
  return {
    valid: false,
    count,
    limit: MAX_STUDENT_COURSE_RECORDS,
    issue: {
      field: "courses",
      code: "COURSE_HISTORY_LIMIT_EXCEEDED",
      message: `This request contains ${count} course history records. The planner supports up to ${MAX_STUDENT_COURSE_RECORDS} records at a time. Keep each valid course and attempt in your history, and ask your advisor for help planning a larger record.`
    }
  };
}

export const PLANNING_PACES = Object.freeze({
  STANDARD: "standard",
  EARLY: "one_year_early",
  // Retained only to read existing transfer and saved-plan contexts safely.
  // The current regular-student screen does not offer this as a strategy.
  EXTENDED: "one_year_extended"
});

export const STANDARD_TERM_ORDER = ["Fall", "Winter", "Spring"];

function dateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function exactSummerWindow(date) {
  const key = dateKey(date);
  return (academicCalendarData.summerClarificationWindows || []).find(window => (
    key >= window.start && key <= window.end
  )) || null;
}

function calendarCoversSummerYear(year) {
  return (academicCalendarData.summerClarificationWindows || []).some(window => window.upcomingFallYear === year);
}

function fallStartForYear(year) {
  return Object.values(academicCalendarData.academicYears || {})
    .map(item => item.fallTermStart)
    .find(value => String(value || "").startsWith(`${year}-`)) || null;
}

function springEndForYear(year) {
  return Object.values(academicCalendarData.academicYears || {})
    .map(item => item.springTermEnd)
    .find(value => String(value || "").startsWith(`${year}-`)) || null;
}

export class PlanningInputError extends Error {
  constructor(issues) {
    super(issues[0]?.message || "Correct the planning inputs.");
    this.name = "PlanningInputError";
    this.code = "INVALID_PLANNING_INPUT";
    this.issues = issues;
  }
}

function hasInput(value) {
  return value !== undefined && value !== null && value !== "";
}

export function isValidPlanningDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function validatePlanningInputs(student = {}, { requireDate = false } = {}) {
  const issues = [];
  if (!hasInput(student.planCreationDate)) {
    if (requireDate) issues.push({ field: "planCreationDate", code: "MISSING_PLAN_CREATION_DATE", message: "Plan creation date is required before mapping majors." });
  } else if (!isValidPlanningDate(student.planCreationDate)) {
    issues.push({ field: "planCreationDate", code: "INVALID_PLAN_CREATION_DATE", message: "Enter a real calendar date in YYYY-MM-DD format." });
  }
  if (hasInput(student.academicStanding) && (typeof student.academicStanding !== "string"
    || !STANDING_ORDER.includes(student.academicStanding.trim().toLowerCase()))) {
    issues.push({ field: "academicStanding", code: "INVALID_ACADEMIC_STANDING", message: "Choose freshman, sophomore, junior, or senior standing." });
  }
  return { valid: issues.length === 0, issues };
}

function localDateParts(value, fallback = new Date()) {
  if (hasInput(value)) {
    const validation = validatePlanningInputs({ planCreationDate: value });
    if (!validation.valid) throw new PlanningInputError(validation.issues);
    const [year, month, day] = value.split("-").map(Number);
    return { year, month, day };
  }
  return { year: fallback.getFullYear(), month: fallback.getMonth() + 1, day: fallback.getDate() };
}

function dropAddWindowIdentity(window) {
  const calendarYear = Number(String(window?.start || "").slice(0, 4));
  if (!Number.isInteger(calendarYear)) return null;
  const termKey = window.canonicalTerm === "MAY" ? "Spring"
    : window.canonicalTerm === "FALL" ? "Fall"
      : window.canonicalTerm === "WINTER" ? "Winter" : null;
  if (!termKey) return null;
  return {
    ...window,
    slotId: `${termKey.toLowerCase()}-${calendarYear}`,
    termId: `${calendarYear}-${window.canonicalTerm}`,
    termKey,
    label: window.displayTerm
  };
}

export function initialDropAddWindowForDate(value, fallback = new Date()) {
  const key = dateKey(localDateParts(value, fallback));
  const window = (academicCalendarData.initialDropAddWindows || []).find(item => (
    key >= item.start && key <= item.end
  ));
  return window ? dropAddWindowIdentity(window) : null;
}

export function normalizeScheduleSetByTerm(student = {}, fallback = new Date()) {
  const window = initialDropAddWindowForDate(student.planCreationDate, fallback);
  if (!window || student.scheduleSetByTerm?.[window.slotId] !== true) return {};
  return { [window.slotId]: true };
}

export function normalizeStanding(value) {
  const validation = validatePlanningInputs({ academicStanding: value });
  if (!validation.valid) throw new PlanningInputError(validation.issues);
  return hasInput(value) ? value.trim().toLowerCase() : "freshman";
}

export function isSummerDate(value, fallback) {
  const date = localDateParts(value, fallback);
  const officialFallOpening = academicCalendarData.initialDropAddWindows.find(window => window.canonicalTerm === "FALL" && window.start.startsWith(`${date.year}-`))?.start;
  if (officialFallOpening && dateKey(date) >= officialFallOpening) return false;
  if (exactSummerWindow(date)) return true;
  if (calendarCoversSummerYear(date.year)) return false;
  const springEnd = springEndForYear(date.year);
  if (springEnd && dateKey(date) > springEnd && date.month <= 8) return true;
  return date.month >= 6 && date.month <= 8;
}

// Winter runs from the Winter start window to the day before the Spring/May start window in the
// college calendar (for 2026-27: Jan 11 to May 2). Without calendar data for that year, fall back
// to the month rule used elsewhere (January to March).
export function isWinterTermDate(value, fallback = new Date()) {
  const date = localDateParts(value, fallback);
  const key = dateKey(date);
  const windows = academicCalendarData.initialDropAddWindows || [];
  for (const winter of windows.filter(item => item.canonicalTerm === "WINTER")) {
    const may = windows.find(item => item.canonicalTerm === "MAY" && item.academicYear === winter.academicYear);
    if (!may) continue;
    if (key >= winter.start && key < may.start) return true;
    const [firstYear, lastYear] = winter.academicYear.split("-").map(Number);
    if (date.year === lastYear || (date.year === firstYear && date.month >= 9)) return false;
  }
  return date.month >= 1 && date.month <= 3;
}

function termForDateParts(date) {
  const fallStart = fallStartForYear(date.year);
  if (fallStart && dateKey(date) >= fallStart) return "Fall";
  const { month } = date;
  if (month >= 9) return "Fall";
  if (month <= 3) return "Winter";
  if (month <= 5) return "Spring";
  return "Fall";
}

function academicYearStart(date) {
  return termForDateParts(date) === "Fall" ? date.year : date.year - 1;
}

function catalogYearForStart(startYear) {
  return `${startYear}-${startYear + 1}`;
}

function planningAcademicYearForStart(startYear) {
  return `${startYear}/${startYear + 1}`;
}

function academicYearStartValue(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{4})$/);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) return null;
  return Number(match[1]);
}

function normalizePlanningPace(value) {
  const pace = String(value || "").trim().toLowerCase();
  return Object.values(PLANNING_PACES).includes(pace) ? pace : PLANNING_PACES.STANDARD;
}

export function transferPlanningOptions(contextOrStartYear) {
  const value = typeof contextOrStartYear === "object" ? contextOrStartYear?.startYear : contextOrStartYear;
  const startYear = value == null || value === "" ? NaN : Number(value);
  if (!Number.isInteger(startYear)) {
    return { graduationYears: [], otherGraduationYear: null, entryAcademicYears: [] };
  }

  return {
    graduationYears: Array.from({ length: 4 }, (_, index) => startYear + index + 1),
    otherGraduationYear: startYear + MAX_TRANSFER_PLANNING_YEARS,
    entryAcademicYears: Array.from(
      { length: MAX_TRANSFER_PLANNING_YEARS },
      (_, index) => catalogYearForStart(startYear - index)
    )
  };
}

export function resolvePlanningContext(student = {}, fallbackDate = new Date()) {
  const inputValidation = validatePlanningInputs(student);
  if (!inputValidation.valid) {
    const invalid = { valid: false, errors: inputValidation.issues.map(issue => issue.message) };
    return {
      inputValidation, planningValidation: invalid, transferValidation: invalid,
      customGraduationValidation: invalid, remainingYears: 0, startYear: null,
      currentTermPlanningWindow: null, expectedGraduationYear: null, expectedGraduationTerm: null,
      standing: null, effectiveStanding: null, planningPace: null,
      planCreationDate: student.planCreationDate, isSummer: false,
      isTransferStudent: student.isTransferStudent === true,
      customGraduationEnabled: student.customGraduationEnabled === true
    };
  }
  const hasExplicitDate = Boolean(String(student.planCreationDate || "").trim());
  const date = localDateParts(student.planCreationDate, fallbackDate);
  const summer = hasExplicitDate && isSummerDate(student.planCreationDate, fallbackDate);
  const summerWindow = summer ? exactSummerWindow(date) : null;
  const summerUsesPublishedSpringEnd = summer && !summerWindow
    && Boolean(springEndForYear(date.year) && dateKey(date) > springEndForYear(date.year));
  const startYear = summer ? date.year : academicYearStart(date);
  const startTerm = summer ? "Fall" : termForDateParts(date);
  const startTermIndex = STANDARD_TERM_ORDER.indexOf(startTerm);
  const currentTermPlanningWindow = hasExplicitDate && !summer
    ? initialDropAddWindowForDate(student.planCreationDate, fallbackDate)
    : null;
  const currentTermScheduleSet = Boolean(
    currentTermPlanningWindow
    && student.scheduleSetByTerm?.[currentTermPlanningWindow.slotId] === true
  );
  const currentAcademicYearStart = startYear;
  const isTransferStudent = student.isTransferStudent === true;
  const customGraduationEnabled = !isTransferStudent && student.customGraduationEnabled === true;
  const selectedStanding = normalizeStanding(student.academicStanding);
  const selectedPlanningPace = normalizePlanningPace(student.planningPace);
  const transferOptions = transferPlanningOptions(startYear);
  const transferExpectedGraduationYear = Number(student.transferExpectedGraduationYear);
  const transferGraduationYearValid = Number.isInteger(transferExpectedGraduationYear)
    && transferExpectedGraduationYear >= startYear + 1
    && transferExpectedGraduationYear <= startYear + MAX_TRANSFER_PLANNING_YEARS;
  const transferEntryAcademicYear = String(student.transferEntryAcademicYear || "").trim();
  const transferEntryYearStart = academicYearStartValue(transferEntryAcademicYear);
  const transferEntryYearValid = transferOptions.entryAcademicYears.includes(transferEntryAcademicYear);
  const transferErrors = [];
  if (isTransferStudent && !transferGraduationYearValid) {
    transferErrors.push(`Choose an expected graduation year from ${startYear + 1} through ${startYear + MAX_TRANSFER_PLANNING_YEARS}.`);
  }
  if (isTransferStudent && !transferEntryYearValid) {
    transferErrors.push("Choose when you first enrolled at Hanover.");
  }
  const customExpectedGraduationYear = Number(student.customExpectedGraduationYear);
  const customGraduationYearValid = Number.isInteger(customExpectedGraduationYear)
    && customExpectedGraduationYear >= startYear + 1
    && customExpectedGraduationYear <= startYear + MAX_TRANSFER_PLANNING_YEARS;
  const customGraduationErrors = [];
  if (customGraduationEnabled && !customGraduationYearValid) {
    customGraduationErrors.push(`Choose an expected graduation year from ${startYear + 1} through ${startYear + MAX_TRANSFER_PLANNING_YEARS}.`);
  }

  const transferRemainingYears = transferGraduationYearValid
    ? transferExpectedGraduationYear - startYear
    : 0;
  const derivedTransferStandingIndex = transferEntryYearValid
    ? Math.min(3, Math.max(0, currentAcademicYearStart - transferEntryYearStart))
    : 0;
  const standing = isTransferStudent
    ? STANDING_ORDER[derivedTransferStandingIndex]
    : selectedStanding;
  const standingIndex = STANDING_ORDER.indexOf(standing);
  const standardRemainingYears = Math.max(0, 4 - standingIndex);
  const paceEligibility = isTransferStudent || customGraduationEnabled
    ? {
        planningPace: selectedPlanningPace,
        oneYearEarlyEligible: false,
        planningPaceNormalization: null
      }
    : normalizePlanningPaceForEligibility({
        planningPace: selectedPlanningPace,
        effectiveStanding: standing
      });
  const regularPaceErrors = [];
  // Selecting the comparison does not shorten the ordinary plan. The planner
  // builds that normal horizon first, then derives a separate accelerated
  // context when the student asks to see the one-year-early result.
  const earlyComparisonRequested = !isTransferStudent && !customGraduationEnabled
    && selectedPlanningPace === PLANNING_PACES.EARLY
    && paceEligibility.oneYearEarlyEligible;
  const remainingYears = isTransferStudent
    ? transferRemainingYears
    : customGraduationEnabled
      ? (customGraduationYearValid ? customExpectedGraduationYear - startYear : 0)
      : paceEligibility.planningPace === PLANNING_PACES.EXTENDED
        ? standardRemainingYears + 1
        : standardRemainingYears;
  const entryAcademicYearStart = isTransferStudent
    ? transferEntryYearStart
    : currentAcademicYearStart - standingIndex;
  const comparisonApplicable = hasExplicitDate && Boolean(entryAcademicYearStart !== null)
    && entryAcademicYearStart !== currentAcademicYearStart;
  const submittedMajorDeclarationCatalogYear = String(student.majorDeclarationCatalogYear || "").trim();
  const majorDeclarationCatalogYearUnknown = submittedMajorDeclarationCatalogYear === "I_DO_NOT_KNOW";
  const majorDeclarationCatalogYear = academicYearStartValue(submittedMajorDeclarationCatalogYear) === null
    ? null
    : submittedMajorDeclarationCatalogYear;
  const expectedGraduationYear = isTransferStudent
    ? (transferGraduationYearValid ? transferExpectedGraduationYear : null)
    : customGraduationEnabled
      ? (customGraduationYearValid ? customExpectedGraduationYear : null)
    : startYear + remainingYears;
  const normalTransferGraduationYear = transferEntryYearValid ? transferEntryYearStart + 4 : null;
  const compressedTransferTimeline = isTransferStudent
    && transferGraduationYearValid
    && Number.isInteger(normalTransferGraduationYear)
    && transferExpectedGraduationYear < normalTransferGraduationYear;
  const customOneYearEarlyTimeline = customGraduationEnabled
    && customGraduationYearValid
    && isOneYearEarlyEligible(standing)
    && customExpectedGraduationYear === startYear + standardRemainingYears - 1;
  const acceleratedPlanAssumesSeniorStanding = compressedTransferTimeline || customOneYearEarlyTimeline;
  const projectedSeniorStandingAcademicYear = acceleratedPlanAssumesSeniorStanding
    && Number.isInteger(expectedGraduationYear)
    ? planningAcademicYearForStart(expectedGraduationYear - 1)
    : null;
  const planningErrors = [...regularPaceErrors, ...customGraduationErrors];
  const planningPace = isTransferStudent
    ? compressedTransferTimeline
      ? PLANNING_PACES.EARLY
      : Number.isInteger(normalTransferGraduationYear) && transferExpectedGraduationYear > normalTransferGraduationYear
        ? "one_year_extended"
        : PLANNING_PACES.STANDARD
    : customGraduationEnabled
      ? PLANNING_PACES.STANDARD
      : paceEligibility.planningPace === PLANNING_PACES.EXTENDED
        ? PLANNING_PACES.EXTENDED
        : PLANNING_PACES.STANDARD;

  return {
    requiresSummerClarification: false,
    hasExplicitDate,
    standing,
    standingLabel: STANDING_LABELS[standing],
    effectiveStanding: standing,
    effectiveStandingLabel: STANDING_LABELS[standing],
    standingBasis: isTransferStudent ? "transfer_entry_academic_year" : (summer ? "upcoming_fall" : "current_academic_year"),
    planningPace,
    requestedPlanningPace: selectedPlanningPace,
    oneYearEarlyEligible: paceEligibility.oneYearEarlyEligible,
    planningPaceNormalization: paceEligibility.planningPaceNormalization,
    earlyComparisonRequested,
    standardRemainingYears,
    earlyGraduation: isTransferStudent && planningPace === PLANNING_PACES.EARLY,
    extendedGraduation: planningPace === PLANNING_PACES.EXTENDED,
    acceleratedPlanAssumesSeniorStanding,
    projectedSeniorStandingAcademicYear,
    projectedSeniorStandingBasis: acceleratedPlanAssumesSeniorStanding
      ? "accelerated_plan_assumes_senior_standing_in_final_year"
      : "college_year_progression",
    planningValidation: {
      valid: planningErrors.length === 0,
      errors: planningErrors
    },
    isTransferStudent,
    customGraduationEnabled,
    customExpectedGraduationYear: customGraduationYearValid ? customExpectedGraduationYear : null,
    customGraduationValidation: {
      valid: !customGraduationEnabled || customGraduationErrors.length === 0,
      errors: customGraduationErrors
    },
    transferExpectedGraduationYear: transferGraduationYearValid ? transferExpectedGraduationYear : null,
    transferEntryAcademicYear: transferEntryYearValid ? transferEntryAcademicYear : null,
    transferValidation: {
      valid: !isTransferStudent || transferErrors.length === 0,
      errors: transferErrors
    },
    isFiveYearTransferPlan: isTransferStudent && transferRemainingYears === MAX_TRANSFER_PLANNING_YEARS,
    isFiveYearPlan: remainingYears === MAX_TRANSFER_PLANNING_YEARS,
    summerStandingConfirmed: null,
    isSummer: summer,
    currentTermPlanningWindow,
    currentTermScheduleSet,
    summerBoundarySource: summer
      ? (summerWindow || summerUsesPublishedSpringEnd ? academicCalendarData.source : "month_fallback")
      : null,
    planCreationDate: `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`,
    startYear,
    startTerm,
    startTermIndex,
    currentAcademicYearStart,
    entryAcademicYearStart,
    entryCatalogYear: entryAcademicYearStart === null ? null : catalogYearForStart(entryAcademicYearStart),
    currentCatalogYear: catalogYearForStart(currentAcademicYearStart),
    submittedMajorDeclarationCatalogYear: submittedMajorDeclarationCatalogYear || null,
    majorDeclarationCatalogYear,
    majorDeclarationCatalogYearUnknown,
    majorDeclarationCatalogYearBasis: majorDeclarationCatalogYear
      ? "STUDENT_OR_ADVISOR_PROVIDED"
      : majorDeclarationCatalogYearUnknown
        ? "STUDENT_EXPLICITLY_DOES_NOT_KNOW"
        : "NOT_PROVIDED",
    declarationCatalogYear: comparisonApplicable ? catalogYearForStart(currentAcademicYearStart) : null,
    catalogComparisonApplicable: comparisonApplicable,
    remainingYears,
    expectedGraduationYear,
    expectedGraduationTerm: expectedGraduationYear ? `Spring/May ${expectedGraduationYear}` : null
  };
}

export function buildPlanningSlots(context) {
  if (!context || context.requiresSummerClarification || context.remainingYears <= 0) return [];

  // The official initial drop/add window keeps the current regular term in the
  // horizon. A term-scoped opt-out blocks new assignments without removing
  // fixed Taking now occupancy from that term.
  const includeCurrentTerm = Boolean(context.currentTermPlanningWindow);
  const firstPlanningTermIndex = context.startTermIndex + (context.isSummer || includeCurrentTerm ? 0 : 1);
  const regularSlotCount = context.remainingYears * STANDARD_TERM_ORDER.length - firstPlanningTermIndex;
  const slots = [];

  for (let offset = 0; offset < regularSlotCount; offset += 1) {
    const absoluteIndex = firstPlanningTermIndex + offset;
    const yearIndex = Math.floor(absoluteIndex / STANDARD_TERM_ORDER.length);
    const termIndex = absoluteIndex % STANDARD_TERM_ORDER.length;
    const termKey = STANDARD_TERM_ORDER[termIndex];
    const calendarYear = context.startYear + yearIndex + (termKey === "Fall" ? 0 : 1);
    const academicYearStart = context.startYear + yearIndex;
    const isAcceleratedFinalYear = context.acceleratedPlanAssumesSeniorStanding
      && yearIndex === context.remainingYears - 1
      && planningAcademicYearForStart(academicYearStart) === context.projectedSeniorStandingAcademicYear;
    const projectedStandingIndex = isAcceleratedFinalYear
      ? 3
      : Math.min(3, STANDING_ORDER.indexOf(context.effectiveStanding) + yearIndex);
    const slotId = `${termKey.toLowerCase()}-${calendarYear}`;
    const isCurrentTerm = context.currentTermPlanningWindow?.slotId === slotId;
    slots.push({
      id: slotId,
      termId: `${calendarYear}-${termKey === "Spring" ? "MAY" : termKey.toUpperCase()}`,
      canonicalTerm: termKey === "Spring" ? "MAY" : termKey.toUpperCase(),
      termKey,
      scheduleTerm: termKey === "Spring" ? "May" : termKey,
      label: `${termKey === "Spring" ? "Spring/May" : termKey} ${calendarYear}`,
      displayTerm: termKey === "Spring" ? "Spring/May" : termKey,
      academicYear: `${academicYearStart}/${academicYearStart + 1}`,
      yearIndex,
      absoluteStandingIndex: projectedStandingIndex,
      seniorStandingBasis: isAcceleratedFinalYear
        ? "accelerated_plan_assumes_senior_standing_in_final_year"
        : projectedStandingIndex >= 3
          ? "college_year_progression"
          : null,
      isSummer: false,
      isCurrentTerm,
      inProgressPrerequisitesAvailable: !isCurrentTerm,
      newCoursesAllowed: !isCurrentTerm || !context.currentTermScheduleSet,
      currentTermPlanningWindow: isCurrentTerm ? context.currentTermPlanningWindow : null
    });

    if (termKey === "Spring" && yearIndex < context.remainingYears - 1) {
      const summerYear = context.startYear + yearIndex + 1;
      slots.push({
        id: `summer-${summerYear}`,
        termId: `${summerYear}-SUMMER`,
        canonicalTerm: "SUMMER",
        termKey: "Summer",
        scheduleTerm: "Summer",
        label: `Summer ${summerYear}`,
        displayTerm: "Summer",
        academicYear: `${academicYearStart}/${academicYearStart + 1}`,
        yearIndex,
        absoluteStandingIndex: projectedStandingIndex,
        seniorStandingBasis: isAcceleratedFinalYear
          ? "accelerated_plan_assumes_senior_standing_in_final_year"
          : projectedStandingIndex >= 3
            ? "college_year_progression"
            : null,
        isSummer: true
      });
    }
  }

  return slots;
}

export function selectedPlanContext(context, plan) {
  // Transfer/custom horizons can carry a legacy early pace without being an
  // optional One Year Early comparison. Their explicit target is authoritative.
  if (context?.isTransferStudent || context?.customGraduationEnabled) {
    return plan?.id === "one-year-early" ? null : context;
  }
  if (plan?.isEarlyGraduation || plan?.id === "one-year-early") {
    return plan.isEarlyGraduation && context?.earlyComparisonRequested
      ? buildEarlyGraduationContext(context) : null;
  }
  return context;
}

export function buildEarlyGraduationContext(context) {
  if (!context
    || context.requiresSummerClarification
    || context.isTransferStudent
    || context.customGraduationEnabled
    || !isOneYearEarlyEligible(context.effectiveStanding)) return null;
  const remainingYears = Math.max(1, context.remainingYears - 1);
  const expectedGraduationYear = context.startYear + remainingYears;
  const projectedSeniorStandingAcademicYear = planningAcademicYearForStart(expectedGraduationYear - 1);
  return {
    ...context,
    planningPace: PLANNING_PACES.EARLY,
    earlyGraduation: true,
    extendedGraduation: false,
    remainingYears,
    expectedGraduationYear,
    expectedGraduationTerm: `Spring/May ${expectedGraduationYear}`,
    acceleratedPlanAssumesSeniorStanding: true,
    projectedSeniorStandingAcademicYear,
    projectedSeniorStandingBasis: "accelerated_plan_assumes_senior_standing_in_final_year",
    planningValidation: {
      valid: true,
      errors: []
    }
  };
}
