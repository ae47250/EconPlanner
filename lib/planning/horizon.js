import academicCalendarData from "../../data/normalized/academic-calendars.json" with { type: "json" };

const STANDING_ORDER = ["freshman", "sophomore", "junior", "senior"];
const STANDING_LABELS = {
  freshman: "Freshman",
  sophomore: "Sophomore",
  junior: "Junior",
  senior: "Senior"
};

export const MAX_TRANSFER_PLANNING_YEARS = 5;

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

function academicYearStartValue(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{4})$/);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) return null;
  return Number(match[1]);
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
  const derivedTransferStandingIndex = transferGraduationYearValid
    ? Math.max(0, 4 - transferRemainingYears)
    : 0;
  const standing = isTransferStudent
    ? STANDING_ORDER[derivedTransferStandingIndex]
    : selectedStanding;
  const standingIndex = STANDING_ORDER.indexOf(standing);
  const remainingYears = isTransferStudent
    ? transferRemainingYears
    : Math.max(0, 4 - standingIndex);
  const entryAcademicYearStart = isTransferStudent
    ? transferEntryYearStart
    : currentAcademicYearStart - standingIndex;
  const comparisonApplicable = hasExplicitDate && Boolean(entryAcademicYearStart !== null)
    && entryAcademicYearStart !== currentAcademicYearStart;
  const expectedGraduationYear = isTransferStudent
    ? (transferGraduationYearValid ? transferExpectedGraduationYear : null)
    : startYear + remainingYears;

  return {
    requiresSummerClarification: false,
    hasExplicitDate,
    standing,
    standingLabel: STANDING_LABELS[standing],
    effectiveStanding: standing,
    effectiveStandingLabel: STANDING_LABELS[standing],
    standingBasis: isTransferStudent ? "transfer_expected_graduation" : (summer ? "upcoming_fall" : "current_academic_year"),
    isTransferStudent,
    transferExpectedGraduationYear: transferGraduationYearValid ? transferExpectedGraduationYear : null,
    transferEntryAcademicYear: transferEntryYearValid ? transferEntryAcademicYear : null,
    transferValidation: {
      valid: !isTransferStudent || transferErrors.length === 0,
      errors: transferErrors
    },
    isFiveYearTransferPlan: isTransferStudent && transferRemainingYears === MAX_TRANSFER_PLANNING_YEARS,
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
    const isEarlyGraduationFinalYear = context.earlyGraduation && yearIndex === context.remainingYears - 1;
    const transferStandingIndex = context.isTransferStudent
      ? Math.max(0, 4 - (context.remainingYears - yearIndex))
      : null;
    slots.push({
      id: `${termKey.toLowerCase()}-${calendarYear}`,
      termKey,
      scheduleTerm: termKey === "Spring" ? "May" : termKey,
      label: `${termKey === "Spring" ? "Spring/May" : termKey} ${calendarYear}`,
      displayTerm: termKey === "Spring" ? "Spring/May" : termKey,
      academicYear: `${academicYearStart}/${academicYearStart + 1}`,
      yearIndex,
      absoluteStandingIndex: context.isTransferStudent
        ? transferStandingIndex
        : isEarlyGraduationFinalYear
        ? 3
        : Math.min(3, STANDING_ORDER.indexOf(context.effectiveStanding) + yearIndex),
      isSummer: false
    });

    if (termKey === "Spring" && yearIndex < context.remainingYears - 1) {
      const summerYear = context.startYear + yearIndex + 1;
      slots.push({
        id: `summer-${summerYear}`,
        termKey: "Summer",
        scheduleTerm: "Summer",
        label: `Summer ${summerYear}`,
        displayTerm: "Summer",
        academicYear: `${academicYearStart}/${academicYearStart + 1}`,
        yearIndex,
        absoluteStandingIndex: context.isTransferStudent
          ? transferStandingIndex
          : isEarlyGraduationFinalYear
          ? 3
          : Math.min(3, STANDING_ORDER.indexOf(context.effectiveStanding) + yearIndex),
        isSummer: true
      });
    }
  }

  return slots;
}

export function buildEarlyGraduationContext(context) {
  if (!context || context.requiresSummerClarification || context.isTransferStudent || context.effectiveStanding === "senior") return null;
  const remainingYears = Math.max(1, context.remainingYears - 1);
  return {
    ...context,
    earlyGraduation: true,
    remainingYears,
    expectedGraduationYear: context.startYear + remainingYears,
    expectedGraduationTerm: `Spring/May ${context.startYear + remainingYears}`
  };
}

export function standingLabels() {
  return { ...STANDING_LABELS };
}
