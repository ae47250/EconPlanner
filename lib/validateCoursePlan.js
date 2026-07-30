const TERMS = ["Fall", "Winter", "May"];
const TERM_INDEX = new Map(TERMS.map((term, index) => [term, index]));

const REQUIRED_ECO_COURSES = new Set([
  "ECO 113",
  "ECO 114",
  "ECO 213",
  "ECO 214",
  "ECO 257",
  "ECO 321",
  "ECO 461"
]);

const NON_ELECTIVE_ECO_COURSES = new Set([
  ...REQUIRED_ECO_COURSES,
  "ECO 471"
]);

const VALID_ECO_COURSES = new Set([
  "ECO 113",
  "ECO 114",
  "ECO 160",
  "ECO 161",
  "ECO 213",
  "ECO 214",
  "ECO 221",
  "ECO 222",
  "ECO 223",
  "ECO 224",
  "ECO 234",
  "ECO 257",
  "ECO 260",
  "ECO 307",
  "ECO 315",
  "ECO 316",
  "ECO 321",
  "ECO 331",
  "ECO 333",
  "ECO 335",
  "ECO 337",
  "ECO 357",
  "ECO 360",
  "ECO 370",
  "ECO 461",
  "ECO 471"
]);

const MAY_BANNED_COURSES = new Set([
  "ECO 113",
  "ECO 114",
  "ECO 213",
  "ECO 214",
  "ECO 321",
  "BUSN 323",
  "MAT 113",
  "MAT 121",
  "MAT 217",
  "ECO 257",
  "PSY 217",
  "ECO 461"
]);

const STATS_GROUP = new Set(["MAT 217", "ECO 257", "PSY 217"]);
const COGNATE_GROUP = new Set(["MAT 113", "MAT 121"]);
const FINANCE_GROUP = new Set(["ECO 321", "BUSN 323"]);
const CROSS_LISTED_COURSES = Object.freeze({
  "ECO 234": ["PHI 234"]
});

const SCHEDULE_2026_2027 = {
  Fall: new Set(["ECO 113", "ECO 114", "ECO 213", "ECO 234", "ECO 333"]),
  Winter: new Set(["ECO 113", "ECO 114", "ECO 161", "ECO 214", "ECO 221", "ECO 321", "ECO 461"]),
  May: new Set(["ECO 222", "ECO 260"])
};

const PREREQUISITES = {
  "ECO 213": {
    all: ["ECO 113"],
    anyGroups: [["MAT 113", "MAT 121"]],
    concurrentWithApproval: [{ options: ["MAT 113", "MAT 121"], approval: "instructor" }]
  },
  "ECO 214": {
    all: ["ECO 114"],
    anyGroups: [["MAT 113", "MAT 121"]],
    concurrentWithApproval: [{ options: ["MAT 113", "MAT 121"], approval: "instructor" }]
  },
  "ECO 221": { all: ["ECO 113"], anyGroups: [] },
  "ECO 222": { all: ["ECO 114"], anyGroups: [] },
  "ECO 223": { all: [], anyGroups: [["ECO 113", "ECO 114", "ECO 161"]] },
  "ECO 257": { all: [], anyGroups: [["ECO 113", "ECO 114"]] },
  "ECO 315": { all: [], anyGroups: [["ECO 113", "ECO 114"]] },
  "ECO 316": { all: ["ECO 113", "ECO 114"], anyGroups: [] },
  "ECO 321": { all: ["ECO 113", "ECO 114"], anyGroups: [] },
  "ECO 331": { all: ["ECO 213"], anyGroups: [] },
  "ECO 333": { all: ["ECO 114"], anyGroups: [] },
  "ECO 335": { all: ["ECO 213", "ECO 257"], anyGroups: [["MAT 121"]] },
  "ECO 337": { all: [], anyGroups: [["ECO 113", "ECO 114"]] },
  "ECO 357": { all: ["ECO 213", "ECO 214"], anyGroups: [] },
  "ECO 461": { all: ["ECO 213", "ECO 214"], anyGroups: [["ECO 257", "MAT 217", "PSY 217"]] },
  "ECO 471": { all: ["ECO 213", "ECO 214", "ECO 321"], anyGroups: [] }
};

