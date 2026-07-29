const STANDING_ORDER = ["freshman", "sophomore", "junior", "senior"];
const STANDING_LABELS = {
  freshman: "Freshman",
  sophomore: "Sophomore",
  junior: "Junior",
  senior: "Senior"
};

export const STANDARD_TERM_ORDER = ["Fall", "Winter", "Spring"];

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
  const { month } = localDateParts(value, fallback);
  return month >= 6 && month <= 8;
}

function termForDateParts({ month }) {
  if (month >= 9) return "Fall";
  if (month <= 3) return "Winter";
  if (month <= 5) return "Spring";
  return "Fall";
}

function academicYearStart({ year, month }) {
  return month >= 9 ? year : year - 1;
}

export function resolvePlanningContext(student = {}, fallbackDate = new Date()) {
  const hasExplicitDate = Boolean(String(student.planCreationDate || "").trim());
  const date = localDateParts(student.planCreationDate, fallbackDate);
  const standing = normalizeStanding(student.academicStanding);
  const standingIndex = STANDING_ORDER.indexOf(standing);
  const summer = hasExplicitDate && isSummerDate(student.planCreationDate, fallbackDate);
  const summerStandingConfirmed = String(student.summerStandingConfirmed || "").toLowerCase();

  if (summer && !["yes", "no"].includes(summerStandingConfirmed)) {
    const previousAcademicYear = `${date.year - 1}\u2013${String(date.year).slice(-2)}`;
    return {
      requiresSummerClarification: true,
      question: `Do you mean you will be a ${standing} in Fall ${date.year}, or that you were a ${standing} during the ${previousAcademicYear} academic year?`,
      standing,
      standingLabel: STANDING_LABELS[standing],
      hasExplicitDate,
      planCreationDate: `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`,
      isSummer: true
    };
  }

  const completedStandingYear = summer && summerStandingConfirmed === "no";
  const effectiveStandingIndex = Math.min(3, standingIndex + (completedStandingYear ? 1 : 0));
  const remainingYears = Math.max(0, 4 - standingIndex - (completedStandingYear ? 1 : 0));
  const startYear = summer ? date.year : academicYearStart(date);
  const startTerm = summer ? "Fall" : termForDateParts(date);
  const startTermIndex = STANDARD_TERM_ORDER.indexOf(startTerm);

  return {
    requiresSummerClarification: false,
    hasExplicitDate,
    standing,
    standingLabel: STANDING_LABELS[standing],
    effectiveStanding: STANDING_ORDER[effectiveStandingIndex],
    effectiveStandingLabel: STANDING_LABELS[STANDING_ORDER[effectiveStandingIndex]],
    summerStandingConfirmed: summer ? summerStandingConfirmed : null,
    isSummer: summer,
    planCreationDate: `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`,
    startYear,
    startTerm,
    startTermIndex,
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
    slots.push({
      id: `${termKey.toLowerCase()}-${calendarYear}`,
      termKey,
      scheduleTerm: termKey === "Spring" ? "May" : termKey,
      label: `${termKey === "Spring" ? "Spring/May" : termKey} ${calendarYear}`,
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
