import fc from "fast-check";

export const ECONOMICS_GENERATOR_AXES = Object.freeze({
  standing: Object.freeze(["freshman", "sophomore", "junior", "senior"]),
  planDate: Object.freeze(["2026-07-30", "2026-09-15", "2027-02-15"]),
  transferStatus: Object.freeze(["regular", "transfer"]),
  graduationHorizon: Object.freeze([1, 2, 3, 4, 5]),
  courseStatus: Object.freeze(["completed", "in_progress", "transfer"]),
  completedPathway: Object.freeze([
    "none",
    "foundations",
    "micro",
    "macro",
    "micro-elective",
    "intermediates",
    "statistics",
    "cross-list"
  ]),
  reservedCapacity: Object.freeze([0, 1, 2]),
  availabilityState: Object.freeze(["open", "waitlisted", "closed", "unknown"]),
  approvalState: Object.freeze(["not-required", "valid-instructor", "valid-department"])
});

const AXIS_NAMES = Object.freeze(Object.keys(ECONOMICS_GENERATOR_AXES));
const STATUS_PRIORITY = Object.freeze({ completed: 3, transfer: 2, in_progress: 1 });
const PATHWAY_TERMINALS = Object.freeze({
  none: [],
  foundations: ["ECO 113", "ECO 114"],
  micro: ["ECO 213"],
  macro: ["ECO 214"],
  "micro-elective": ["ECO 331"],
  intermediates: ["ECO 213", "ECO 214"],
  statistics: ["ECO 257"],
  "cross-list": ["PHI 234"]
});
const ELECTIVE_CANDIDATES = Object.freeze([
  "ECO 161",
  "ECO 221",
  "ECO 222",
  "ECO 234",
  "ECO 260",
  "ECO 333"
]);