const COURSE_TITLE_ALIASES = [
  ["ECO 113", ["principles of microeconomics", "microeconomics principles", "principles microeconomics"]],
  ["ECO 114", ["principles of macroeconomics", "macroeconomics principles", "principles macroeconomics"]],
  ["ECO 161", ["foundations of economics"]],
  ["ECO 213", ["intermediate microeconomics", "intermediate micro"]],
  ["ECO 214", ["intermediate macroeconomics", "intermediate macro"]],
  ["ECO 221", ["environmental economics"]],
  ["ECO 222", ["economics of the european union", "european union economics"]],
  ["ECO 223", ["economics: poverty & discrimination", "economics poverty and discrimination", "poverty & discrimination", "poverty and discrimination"]],
  ["ECO 224", ["introduction to sustainability"]],
  ["ECO 234", ["rational choices"]],
  ["ECO 257", ["quantitative methods for business/economics", "quantitative methods for business economics", "quantitative methods"]],
  ["ECO 321", ["money & financial markets", "money and financial markets", "money financial markets"]],
  ["ECO 331", ["labor economics"]],
  ["ECO 333", ["international trade & finance", "international trade and finance", "trade and finance"]],
  ["ECO 335", ["managerial economics"]],
  ["ECO 337", ["economic development"]],
  ["ECO 357", ["internship"]],
  ["ECO 461", ["senior seminar: econometrics", "senior seminar econometrics", "econometrics"]],
  ["ECO 471", ["senior thesis"]]
];

const GROUP_INPUT_ALIASES = [
  {
    pattern: /\bMAT\s*113\s*\/\s*MAT\s*121\b/i,
    codes: ["MAT 113", "MAT 121"]
  },
  {
    pattern: /\bMAT\s*217\s*\/\s*ECO\s*257\s*\/\s*PSY\s*217\b/i,
    codes: ["MAT 217", "ECO 257", "PSY 217"]
  },
  {
    pattern: /\bECO\s*321\s*\/\s*BUSN\s*323\b/i,
    codes: ["ECO 321", "BUSN 323"]
  }
];

export function normalizeCourseCode(value) {
  if (!value || typeof value !== "string") return "";
  const compact = value.toUpperCase().trim().replace(/\s+/g, " ");
  const match = compact.match(/\b(ECO|MAT|PSY|BUSN|PHI)\s*-?\s*(\d{3})\b/);
  if (!match) return compact;
  const normalized = `${match[1]} ${match[2]}`;
  return normalized === "PHI 234" ? "ECO 234" : normalized;
}

function extractCourseCodes(value) {
  if (!value || typeof value !== "string") return [];
  const text = String(value);
  const codes = new Set();
  const matches = text.toUpperCase().matchAll(/\b(ECO|MAT|PSY|BUSN|PHI)\s*-?\s*(\d{3})\b/g);

  for (const match of matches) {
    codes.add(normalizeCourseCode(`${match[1]} ${match[2]}`));
  }

  const lowered = text.toLowerCase();
  for (const [code, aliases] of COURSE_TITLE_ALIASES) {
    if (aliases.some(alias => lowered.includes(alias))) codes.add(code);
  }

  return [...codes];
}

function extractEcoCourseCodes(value) {
  const text = String(value || "");
  const codes = new Set(extractCourseCodes(text).filter(code => code.startsWith("ECO ")));
  const bareNumbers = text.matchAll(/\b(\d{3})\b/g);

  for (const match of bareNumbers) {
    const code = `ECO ${match[1]}`;
    if (VALID_ECO_COURSES.has(code)) codes.add(code);
  }

  return [...codes];
}

