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

function localDateParts(value, fallback = new Date()) {
  if (value) {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  }

  return {
    year: fallback.getFullYear(),
    month: fallback.getMonth() + 1,
    day: fallback.getDate()
  };
}

export function normalizeStanding(value) {
  const standing = String(value || "").trim().toLowerCase();
  return STANDING_ORDER.includes(standing) ? standing : "freshman";
}

export function isSummerDate(value, fallback) {
  const date = localDateParts(value, fallback);
  if (exactSummerWindow(date)) return true;
  if (calendarCoversSummerYear(date.year)) return false;
  const springEnd = springEndForYear(date.year);
  if (springEnd && dateKey(date) > springEnd && date.month <= 8) return true;
  return date.month >= 6 && date.month <= 8;
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
  const startYear = Number(
    typeof contextOrStartYear === "object"
      ? contextOrStartYear?.startYear
      : contextOrStartYear
  );
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
  const hasExplicitDate = Boolean(String(student.planCreationDate || "").trim());
  const date = localDateParts(student.planCreationDate, fallbackDate);
  const summer = hasExplicitDate && isSummerDate(student.planCreationDate, fallbackDate);
  const summerWindow = summer ? exactSummerWindow(date) : null;
  const summerUsesPublishedSpringEnd = summer && !summerWindow
    && Boolean(springEndForYear(date.year) && dateKey(date) > springEndForYear(date.year));
  const startYear = summer ? date.year : academicYearStart(date);
  const startTerm = summer ? "Fall" : termForDateParts(date);
  const startTermIndex = STANDARD_TERM_ORDER.indexOf(startTerm);
  const currentAcademicYearStart = startYear;
  const isTransferStudent = student.isTransferStudent === true;
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
  const paceEligibility = isTransferStudent
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
  const earlyComparisonRequested = !isTransferStudent
    && selectedPlanningPace === PLANNING_PACES.EARLY
    && paceEligibility.oneYearEarlyEligible;
  const remainingYears = isTransferStudent
    ? transferRemainingYears
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
    : startYear + remainingYears;
  const normalTransferGraduationYear = transferEntryYearValid ? transferEntryYearStart + 4 : null;
  const compressedTransferTimeline = isTransferStudent
    && transferGraduationYearValid
    && Number.isInteger(normalTransferGraduationYear)
    && transferExpectedGraduationYear < normalTransferGraduationYear;
  const acceleratedPlanAssumesSeniorStanding = compressedTransferTimeline;
  const projectedSeniorStandingAcademicYear = acceleratedPlanAssumesSeniorStanding
    && Number.isInteger(expectedGraduationYear)
    ? planningAcademicYearForStart(expectedGraduationYear - 1)
    : null;
  const planningErrors = [...regularPaceErrors];
  const planningPace = isTransferStudent
    ? compressedTransferTimeline
      ? PLANNING_PACES.EARLY
      : Number.isInteger(normalTransferGraduationYear) && transferExpectedGraduationYear > normalTransferGraduationYear
        ? "one_year_extended"
        : PLANNING_PACES.STANDARD
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

  // A dated plan never adds courses to a term that is already running.
  // Summer planning starts with the upcoming Fall because no regular term is running.
  const firstPlanningTermIndex = context.startTermIndex + (context.isSummer ? 0 : 1);
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
    slots.push({
      id: `${termKey.toLowerCase()}-${calendarYear}`,
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
      isSummer: false
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

export function buildEarlyGraduationContext(context) {
  if (!context
    || context.requiresSummerClarification
    || context.isTransferStudent
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

export function academicYearTbcSlot(slot) {
  const match = String(slot?.academicYear || "").match(/(\d{4})\D+(\d{4})/);
  if (!match) return null;
  return {
    id: `term-to-confirm-${match[1]}/${match[2]}`,
    termId: `${match[1]}-${match[2]}-TBC`,
    canonicalTerm: "TBC",
    termKey: "TBC",
    scheduleTerm: null,
    label: `${match[1]}/${match[2]} term to be confirmed`,
    displayTerm: "Term to be confirmed",
    academicYear: `${match[1]}/${match[2]}`,
    yearIndex: slot.yearIndex,
    absoluteStandingIndex: slot.absoluteStandingIndex,
    seniorStandingBasis: slot.seniorStandingBasis || null,
    isPlaceholder: true,
    isSummer: false
  };
}

export function standingLabels() {
  return { ...STANDING_LABELS };
}