function normalizeSeed(seed) {
  const numeric = Number(seed);
  if (!Number.isSafeInteger(numeric)) {
    throw new TypeError("A safe integer seed is required.");
  }
  return Math.abs(numeric % 0x7fffffff) || 1;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function manifestBody(manifest) {
  return manifest?.policy?.id ? manifest : manifest;
}

function crossListMap(manifest) {
  const result = new Map();
  for (const rule of manifestBody(manifest).electiveRules || []) {
    if (!rule.canonicalCourse || !Array.isArray(rule.equivalentCodes)) continue;
    for (const course of rule.equivalentCodes) {
      result.set(String(course).trim().toUpperCase(), rule.canonicalCourse);
    }
  }
  return result;
}

export function canonicalizeGeneratedCourse(course, manifest) {
  const normalized = String(course || "").trim().toUpperCase();
  return crossListMap(manifest).get(normalized) || normalized;
}

function confirmedPrerequisiteRule(course, manifest) {
  const canonical = canonicalizeGeneratedCourse(course, manifest);
  return (manifestBody(manifest).prerequisiteRules || []).find(rule =>
    rule.status === "CONFIRMED"
      && canonicalizeGeneratedCourse(rule.course, manifest) === canonical
  ) || null;
}

function choiceIndex(seed, course, groupIndex, length) {
  return Number.parseInt(stableHash(`${seed}:${course}:${groupIndex}`), 16) % length;
}

export function independentPrerequisiteClosure(course, manifest, seed = 1) {
  const prerequisites = new Set();
  const visiting = new Set();

  function visit(current) {
    const canonical = canonicalizeGeneratedCourse(current, manifest);
    if (visiting.has(canonical)) return;
    visiting.add(canonical);
    const rule = confirmedPrerequisiteRule(canonical, manifest);
    if (rule) {
      const direct = [...(rule.allOf || [])];
      for (const [groupIndex, group] of (rule.oneOfGroups || []).entries()) {
        if (!group.length) continue;
        direct.push(group[choiceIndex(seed, canonical, groupIndex, group.length)]);
      }
      for (const prerequisite of direct) {
        const prerequisiteCanonical = canonicalizeGeneratedCourse(prerequisite, manifest);
        visit(prerequisiteCanonical);
        prerequisites.add(prerequisiteCanonical);
      }
    }
    visiting.delete(canonical);
  }

  visit(course);
  return [...prerequisites];
}

function axisArbitrary() {
  return fc.record(Object.fromEntries(
    AXIS_NAMES.map(name => [name, fc.constantFrom(...ECONOMICS_GENERATOR_AXES[name])])
  ));
}

function pairToken(leftName, leftValue, rightName, rightValue) {
  return JSON.stringify([leftName, leftValue, rightName, rightValue]);
}

function pairTokensForAxes(axes) {
  const tokens = [];
  for (let left = 0; left < AXIS_NAMES.length; left += 1) {
    for (let right = left + 1; right < AXIS_NAMES.length; right += 1) {
      const leftName = AXIS_NAMES[left];
      const rightName = AXIS_NAMES[right];
      tokens.push(pairToken(leftName, axes[leftName], rightName, axes[rightName]));
    }
  }
  return tokens;
}

function allPairTokens() {
  const tokens = new Set();
  for (let left = 0; left < AXIS_NAMES.length; left += 1) {
    for (let right = left + 1; right < AXIS_NAMES.length; right += 1) {
      const leftName = AXIS_NAMES[left];
      const rightName = AXIS_NAMES[right];
      for (const leftValue of ECONOMICS_GENERATOR_AXES[leftName]) {
        for (const rightValue of ECONOMICS_GENERATOR_AXES[rightName]) {
          tokens.add(pairToken(leftName, leftValue, rightName, rightValue));
        }
      }
    }
  }
  return tokens;
}

function buildPairwiseAxes(seed) {
  const normalizedSeed = normalizeSeed(seed);
  const candidates = new Map();
  let candidateNumber = 0;

  for (let left = 0; left < AXIS_NAMES.length; left += 1) {
    for (let right = left + 1; right < AXIS_NAMES.length; right += 1) {
      const leftName = AXIS_NAMES[left];
      const rightName = AXIS_NAMES[right];
      for (const leftValue of ECONOMICS_GENERATOR_AXES[leftName]) {
        for (const rightValue of ECONOMICS_GENERATOR_AXES[rightName]) {
          candidateNumber += 1;
          const fillerSeed = normalizeSeed(normalizedSeed + Math.imul(candidateNumber, 104729));
          const filler = fc.sample(axisArbitrary(), { seed: fillerSeed, numRuns: 1 })[0];
          const axes = { ...filler, [leftName]: leftValue, [rightName]: rightValue };
          const signature = JSON.stringify(AXIS_NAMES.map(name => axes[name]));
          if (!candidates.has(signature)) candidates.set(signature, axes);
        }
      }
    }
  }

  const uncovered = allPairTokens();
  const remaining = [...candidates.values()];
  const selected = [];

  while (uncovered.size) {
    let bestIndex = -1;
    let bestCoverage = -1;
    for (let index = 0; index < remaining.length; index += 1) {
      const coverage = pairTokensForAxes(remaining[index])
        .filter(token => uncovered.has(token)).length;
      if (coverage > bestCoverage) {
        bestCoverage = coverage;
        bestIndex = index;
      }
    }
    if (bestIndex < 0 || bestCoverage <= 0) {
      throw new Error(`Pairwise generation stopped with ${uncovered.size} uncovered pairs.`);
    }
    const [winner] = remaining.splice(bestIndex, 1);
    selected.push(winner);
    for (const token of pairTokensForAxes(winner)) uncovered.delete(token);
  }

  return selected;
}

function activeAcademicYearStart(planDate) {
  const date = new Date(`${planDate}T12:00:00Z`);
  const year = date.getUTCFullYear();
  return date.getUTCMonth() >= 5 ? year : year - 1;
}

function addCourse(courseMap, submittedCourse, status, manifest, origin) {
  const course = canonicalizeGeneratedCourse(submittedCourse, manifest);
  const existing = courseMap.get(course);
  if (existing && STATUS_PRIORITY[existing.status] >= STATUS_PRIORITY[status]) return;
  courseMap.set(course, {
    course,
    units: 1,
    status,
    source: status === "transfer" ? "fictional-transfer-credit" : "fictional-direct-record",
    origin,
    ...(course !== submittedCourse ? { submittedCourse } : {})
  });
}

function buildCourses(axes, manifest, seed) {
  const courses = new Map();
  for (const terminal of PATHWAY_TERMINALS[axes.completedPathway]) {
    for (const prerequisite of independentPrerequisiteClosure(terminal, manifest, seed)) {
      addCourse(courses, prerequisite, "completed", manifest, "independent-prerequisite-closure");
    }
    addCourse(courses, terminal, axes.courseStatus, manifest, "pathway-terminal");
  }
  return [...courses.values()].sort((left, right) => left.course.localeCompare(right.course));
}

function verifiedIntermediatePattern(verifiedSchedule) {
  function courseEvidence(course) {
    const sections = (verifiedSchedule.sections || []).filter(section => section.course === course);
    const terms = [...new Set(sections.map(section => section.term))];
    if (terms.length !== 1) {
      throw new Error(`Expected one verified term for ${course}; found ${terms.join(", ") || "none"}.`);
    }
    return {
      course,
      term: terms[0],
      sections: sections.map(section => section.section).sort()
    };
  }
  return {
    academicYear: verifiedSchedule.academicYear,
    micro: courseEvidence("ECO 213"),
    macro: courseEvidence("ECO 214")
  };
}

function approvalForState(state) {
  if (state === "valid-instructor") {
    return {
      ruleId: "CONCURRENT-MATH-ECO-213",
      course: "ECO 213",
      concurrentCourse: "MAT 113",
      term: "Fall",
      authority: "ECO 213 instructor",
      status: "recorded"
    };
  }
  if (state === "valid-department") {
    return {
      ruleId: "CONCURRENT-INTERMEDIATE-ECO-461",
      course: "ECO 461",
      concurrentCourse: "ECO 214",
      term: "Winter",
      authority: "Economics Department",
      status: "recorded"
    };
  }
  return null;
}

function statisticsCourse(seed, pathway) {
  if (pathway === "statistics") return "ECO 257";
  const choices = ["ECO 257", "MAT 217", "PSY 217"];
  return choices[normalizeSeed(seed) % choices.length];
}

function buildElectiveCandidates(manifest) {
  return [...new Set(ELECTIVE_CANDIDATES.map(course =>
    canonicalizeGeneratedCourse(course, manifest)
  ))].sort();
}

function profileIdentifier(seed, axes) {
  const signature = JSON.stringify(AXIS_NAMES.map(name => axes[name]));
  return `fictional-econ-${normalizeSeed(seed)}-${stableHash(signature)}`;
}

function buildProfile({ seed, axes, manifest, verifiedSchedule, sequenceIndex = null }) {
  const normalizedSeed = normalizeSeed(seed);
  const academicYearStart = activeAcademicYearStart(axes.planDate);
  const transfer = axes.transferStatus === "transfer";
  const profile = {
    seed: normalizedSeed,
    profileId: profileIdentifier(normalizedSeed, axes),
    fictional: true,
    kind: "valid-fictional-profile",
    ...(Number.isInteger(sequenceIndex) ? { sequenceIndex } : {}),
    axes: structuredClone(axes),
    student: {
      academicStanding: axes.standing,
      planDate: axes.planDate,
      isTransferStudent: transfer,
      expectedGraduationYear: academicYearStart + axes.graduationHorizon,
      ...(transfer ? {
        transferExpectedGraduationYear: academicYearStart + axes.graduationHorizon,
        transferEntryAcademicYear: `${academicYearStart - 1}-${academicYearStart}`
      } : {}),
      courses: buildCourses(axes, manifest, normalizedSeed),
      reservedCapacity: {
        Fall: axes.reservedCapacity,
        Winter: axes.reservedCapacity,
        May: Math.min(1, axes.reservedCapacity)
      }
    },
    scenario: {
      availability: {
        state: axes.availabilityState,
        source: "fictional-generator-scenario"
      },
      approval: approvalForState(axes.approvalState)
    },
    requirementHints: {
      statistics: {
        requirementRuleId: "REQ-STATISTICS",
        course: statisticsCourse(normalizedSeed, axes.completedPathway)
      },
      electiveCandidates: buildElectiveCandidates(manifest),
      electiveAssignments: []
    },
    verifiedSchedulePattern: verifiedIntermediatePattern(verifiedSchedule),
    generation: {
      selectionMode: "seeded-pairwise-greedy",
      prerequisiteSource: "independent-policy-manifest",
      shrinkable: true
    }
  };
  profile.policyAudit = auditGeneratedFictionalProfile(profile, manifest, verifiedSchedule);
  if (!profile.policyAudit.valid) {
    throw new Error(`Generated profile ${profile.profileId} failed its independent policy audit: ${JSON.stringify(profile.policyAudit.violations)}`);
  }
  return profile;
}

export function pairwiseCoverageReport(profiles) {
  const covered = new Set(profiles.flatMap(profile => pairTokensForAxes(profile.axes)));
  const required = allPairTokens();
  return {
    requiredPairs: required.size,
    coveredPairs: [...required].filter(token => covered.has(token)).length,
    missingPairs: [...required].filter(token => !covered.has(token))
  };
}

export function auditGeneratedFictionalProfile(profile, manifest, verifiedSchedule) {
  const violations = [];
  const courses = profile?.student?.courses || [];
  const canonicalCourses = courses.map(entry => canonicalizeGeneratedCourse(entry.course, manifest));
  const courseEntries = new Map();

  if (profile?.fictional !== true || !profile?.profileId || !Number.isSafeInteger(profile?.seed)) {
    violations.push({ ruleId: "GENERATOR-FICTIONAL-IDENTITY", message: "A fictional marker, seed, and profile ID are required." });
  }

  for (const [index, course] of canonicalCourses.entries()) {
    if (courseEntries.has(course)) {
      violations.push({
        ruleId: "ELECTIVE-CROSSLIST-ECO-234-PHI-234",
        course,
        message: `Canonical course ${course} appears more than once.`
      });
    } else {
      courseEntries.set(course, courses[index]);
    }
  }

  const completed = new Set([...courseEntries.entries()]
    .filter(([, entry]) => ["completed", "transfer"].includes(entry.status))
    .map(([course]) => course));

  for (const [course] of courseEntries) {
    const rule = confirmedPrerequisiteRule(course, manifest);
    if (!rule) continue;
    for (const prerequisite of rule.allOf || []) {
      const canonical = canonicalizeGeneratedCourse(prerequisite, manifest);
      if (!completed.has(canonical)) {
        violations.push({
          ruleId: rule.ruleId,
          course,
          missing: canonical,
          message: `${course} is missing required prior course ${canonical}.`
        });
      }
    }
    for (const group of rule.oneOfGroups || []) {
      const canonicalGroup = group.map(option => canonicalizeGeneratedCourse(option, manifest));
      if (!canonicalGroup.some(option => completed.has(option))) {
        violations.push({
          ruleId: rule.ruleId,
          course,
          missingOneOf: canonicalGroup,
          message: `${course} is missing one prior course from ${canonicalGroup.join(", ")}.`
        });
      }
    }
  }

  const statistics = profile?.requirementHints?.statistics;
  if (!statistics || statistics.requirementRuleId !== "REQ-STATISTICS") {
    violations.push({ ruleId: "REQ-STATISTICS", message: "Statistics must use the statistics requirement slot." });
  }

  const electiveValues = [
    ...(profile?.requirementHints?.electiveCandidates || []),
    ...(profile?.requirementHints?.electiveAssignments || []).map(entry => entry.course)
  ].map(course => canonicalizeGeneratedCourse(course, manifest));
  if (electiveValues.includes("ECO 257")) {
    violations.push({
      ruleId: "ELECTIVE-ECO-257-STATISTICS-ONLY",
      course: "ECO 257",
      message: "ECO 257 may not be an Economics elective."
    });
  }
  const candidateElectives = (profile?.requirementHints?.electiveCandidates || [])
    .map(course => canonicalizeGeneratedCourse(course, manifest));
  if (new Set(candidateElectives).size !== candidateElectives.length
      || JSON.stringify(candidateElectives) !== JSON.stringify([...candidateElectives].sort())) {
    violations.push({
      ruleId: "GENERATOR-ELECTIVE-SYMMETRY",
      message: "Elective candidates must be canonical, unique, and sorted."
    });
  }

  const approval = profile?.scenario?.approval;
  if (profile?.axes?.approvalState === "not-required" && approval) {
    violations.push({ ruleId: "GENERATOR-APPROVAL-STATE", message: "Approval metadata was supplied when no approval was selected." });
  }
  if (profile?.axes?.approvalState !== "not-required") {
    const approvalRules = [
      ...(manifestBody(manifest).concurrencyRules || []),
      ...(manifestBody(manifest).permissionRules || [])
    ];
    const rule = approvalRules.find(candidate => candidate.ruleId === approval?.ruleId);
    if (!rule) {
      violations.push({ ruleId: "GENERATOR-APPROVAL-STATE", message: "The approval rule is missing or unknown." });
    } else {
      if (approval.authority !== rule.approvalAuthority) {
        violations.push({ ruleId: rule.ruleId, field: "authority", message: "Approval authority does not match the manifest." });
      }
      if (canonicalizeGeneratedCourse(approval.course, manifest)
          !== canonicalizeGeneratedCourse(rule.course, manifest)) {
        violations.push({ ruleId: rule.ruleId, field: "course", message: "Approval course does not match the manifest." });
      }
      if (rule.concurrentOptions && !rule.concurrentOptions
        .map(course => canonicalizeGeneratedCourse(course, manifest))
        .includes(canonicalizeGeneratedCourse(approval.concurrentCourse, manifest))) {
        violations.push({ ruleId: rule.ruleId, field: "concurrentCourse", message: "Concurrent course does not match the manifest." });
      }
    }
  }

  if (verifiedSchedule) {
    const canonicalPattern = verifiedIntermediatePattern(verifiedSchedule);
    const pattern = profile?.verifiedSchedulePattern;
    if (pattern?.academicYear !== canonicalPattern.academicYear
        || pattern?.micro?.term !== canonicalPattern.micro.term
        || pattern?.macro?.term !== canonicalPattern.macro.term
        || pattern?.micro?.term === pattern?.macro?.term) {
      violations.push({
        ruleId: "PLANNING-INTERMEDIATE-OFFERING-SEPARATION",
        message: "The verified ECO 213/ECO 214 term pattern was not preserved."
      });
    }
  }

  return {
    valid: violations.length === 0,
    manifestId: manifestBody(manifest).policy.id,
    manifestVersion: manifestBody(manifest).policy.version,
    checkedRuleIds: [...new Set([
      ...(manifestBody(manifest).prerequisiteRules || []).map(rule => rule.ruleId),
      "ELECTIVE-ECO-257-STATISTICS-ONLY",
      "ELECTIVE-CROSSLIST-ECO-234-PHI-234",
      "PLANNING-INTERMEDIATE-OFFERING-SEPARATION"
    ])],
    violations
  };
}

export function generateFictionalEconomicsProfiles({
  seed,
  manifest,
  verifiedSchedule,
  maximumProfiles = 100
}) {
  const normalizedSeed = normalizeSeed(seed);
  const axesRows = buildPairwiseAxes(normalizedSeed);
  if (axesRows.length > maximumProfiles) {
    throw new RangeError(`Complete pairwise coverage requires ${axesRows.length} profiles, above maximumProfiles=${maximumProfiles}.`);
  }
  const profiles = axesRows.map((axes, index) => buildProfile({
    seed: normalizedSeed,
    axes,
    manifest,
    verifiedSchedule,
    sequenceIndex: index
  }));
  return {
    seed: normalizedSeed,
    selectionMode: "seeded-pairwise-greedy",
    profiles,
    coverage: pairwiseCoverageReport(profiles)
  };
}

export function fictionalEconomicsProfileArbitrary({ manifest, verifiedSchedule }) {
  return fc.record({
    caseSeed: fc.integer({ min: 1, max: 0x7ffffffe }),
    axes: axisArbitrary()
  }).map(({ caseSeed, axes }) => buildProfile({
    seed: caseSeed,
    axes,
    manifest,
    verifiedSchedule
  }));
}

export function shrinkFictionalEconomicsProfile(profile, { manifest, verifiedSchedule }) {
  const candidates = [];
  for (const name of [...AXIS_NAMES].reverse()) {
    const minimum = ECONOMICS_GENERATOR_AXES[name][0];
    if (profile.axes[name] === minimum) continue;
    const axes = { ...profile.axes, [name]: minimum };
    const candidate = buildProfile({
      seed: profile.seed,
      axes,
      manifest,
      verifiedSchedule
    });
    candidate.generation.shrinkOf = profile.profileId;
    candidate.generation.shrunkAxis = name;
    candidates.push(candidate);
  }
  return candidates;
}

function invalidNeighbor(base, mutationId, expectedViolationRuleId, mutate, manifest, verifiedSchedule) {
  const neighbor = structuredClone(base);
  neighbor.kind = "invalid-fictional-neighbor";
  neighbor.profileId = `${base.profileId}-invalid-${mutationId}`;
  neighbor.invalidNeighbor = {
    mutationId,
    expectedViolationRuleId,
    changedRules: 1
  };
  mutate(neighbor);
  neighbor.policyAudit = auditGeneratedFictionalProfile(neighbor, manifest, verifiedSchedule);
  return neighbor;
}

export function generateInvalidEconomicsNeighbors({ seed, manifest, verifiedSchedule }) {
  const normalizedSeed = normalizeSeed(seed);
  const common = {
    standing: "sophomore",
    planDate: "2026-07-30",
    transferStatus: "regular",
    graduationHorizon: 3,
    courseStatus: "completed",
    reservedCapacity: 1,
    availabilityState: "open",
    approvalState: "not-required"
  };
  const micro = buildProfile({
    seed: normalizedSeed,
    axes: { ...common, completedPathway: "micro" },
    manifest,
    verifiedSchedule
  });
  const approval = buildProfile({
    seed: normalizedSeed + 1,
    axes: { ...common, completedPathway: "none", approvalState: "valid-instructor" },
    manifest,
    verifiedSchedule
  });
  const statistics = buildProfile({
    seed: normalizedSeed + 2,
    axes: { ...common, completedPathway: "foundations" },
    manifest,
    verifiedSchedule
  });
  statistics.requirementHints.statistics.course = "MAT 217";
  const crossList = buildProfile({
    seed: normalizedSeed + 3,
    axes: { ...common, completedPathway: "cross-list" },
    manifest,
    verifiedSchedule
  });

  return [
    invalidNeighbor(
      micro,
      "missing-math-prerequisite",
      "PREREQ-ECO-213",
      profile => {
        profile.student.courses = profile.student.courses.filter(entry => !["MAT 113", "MAT 121"].includes(entry.course));
      },
      manifest,
      verifiedSchedule
    ),
    invalidNeighbor(
      approval,
      "wrong-approval-authority",
      "CONCURRENT-MATH-ECO-213",
      profile => {
        profile.scenario.approval.authority = "Economics Department";
      },
      manifest,
      verifiedSchedule
    ),
    invalidNeighbor(
      statistics,
      "eco-257-as-elective",
      "ELECTIVE-ECO-257-STATISTICS-ONLY",
      profile => {
        profile.requirementHints.electiveAssignments = [{
          requirementRuleId: "REQ-ECO-ELECTIVES",
          slot: "elective-1",
          course: "ECO 257"
        }];
      },
      manifest,
      verifiedSchedule
    ),
    invalidNeighbor(
      crossList,
      "duplicate-cross-list",
      "ELECTIVE-CROSSLIST-ECO-234-PHI-234",
      profile => {
        profile.student.courses.push({
          course: "PHI 234",
          units: 1,
          status: "completed",
          source: "fictional-direct-record",
          origin: "invalid-neighbor"
        });
      },
      manifest,
      verifiedSchedule
    )
  ];
}