function extractGroupedInputCodes(value) {
  const text = String(value || "");
  const codes = new Set();

  for (const group of GROUP_INPUT_ALIASES) {
    if (group.pattern.test(text)) {
      for (const code of group.codes) codes.add(code);
    }
  }

  return [...codes];
}

function addDefinitePrerequisites(courses) {
  let changed = true;

  while (changed) {
    changed = false;
    for (const code of [...courses]) {
      const prereq = PREREQUISITES[code];
      for (const required of prereq?.all || []) {
        if (!courses.has(required)) {
          courses.add(required);
          changed = true;
        }
      }
    }
  }
}

function isPlaceholder(value) {
  const text = String(value || "").trim().toLowerCase();
  return !text || text === "—" || text === "-" || text === "none";
}

function isAlternative(value) {
  return /\bOR\b|\//i.test(String(value || ""));
}

function isIntermediateAlternativeEntry(value) {
  const text = String(value || "");
  return /ECO\s*213/i.test(text) &&
    /ECO\s*214/i.test(text) &&
    (/\bor\b/i.test(text) || /\//.test(text));
}

function academicYearKey(year) {
  return String(year || "").replace("-", "/").trim();
}

function isKnownScheduleYear(year) {
  return academicYearKey(year) === "2026/2027";
}

function isSeniorYear(yearLabel) {
  return /4th|senior/i.test(String(yearLabel || ""));
}

function termPosition(yearIndex, term) {
  return yearIndex * 3 + (TERM_INDEX.get(term) ?? 0);
}

function sophomoreYearIndexFor(plan, studentYear) {
  const labeledIndex = plan.years.findIndex(year => /2nd|sophomore/i.test(String(year.label || "")));
  if (labeledIndex >= 0) return labeledIndex;
  if (/freshman|first|incoming/.test(studentYear) && plan.years.length > 1) return 1;
  return -1;
}

function studentRequestedEco471(studentInput = {}) {
  const text = String(studentInput.additionalNotes || "");
  return /\bECO\s*471\b|senior thesis/i.test(text);
}

function collectInputCourses(studentInput = {}) {
  const completed = new Set();

  for (const field of [studentInput.completedCourses, studentInput.currentCourses]) {
    for (const code of extractEcoCourseCodes(field)) {
      completed.add(code);
    }
  }

  const fields = [
    studentInput.mathCognate,
    studentInput.statsOption,
    studentInput.financeOption
  ];

  for (const field of fields) {
    for (const code of extractCourseCodes(String(field || ""))) {
      completed.add(code);
    }
    for (const code of extractGroupedInputCodes(field)) {
      completed.add(code);
    }
  }

  addDefinitePrerequisites(completed);

  return completed;
}

function collectPlanCourses(plan) {
  const placements = [];
  const years = Array.isArray(plan?.years) ? plan.years : [];

  years.forEach((year, yearIndex) => {
    for (const term of TERMS) {
      const entries = Array.isArray(year?.terms?.[term]) ? year.terms[term] : [];
      for (const entry of entries) {
        if (isPlaceholder(entry) || String(entry).trim().toLowerCase() === "eco elective") continue;
        const codes = extractCourseCodes(entry);
        for (const code of codes) {
          placements.push({
            code,
            raw: entry,
            term,
            yearIndex,
            yearLabel: year.label || "",
            academicYear: year.academicYear || "",
            position: termPosition(yearIndex, term),
            isAlternative: isAlternative(entry)
          });
        }
      }
    }
  });

  return placements;
}

function earliestPositions(completedBeforePlan, placements) {
  const positions = new Map();
  for (const code of completedBeforePlan) positions.set(code, -1);

  for (const placement of placements) {
    const current = positions.get(placement.code);
    if (current === undefined || placement.position < current) {
      positions.set(placement.code, placement.position);
    }
  }
  return positions;
}

function satisfiesAnyGroup(group, positions, beforePosition) {
  return group.some(code => positions.has(code) && positions.get(code) < beforePosition);
}

function concurrentApproval(plan, placement, group, positions) {
  const rule = PREREQUISITES[placement.code];
  const policy = (rule?.concurrentWithApproval || []).find(item => (
    group.some(code => (item.options || []).includes(code))
  ));
  if (!policy) return null;

  const prerequisite = group.find(code => (
    (policy.options || []).includes(code)
    && positions.get(code) === placement.position
  ));
  if (!prerequisite) return null;

  const approvals = Array.isArray(plan.instructorApprovals) ? plan.instructorApprovals : [];
  const approved = approvals.some(item => (
    item?.course === placement.code
    && item?.prerequisite === prerequisite
    && (!item.term || item.term === placement.term)
    && (!item.academicYear || item.academicYear === placement.academicYear)
  ));
  return { prerequisite, approved };
}

function isElectiveCode(code) {
  return code.startsWith("ECO ") && VALID_ECO_COURSES.has(code) && !NON_ELECTIVE_ECO_COURSES.has(code);
}

function isNamedFutureElective(placement) {
  return isElectiveCode(placement.code) && !isKnownScheduleYear(placement.academicYear);
}

function isRequirementChoicePlacement(placement) {
  const raw = String(placement.raw || "").toUpperCase();
  return raw.includes("MAT 217") && raw.includes("ECO 257") && raw.includes("PSY 217") ||
    raw.includes("ECO 321") && raw.includes("BUSN 323");
}

function countEcoEntries(entries) {
  return entries.reduce((count, entry) => {
    if (isPlaceholder(entry)) return count;
    if (String(entry).trim().toLowerCase() === "eco elective") return count + 1;
    const hasEcoCode = extractCourseCodes(entry).some(code => code.startsWith("ECO "));
    // Alternative groups such as "ECO 213 or ECO 214" represent one course slot, not two.
    return count + (hasEcoCode ? 1 : 0);
  }, 0);
}

function countElectiveEntries(entries) {
  return entries.reduce((count, entry) => {
    if (String(entry).trim().toLowerCase() === "eco elective") return count + 1;
    const electiveCodes = extractCourseCodes(entry).filter(isElectiveCode);
    if (isAlternative(entry)) return count + (electiveCodes.length ? 1 : 0);
    return count + electiveCodes.length;
  }, 0);
}

function countCourseEntries(entries) {
  return entries.reduce((count, entry) => {
    if (isPlaceholder(entry)) return count;
    return count + 1;
  }, 0);
}

function countYearEcoEntries(year) {
  return TERMS.reduce((total, term) => {
    const entries = Array.isArray(year?.terms?.[term]) ? year.terms[term] : [];
    return total + countEcoEntries(entries);
  }, 0);
}

function hasTimelyCompletionPressure(plan, studentInput = {}) {
  const text = [
    studentInput.additionalNotes,
    plan.studentSummary,
    ...(Array.isArray(plan.globalNotes) ? plan.globalNotes : []),
    ...plan.years.flatMap(year => Array.isArray(year?.notes) ? year.notes : [])
  ].join(" ");

  return /finish|complete|completion|graduat|on time|in time|cannot be completed|major cannot/i.test(text);
}

function hasGroupSatisfied(group, completedBeforePlan, placements, maxPosition = Infinity) {
  for (const code of group) {
    if (completedBeforePlan.has(code)) return true;
    if (placements.some(p => p.code === code && p.position <= maxPosition)) return true;
  }
  return false;
}

export function validateCoursePlan(plan, options = {}) {
  const errors = [];
  const warnings = [];
  const advisorChecks = [];

  if (!plan || typeof plan !== "object") {
    return { valid: false, errors: ["Plan must be a JSON object."], warnings, advisorChecks };
  }

  if (!Array.isArray(plan.years) || plan.years.length === 0) {
    errors.push("Plan must include at least one year block.");
    return { valid: false, errors, warnings, advisorChecks };
  }

  const completedBeforePlan = collectInputCourses(options.studentInput || {});
  const placements = collectPlanCourses(plan);
  const positions = earliestPositions(completedBeforePlan, placements);
  const eco471Requested = studentRequestedEco471(options.studentInput || {});
  const timelyCompletionPressure = hasTimelyCompletionPressure(plan, options.studentInput || {});

  // Repeated completed/current courses.
  for (const placement of placements) {
    if (completedBeforePlan.has(placement.code)) {
      errors.push(`${placement.code} is already completed or in progress and should not be scheduled again.`);
    }
  }

  // Valid named ECO courses.
  for (const placement of placements) {
    if (placement.code.startsWith("ECO ") && !VALID_ECO_COURSES.has(placement.code)) {
      errors.push(`${placement.code} is not listed as a valid ECO course in the knowledge file.`);
    }
  }

  // Per-term load and May bans.
  plan.years.forEach((year, yearIndex) => {
    for (const term of TERMS) {
      const entries = Array.isArray(year?.terms?.[term]) ? year.terms[term] : [];
      const ecoCount = countEcoEntries(entries);
      if ((term === "Fall" || term === "Winter") && ecoCount > 4) {
        errors.push(`${year.label || `Year ${yearIndex + 1}`} ${term} has more than four economics courses.`);
      } else if ((term === "Fall" || term === "Winter") && ecoCount > 2) {
        if (timelyCompletionPressure) {
          const courseCount = ecoCount === 3 ? "three" : "four";
          warnings.push(`Taking ${courseCount} economics courses in ${year.label || `Year ${yearIndex + 1}`} ${term} is not recommended unless needed to finish the major on time.`);
        } else {
        errors.push(`${year.label || `Year ${yearIndex + 1}`} ${term} has more than two economics courses.`);
        }
      }
      if (term === "May" && ecoCount > 1) {
        errors.push(`${year.label || `Year ${yearIndex + 1}`} May has more than one economics course.`);
      }
      if (term === "May" && countCourseEntries(entries) > 1) {
        errors.push(`${year.label || `Year ${yearIndex + 1}`} May has more than one total course.`);
      }

      if (term === "May") {
        for (const entry of entries) {
          for (const code of extractCourseCodes(entry)) {
            if (MAY_BANNED_COURSES.has(code)) {
              errors.push(`${code} may not be scheduled in May Term.`);
            }
          }
        }
      }

      const electiveCount = countElectiveEntries(entries);
      if (electiveCount > 1) {
        if (isSeniorYear(year.label) || timelyCompletionPressure) {
          warnings.push(`${year.label || `Year ${yearIndex + 1}`} ${term} has more than one ECO elective; this should be used only when necessary to finish the major on time.`);
        } else {
          errors.push(`${year.label || `Year ${yearIndex + 1}`} ${term} has more than one ECO elective.`);
        }
      }
    }
  });

  // First-year pacing.
  const studentYear = String(options.studentInput?.studentYear || "").toLowerCase();
  if (studentYear.includes("senior") || studentYear.includes("4th")) {
    const extendsBeyondSeniorYear = plan.years.some((year, yearIndex) => yearIndex > 0 || !isSeniorYear(year.label));
    if (extendsBeyondSeniorYear) {
      errors.push("Senior plans may not extend beyond Senior Year; show the closest possible plan with a warning if the major cannot be completed by graduation.");
    }
  }

  if (studentYear.includes("incoming") || studentYear.includes("first") || studentYear.includes("freshman")) {
    const firstYear = plan.years[0];
    if (firstYear) {
      const fallEco = countEcoEntries(firstYear.terms?.Fall || []);
      const winterEco = countEcoEntries(firstYear.terms?.Winter || []);
      const mayEco = countEcoEntries(firstYear.terms?.May || []);
      if (fallEco > 1 || winterEco > 1) {
        errors.push("Freshman plan should not place more than one ECO course in Fall or Winter.");
      }
      if (fallEco + winterEco > 2) {
        errors.push("Freshman plan should include no more than two ECO courses across Fall and Winter.");
      }
      if (mayEco > 0) {
        errors.push("Freshman plan should not schedule a May Term ECO course in the first year.");
      }
    }
  }

  if (studentYear.includes("freshman") || studentYear.includes("first") || studentYear.includes("sophomore")) {
    plan.years.forEach((year, yearIndex) => {
      if (isSeniorYear(year.label)) return;
      const yearlyEcoCount = countYearEcoEntries(year);
      if (yearlyEcoCount > 3) {
        warnings.push(`${year.label || `Year ${yearIndex + 1}`} has more than three ECO courses; standard freshman/sophomore plans should avoid acceleration unless requested or necessary.`);
      }
    });
  }

  // Known 2026/2027 schedule enforcement.
  for (const placement of placements) {
    if (!placement.code.startsWith("ECO ")) continue;
    if (isRequirementChoicePlacement(placement)) continue;
    if (!isKnownScheduleYear(placement.academicYear)) continue;
    const allowed = SCHEDULE_2026_2027[placement.term];
    if (!allowed?.has(placement.code)) {
      errors.push(`${placement.code} is not listed in ${placement.term} ${placement.academicYear}.`);
    }
  }

  // Unknown future elective schedules.
  for (const placement of placements) {
    if (isRequirementChoicePlacement(placement)) continue;
    if (placement.code === "ECO 471") continue;
    if (isNamedFutureElective(placement)) {
      errors.push(`${placement.code} should be written as ECO elective in ${placement.academicYear} because no specific schedule is known for that year.`);
    }
  }

  // Unknown future ECO 213/ECO 214 placement.
  for (const placement of placements) {
    if (!["ECO 213", "ECO 214"].includes(placement.code)) continue;
    if (isKnownScheduleYear(placement.academicYear)) continue;
    if (isIntermediateAlternativeEntry(placement.raw)) continue;
    const alternative = placement.code === "ECO 213" ? "ECO 213 or ECO 214" : "ECO 214 or ECO 213";
    errors.push(`${placement.code} should be written as ${alternative} in ${placement.academicYear} because the exact future schedule is unknown.`);
  }

  // ECO 461 senior Winter only.
  for (const placement of placements.filter(p => p.code === "ECO 461")) {
    if (!isSeniorYear(placement.yearLabel)) {
      errors.push("ECO 461 requires senior standing and may only be scheduled in senior year.");
    }
    if (placement.term !== "Winter") {
      errors.push("ECO 461 must be scheduled only in Winter.");
    }
  }

  // ECO 471 is not part of standard displayed plans.
  if (!eco471Requested && placements.some(p => p.code === "ECO 471")) {
    errors.push("ECO 471 should not be included in a standard plan unless the student explicitly asks for Senior Thesis.");
  }
  for (const placement of placements.filter(p => p.code === "ECO 471")) {
    if (!isSeniorYear(placement.yearLabel)) {
      errors.push("ECO 471 requires senior standing and may only be scheduled in senior year.");
    }
  }

  // ECO 213 and ECO 214 same term check.
  plan.years.forEach((year, yearIndex) => {
    for (const term of TERMS) {
      const entries = Array.isArray(year?.terms?.[term]) ? year.terms[term] : [];
      const codes = new Set(entries.flatMap(extractCourseCodes));
      const hasIntermediateAlternative = entries.some(entry => /ECO\s*213.*\bOR\b.*ECO\s*214|ECO\s*214.*\bOR\b.*ECO\s*213/i.test(entry));
      if (codes.has("ECO 213") && codes.has("ECO 214") && !hasIntermediateAlternative) {
        errors.push(`ECO 213 and ECO 214 should not both be scheduled in ${year.label || `Year ${yearIndex + 1}`} ${term}.`);
      }
    }
  });

  // Prerequisite checks for specific, non-alternative placements.
  for (const placement of placements) {
    if (placement.isAlternative) continue;
    const prereq = PREREQUISITES[placement.code];
    if (!prereq) continue;

    for (const required of prereq.all || []) {
      if (!positions.has(required) || positions.get(required) >= placement.position) {
        errors.push(`${placement.code} requires ${required} before ${placement.term} ${placement.academicYear}.`);
      }
    }

    for (const group of prereq.anyGroups || []) {
      if (satisfiesAnyGroup(group, positions, placement.position)) continue;
      const concurrent = concurrentApproval(plan, placement, group, positions);
      if (!concurrent) {
        errors.push(`${placement.code} requires one of ${group.join(" / ")} before ${placement.term} ${placement.academicYear}.`);
        continue;
      }
      if (!concurrent.approved) {
        errors.push(`${placement.code} is concurrent with ${concurrent.prerequisite} but is not marked as requiring instructor approval.`);
        continue;
      }
      advisorChecks.push(`${placement.code} is concurrent with ${concurrent.prerequisite}; approval from the ${placement.code} instructor is required.`);
    }
  }

  // Prerequisites for future ECO 213/ECO 214 alternatives.
  const checkedIntermediateAlternatives = new Set();
  for (const placement of placements) {
    if (!isIntermediateAlternativeEntry(placement.raw)) continue;
    const key = `${placement.yearIndex}-${placement.term}-${placement.raw}`;
    if (checkedIntermediateAlternatives.has(key)) continue;
    checkedIntermediateAlternatives.add(key);

    for (const required of ["ECO 113", "ECO 114"]) {
      if (!positions.has(required) || positions.get(required) >= placement.position) {
        errors.push(`ECO 213 or ECO 214 requires ${required} before ${placement.term} ${placement.academicYear}.`);
      }
    }
    if (!satisfiesAnyGroup(["MAT 113", "MAT 121"], positions, placement.position)) {
      errors.push(`ECO 213 or ECO 214 requires one of MAT 113 / MAT 121 before ${placement.term} ${placement.academicYear}.`);
    }
  }

  // Statistics timing for ECO 461.
  const seniorWinter461 = placements.find(p => p.code === "ECO 461" && p.term === "Winter" && isSeniorYear(p.yearLabel));
  if (seniorWinter461) {
    const seniorFallPosition = seniorWinter461.position - 1;
    if (!hasGroupSatisfied(STATS_GROUP, completedBeforePlan, placements, seniorFallPosition)) {
      errors.push("The statistics option must be completed no later than Fall of senior year before ECO 461.");
    }
  }

  // Recommended completion timing warnings.
  const juniorYearIndex = plan.years.findIndex(year => /3rd|junior/i.test(String(year.label || "")));
  if (juniorYearIndex >= 0) {
    const juniorMayPosition = termPosition(juniorYearIndex, "May");
    if (!hasGroupSatisfied(STATS_GROUP, completedBeforePlan, placements, juniorMayPosition)) {
      warnings.push("It is recommended to complete the statistics option by the end of junior year.");
    }
    if (!hasGroupSatisfied(new Set(["ECO 213"]), completedBeforePlan, placements, juniorMayPosition) ||
        !hasGroupSatisfied(new Set(["ECO 214"]), completedBeforePlan, placements, juniorMayPosition)) {
      warnings.push("It is recommended, when feasible, to complete ECO 213 and ECO 214 by the end of junior year.");
    }
  }

  const sophomoreYearIndex = sophomoreYearIndexFor(plan, studentYear);
  if (/freshman|first|incoming/.test(studentYear) && sophomoreYearIndex >= 0) {
    const sophomoreMayPosition = termPosition(sophomoreYearIndex, "May");
    if (!hasGroupSatisfied(COGNATE_GROUP, completedBeforePlan, placements, sophomoreMayPosition)) {
      warnings.push("Freshman plans should complete MAT 113 or MAT 121 by the end of sophomore year so ECO 213 and ECO 214 are not delayed.");
    }
  }

  // Senior elective cap.
  const seniorYear = plan.years.find(year => isSeniorYear(year.label));
  if (seniorYear) {
    let seniorElectives = 0;
    for (const term of TERMS) {
      seniorElectives += countElectiveEntries(seniorYear.terms?.[term] || []);
    }
    if (seniorElectives > 1) {
      warnings.push("Senior year includes more than one ECO elective; this should be used only when necessary for major completion.");
    }
  }

  // 100-level elective rule.
  const plannedElectiveCodes = placements.map(p => p.code).filter(isElectiveCode);
  const completedElectiveCodes = [...completedBeforePlan].filter(isElectiveCode);
  const genericElectiveCount = plan.years.reduce((total, year) => {
    return total + TERMS.reduce((termTotal, term) => {
      const entries = Array.isArray(year?.terms?.[term]) ? year.terms[term] : [];
      return termTotal + entries.filter(entry => String(entry).trim().toLowerCase() === "eco elective").length;
    }, 0);
  }, 0);

  const hundredLevelElectives = [...completedElectiveCodes, ...plannedElectiveCodes].filter(code => /^ECO 1\d\d$/.test(code));
  if (hundredLevelElectives.length > 1) {
    errors.push("Only one of the four ECO electives may be at the 100 level.");
  }

  const electiveCount = completedElectiveCodes.length + plannedElectiveCodes.length + genericElectiveCount;
  if (electiveCount < 4) {
    errors.push("The economics major requires four ECO electives; this plan shows fewer than four completed or planned ECO electives.");
  }

  // Complete major requirement checks.
  const endOfPlanPosition = termPosition(plan.years.length - 1, "May");
  const requiredGroups = [
    { name: "ECO 113", group: new Set(["ECO 113"]) },
    { name: "ECO 114", group: new Set(["ECO 114"]) },
    { name: "ECO 213", group: new Set(["ECO 213"]) },
    { name: "ECO 214", group: new Set(["ECO 214"]) },
    { name: "MAT 113 or MAT 121", group: COGNATE_GROUP },
    { name: "MAT 217, ECO 257, or PSY 217", group: STATS_GROUP },
    { name: "ECO 321 or BUSN 323", group: FINANCE_GROUP },
    { name: "ECO 461", group: new Set(["ECO 461"]) }
  ];

  for (const requirement of requiredGroups) {
    if (!hasGroupSatisfied(requirement.group, completedBeforePlan, placements, endOfPlanPosition)) {
      errors.push(`The plan must include the ${requirement.name} requirement.`);
    }
  }

  // Advisor-check cases.
  for (const placement of placements) {
    if (["ECO 307", "ECO 357", "ECO 370"].includes(placement.code)) {
      advisorChecks.push(`${placement.code} may require department or advisor confirmation.`);
    }
    if (placement.code === "ECO 471" && eco471Requested) {
      advisorChecks.push("ECO 471 is Senior Thesis and requires advisor confirmation.");
    }
  }

  const notesText = String(options.studentInput?.additionalNotes || "");
  if (/transfer|ap credit|waiver|substitut|catalog|permission|override/i.test(notesText)) {
    advisorChecks.push("Student note mentions a possible transfer/AP/waiver/substitution/catalog/permission issue; advisor confirmation is needed.");
  }

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    advisorChecks: [...new Set(advisorChecks)]
  };
}

export const courseRules = {
  TERMS,
  REQUIRED_ECO_COURSES,
  VALID_ECO_COURSES,
  MAY_BANNED_COURSES,
  STATS_GROUP,
  COGNATE_GROUP,
  FINANCE_GROUP,
  CROSS_LISTED_COURSES,
  SCHEDULE_2026_2027,
  PREREQUISITES
};
