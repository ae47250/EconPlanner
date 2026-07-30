import academicCalendarData from "../../data/normalized/academic-calendars.json" with { type: "json" };

const STANDING_ORDER = ["freshman", "sophomore", "junior", "senior"];
const STANDING_LABELS = {
  freshman: "Freshman",
  sophomore: "Sophomore",
  junior: "Junior",
  senior: "Senior"
};

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

export function resolvePlanningContext(student = {}, fallbackDate = new Date()) {
  const hasExplicitDate = Boolean(String(student.planCreationDate || "").trim());
  const date = localDateParts(student.planCreationDate, fallbackDate);
  const standing = normalizeStanding(student.academicStanding);
  const standingIndex = STANDING_ORDER.indexOf(standing);
  const summer = hasExplicitDate && isSummerDate(student.planCreationDate, fallbackDate);
  const summerStandingConfirmed = String(student.summerStandingConfirmed || "").toLowerCase();
  const summerWindow = summer ? exactSummerWindow(date) : null;

  if (summer && !["yes", "no"].includes(summerStandingConfirmed)) {
    return {
      requiresSummerClarification: true,
      question: `Will you be a ${standing} in Fall ${date.year}, or were you a ${standing} during last May term?`,
      standing,
      standingLabel: STANDING_LABELS[standing],
      hasExplicitDate,
      planCreationDate: `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`,
      isSummer: true,
      summerBoundarySource: summerWindow ? academicCalendarData.source : "month_fallback"
    };
  }

  const completedStandingYear = summer && summerStandingConfirmed === "no";
  const effectiveStandingIndex = Math.min(3, standingIndex + (completedStandingYear ? 1 : 0));
  const remainingYears = Math.max(0, 4 - standingIndex - (completedStandingYear ? 1 : 0));
  const startYear = summer ? date.year : academicYearStart(date);
  const startTerm = summer ? "Fall" : termForDateParts(date);
  const startTermIndex = STANDARD_TERM_ORDER.indexOf(startTerm);
  const currentAcademicYearStart = summer && completedStandingYear ? date.year - 1 : startYear;
  const entryAcademicYearStart = currentAcademicYearStart - standingIndex;
  const comparisonApplicable = hasExplicitDate && standing !== "freshman";

  return {
    requiresSummerClarification: false,
    hasExplicitDate,
    standing,
    standingLabel: STANDING_LABELS[standing],
    effectiveStanding: STANDING_ORDER[effectiveStandingIndex],
    effectiveStandingLabel: STANDING_LABELS[STANDING_ORDER[effectiveStandingIndex]],
    summerStandingConfirmed: summer ? summerStandingConfirmed : null,
    isSummer: summer,
    summerBoundarySource: summer
      ? (summerWindow ? academicCalendarData.source : "month_fallback")
      : null,
    planCreationDate: `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`,
    startYear,
    startTerm,
    startTermIndex,
    currentAcademicYearStart,
    entryAcademicYearStart,
    entryCatalogYear: catalogYearForStart(entryAcademicYearStart),
    declarationCatalogYear: comparisonApplicable ? catalogYearForStart(currentAcademicYearStart) : null,
    catalogComparisonApplicable: comparisonApplicable,
    remainingYears,
    expectedGraduationYear: startYear + remainingYears,
    expectedGraduationTerm: `Spring/May ${startYear + remainingYears}`
  };
}

export function buildPlanningSlots(context) {
  if (!context || context.requiresSummerClarification || context.remainingYears <= 0) return [];

  const regularSlotCount = context.remainingYears * STANDARD_TERM_ORDER.length - context.startTermIndex;
  const slots = [];

  for (let offset = 0; offset < regularSlotCount; offset += 1) {
    const absoluteIndex = context.startTermIndex + offset;
    const yearIndex = Math.floor(absoluteIndex / STANDARD_TERM_ORDER.length);
    const termIndex = absoluteIndex % STANDARD_TERM_ORDER.length;
    const termKey = STANDARD_TERM_ORDER[termIndex];
    const calendarYear = context.startYear + yearIndex + (termKey === "Fall" ? 0 : 1);
    const academicYearStart = context.startYear + yearIndex;
    slots.push({
      id: `${termKey.toLowerCase()}-${calendarYear}`,
      termKey,
      scheduleTerm: termKey === "Spring" ? "May" : termKey,
      label: `${termKey === "Spring" ? "Spring/May" : termKey} ${calendarYear}`,
      displayTerm: termKey === "Spring" ? "Spring/May" : termKey,
      academicYear: `${academicYearStart}/${academicYearStart + 1}`,
      yearIndex,
      absoluteStandingIndex: Math.min(3, STANDING_ORDER.indexOf(context.effectiveStanding) + yearIndex),
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
        absoluteStandingIndex: Math.min(3, STANDING_ORDER.indexOf(context.effectiveStanding) + yearIndex),
        isSummer: true
      });
    }
  }

  return slots;
}

export function standingLabels() {
  return { ...STANDING_LABELS };
}
