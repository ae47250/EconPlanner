const TERM_LABELS = { FALL: "Fall", WINTER: "Winter", MAY: "May", SUMMER: "Summer" };
const DAY_LABELS = { MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu", FRI: "Fri", SAT: "Sat", SUN: "Sun" };

function fail(message) {
  throw new Error(`Compatibility projection failed: ${message}`);
}

function sameMembers(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function requireRule(ruleById, ruleId) {
  const rule = ruleById[ruleId];
  if (!rule) fail(`missing canonical rule ${ruleId}`);
  return rule;
}

function sourcePath(sourceRef, sourceById) {
  const [sourceId, fragment] = sourceRef.split("#");
  const source = sourceById[sourceId];
  if (!source?.path) fail(`missing path for canonical source ${sourceId}`);
  if (!fragment) return source.path;
  return `${source.path}#${fragment.replace(/^Confirmed-/, "").toLowerCase()}`;
}

function courseId(code) {
  return code.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
}

function toClockTime(value) {
  const [hoursText, minutes] = value.split(":");
  const hours = Number(hoursText);
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 || 12}:${minutes} ${suffix}`;
}

function titleCaseStatus(value) {
  return `${value[0]}${value.slice(1).toLowerCase()}`;
}

function prerequisiteViews(rules, profile, sourceById) {
  const result = Object.fromEntries(rules
    .filter(rule => rule.ruleType === "coursePrerequisite")
    .map(rule => [rule.condition.course, { all: [...(rule.effect.allOf ?? [])], any: (rule.effect.oneOfGroups ?? []).map(group => [...group]) }]));

  for (const rule of rules.filter(candidate => candidate.ruleType === "permissionException")) {
    const dependentCourse = rule.condition.dependentCourse;
    if (dependentCourse && rule.effect.allowConcurrency) {
      const reason = profile.prerequisites.reasonByPermissionRule[rule.ruleId];
      if (!reason) fail(`missing compatibility reason for ${rule.ruleId}`);
      const permission = {
        options: [...rule.condition.concurrentOptions],
        approval: rule.effect.approvalAuthority.includes("instructor") ? "instructor" : "department",
        policySource: "department-confirmed-local-policy",
        sourceRef: sourcePath(rule.sourceRefs[0], sourceById),
        reason
      };
      if (rule.condition.lastResortOnly !== undefined) permission.lastResortOnly = rule.condition.lastResortOnly;
      if (rule.condition.requiresCompletedFromOptions !== undefined) permission.requiresCompletedFromOptions = rule.condition.requiresCompletedFromOptions;
      if (rule.condition.requiresCompletedBeforeTargetTerm !== undefined) permission.requiresCompletedBeforeTargetTerm = rule.condition.requiresCompletedBeforeTargetTerm;
      if (rule.condition.earlierPendingCoursesRequireSuccessfulCompletion !== undefined) permission.earlierPendingCoursesRequireSuccessfulCompletion = rule.condition.earlierPendingCoursesRequireSuccessfulCompletion;
      if (rule.condition.maxConcurrent !== undefined) permission.maxConcurrent = rule.condition.maxConcurrent;
      (result[dependentCourse] ??= { all: [], any: [] }).concurrentWithApproval = [permission];
    }
    if (rule.condition.course && rule.effect.required) {
      (result[rule.condition.course] ??= { all: [], any: [] }).permission = rule.effect.approvalAuthority.includes("Department") ? "department" : "instructor";
    }
  }
  return result;
}

function offeringEvidence(schedule) {
  const result = {};
  for (const term of schedule.terms) {
    const label = TERM_LABELS[term.canonicalTerm];
    for (const section of term.sections) {
      if (!section.course.startsWith("ECO ")) continue;
      const terms = ((result[section.course] ??= {})[schedule.academicYear] ??= []);
      if (!terms.includes(label)) terms.push(label);
    }
  }
  return result;
}

function coursesView({ courses, prerequisites, schedule, profile }) {
  const canonicalByCode = Object.fromEntries(courses.courses.map(course => [course.code, course]));
  if (!sameMembers(profile.courses.order, Object.keys(canonicalByCode))) fail("course order does not cover the canonical course inventory");
  if (!sameMembers(Object.keys(profile.courses.metadataByCourse), Object.keys(canonicalByCode))) fail("course metadata does not cover the canonical course inventory");
  const evidenceByCourse = offeringEvidence(schedule);

  return {
    catalogYear: courses.catalogYear,
    sourceStatus: profile.courses.sourceStatus,
    sourceRefs: [...profile.courses.sourceRefs],
    courses: profile.courses.order.map(code => {
      const canonical = canonicalByCode[code];
      const metadata = profile.courses.metadataByCourse[code];
      const evidence = structuredClone(evidenceByCourse[code] ?? {});
      const coursePrerequisites = structuredClone(prerequisites[code] ?? { all: [], any: [] });
      if (coursePrerequisites.concurrentWithApproval) {
        const legacyConcurrent = coursePrerequisites.concurrentWithApproval
          .filter(permission => permission.lastResortOnly)
          .map(permission => ({
            options: permission.options,
            approval: permission.approval,
            policySource: "department-approved",
            lastResortOnly: true
          }));
        if (legacyConcurrent.length) coursePrerequisites.concurrentWithApproval = legacyConcurrent;
        else delete coursePrerequisites.concurrentWithApproval;
      }
      const projected = {
        canonicalId: courseId(code),
        code,
        aliases: [...(canonical.equivalentCodes ?? [])],
        title: canonical.title,
        ...(metadata.titleAliases ? { titleAliases: [...metadata.titleAliases] } : {}),
        units: canonical.units,
        prerequisites: coursePrerequisites,
        apEligible: profile.courses.apEligible.includes(code),
        studentSelectable: !profile.courses.notStudentSelectable.includes(code),
        ...(metadata.residency ? { residency: metadata.residency } : {}),
        electiveEligibility: metadata.electiveEligibility,
        offeringEvidence: evidence,
        ...(metadata.recurringOfferingRule ? { recurringOfferingRule: structuredClone(metadata.recurringOfferingRule) } : {})
      };
      return projected;
    })
  };
}

function requirementsView({ courses, requirements, rules, profile }) {
  const ruleById = Object.fromEntries(rules.map(rule => [rule.ruleId, rule]));
  const courseByCode = Object.fromEntries(courses.courses.map(course => [course.code, course]));
  const fixedSlots = profile.requirements.slots.map(metadata => {
    const rule = requireRule(ruleById, metadata.ruleId);
    const options = [...new Set([...(metadata.optionOrder || []), ...rule.effect.options])]
      .filter(option => rule.effect.options.includes(option));
    const units = courseByCode[options[0]]?.units;
    if (units === undefined || options.some(code => courseByCode[code]?.units !== units)) fail(`${metadata.ruleId} has incompatible course units`);
    return {
      id: metadata.id,
      label: rule.effect.kind === "choice" ? options.join(" / ") : metadata.label,
      kind: rule.effect.kind,
      options: [...options],
      ...(metadata.preferredOptions ? { preferredOptions: [...metadata.preferredOptions] } : {}),
      ...(rule.effect.residency ? { residency: rule.effect.residency === "HANOVER_COLLEGE" ? "hanover" : rule.effect.residency } : {}),
      units,
      ...(metadata.capstonePrerequisiteOptions ? { capstonePrerequisiteOptions: [...options] } : {})
    };
  });

  const electiveRule = requireRule(ruleById, "REQ-ECO-ELECTIVES");
  const exactRequired = fixedSlots.filter(slot => slot.kind === "exact" && slot.options[0]?.startsWith("ECO ")).flatMap(slot => slot.options);
  const allocationExclusions = rules
    .filter(rule => rule.ruleType === "requirementAllocation" && rule.effect.excludedRequirementRuleIds?.includes("REQ-ECO-ELECTIVES"))
    .map(rule => rule.condition.course);
  const underUnitEconomics = courses.courses.filter(course => course.code.startsWith("ECO ") && course.units < electiveRule.effect.minimumCourseUnits).map(course => course.code);
  const derivedExclusions = [...new Set([...exactRequired, ...allocationExclusions, ...underUnitEconomics])];
  const excludedCourses = [...new Set([...profile.requirements.electiveExclusionOrder, ...derivedExclusions])].filter(code => derivedExclusions.includes(code));
  const confirmedSpecialTopicsElectives = rules
    .filter(rule => rule.ruleType === "requirementAllocation" && rule.effect.eligibleRequirements?.includes("REQ-ECO-ELECTIVES") && rule.condition.course?.match(/^ECO [236]60$/))
    .map(rule => rule.condition.course);
  const maxLevel100 = requireRule(ruleById, "ELECTIVE-MAX-ONE-100-LEVEL").effect.maximumAcrossElectiveSlots;
  const electiveSlots = Array.from({ length: electiveRule.effect.slotCount }, (_, index) => ({
    id: `eco-elective-${index + 1}`,
    label: `ECO elective ${index + 1}`,
    kind: electiveRule.effect.kind,
    subject: electiveRule.effect.subject,
    excludedCourses,
    conditionalCourses: structuredClone(profile.requirements.electiveConditionalCourses),
    confirmedSpecialTopicsElectives,
    maxLevel100,
    units: electiveRule.effect.minimumCourseUnits
  }));
  const countRule = requireRule(ruleById, "REQ-MAJOR-COURSE-COUNT");
  const noDoubleCount = requireRule(ruleById, "ELECTIVE-NO-DOUBLE-COUNT");

  return {
    id: profile.requirements.id,
    catalogYear: requirements.records[0].scope.catalogYears[0],
    sourceStatus: profile.requirements.sourceStatus,
    sourceRefs: [...profile.requirements.sourceRefs],
    requirementSlots: [...fixedSlots, ...electiveSlots],
    rules: {
      totalMajorCourses: countRule.effect.majorCourseCount,
      totalCognateCourses: countRule.effect.cognateCourseCount,
      max100LevelElectives: maxLevel100,
      noDoubleCountUnlessExplicit: noDoubleCount.effect.courseMayFillAtMostOneRequirement
    }
  };
}

function planningConstraintsView({ rules, offeringPatterns, profile }) {
  const ruleById = Object.fromEntries(rules.map(rule => [rule.ruleId, rule]));
  const loadPreference = requireRule(ruleById, "PLANNING-ECO-LOAD-PREFERENCE");
  const terms = {};
  for (const rule of rules.filter(candidate => candidate.ruleType === "termLoad" && candidate.condition.canonicalTerm)) {
    const label = TERM_LABELS[rule.condition.canonicalTerm];
    const effect = rule.effect;
    terms[label] = {
      maxTotalCourses: effect.maxTotalCourses,
      normalCourseUnits: effect.normalCourseUnits,
      conditionalMaximumCourseUnits: effect.conditionalMaximumCourseUnits,
      conditionalRequirements: ["ADVISOR_APPROVAL", effect.conditionalRequirements.academicProbationStatus],
      ...(effect.maxEconomicsCourses !== undefined ? { maxEconomicsCourses: effect.maxEconomicsCourses } : {})
    };
    if (loadPreference.condition.canonicalTerms.includes(rule.condition.canonicalTerm)) {
      terms[label].preferredMaxEconomicsCourses = loadPreference.effect.preferredMaxEconomicsCourses;
      terms[label].graduationMaxEconomicsCourses = effect.maxTotalCourses;
    }
  }
  terms.Summer = structuredClone(profile.planningConstraints.summer);

  const hardRules = profile.planningConstraints.hardRules.map(entry => {
    for (const ruleId of entry.ruleIds) requireRule(ruleById, ruleId);
    return entry.text;
  });
  const projectedPatterns = {};
  for (const [patternId, text] of Object.entries(profile.planningConstraints.offeringPatternText)) {
    const pattern = offeringPatterns.patterns.find(candidate => candidate.patternId === patternId);
    if (!pattern) fail(`missing canonical offering pattern ${patternId}`);
    projectedPatterns[(Array.isArray(pattern.course) ? pattern.course : [pattern.course]).join(" / ")] = text;
  }
  const advisingPreferences = profile.planningConstraints.advisingPreferences.map(entry => {
    for (const ruleId of entry.ruleIds) requireRule(ruleById, ruleId);
    return entry.text;
  });
  for (const ruleId of profile.planningConstraints.futureSchedulePolicy.ruleIds) requireRule(ruleById, ruleId);

  return {
    terms,
    hardRules,
    offeringPatterns: projectedPatterns,
    advisingPreferences,
    futureSchedulePolicy: profile.planningConstraints.futureSchedulePolicy.text
  };
}

function scheduleView({ schedule, provenance, profile }) {
  const sourceById = Object.fromEntries(provenance.sources.map(source => [source.sourceId, source]));
  const sourceFiles = [...new Set(schedule.sourceRefs.map(sourceRef => sourcePath(sourceRef, sourceById).split("#")[0]))];
  const terms = {};
  for (const term of schedule.terms) {
    terms[TERM_LABELS[term.canonicalTerm]] = term.sections.map(section => {
      const evidenceSources = section.sourceRefs.map(ref => sourceById[ref.split("#")[0]]);
      const commonDate = field => {
        const values = [...new Set(evidenceSources.map(source => source?.[field] ?? null))];
        return values.length === 1 ? values[0] : null;
      };
      const projected = {
        course: section.course,
        section: section.sectionId.split("-").at(-1),
        title: section.title,
        ...(section.crossListedAs.length ? { crossListedAs: [...section.crossListedAs] } : {}),
        faculty: section.instructor ?? null,
        instructor: section.instructor ?? null,
        units: section.units,
        availability: {
          status: section.enrollmentState.toLowerCase(),
          rawStatus: titleCaseStatus(section.enrollmentState),
          seatsOpen: section.seatsOpen ?? null,
          capacity: section.capacity ?? null,
          asOf: section.availabilityAsOf ?? null
        },
        meeting: {
          days: section.meeting.days.map(day => DAY_LABELS[day]),
          startTime: toClockTime(section.meeting.startTime),
          endTime: toClockTime(section.meeting.endTime),
          startDate: section.meeting.startDate,
          endDate: section.meeting.endDate,
          delivery: section.meeting.delivery.toLowerCase(),
          location: section.meeting.location
        },
        provenance: {
          sourceType: "user_provided_schedule_screenshot",
          sourceFiles: [...new Set(section.sourceRefs.map(sourceRef => sourcePath(sourceRef, sourceById).split("#")[0]))],
          sourceDocumentDate: commonDate("sourceDocumentDate"),
          screenshotRetrievedOn: commonDate("receivedOn"),
          repositoryIngestedOn: commonDate("repositoryIngestedOn"),
          humanVerifiedOn: commonDate("reviewedOn"),
          verifiedOn: section.verificationDate ?? null,
          normalizationCheck: "row_checked"
        },
        verificationStatus: "verified"
      };
      return projected;
    });
  }

  return {
    schemaVersion: 2,
    academicYear: schedule.academicYear,
    verifiedOn: null,
    lastVerifiedAt: null,
    availabilityAsOf: null,
    source: { type: "reviewed_schedule_evidence", sectionCodeSMeans: "May", sourceDocumentDate: null, files: sourceFiles },
    courseOfferingNotes: structuredClone(profile.schedule.courseOfferingNotes),
    coverageByTerm: Object.fromEntries(schedule.terms.map(term => [TERM_LABELS[term.canonicalTerm], {
      coverage: term.coverage,
      coverageScopes: structuredClone(term.coverageScopes)
    }])),
    terms
  };
}

export function buildCompatibilityRepresentations({ courses, requirements, rules, schedule, offeringPatterns, provenance, profile }) {
  if (profile.policyVersion !== courses.policyVersion || profile.policyVersion !== requirements.policyVersion) {
    fail("compatibility profile policy version does not match canonical inputs");
  }
  const sourceById = Object.fromEntries(provenance.sources.map(source => [source.sourceId, source]));
  const prerequisites = prerequisiteViews(rules, profile, sourceById);
  return {
    "courses.json": coursesView({ courses, prerequisites, schedule, profile }),
    "requirements.json": requirementsView({ courses, requirements, rules, profile }),
    "prerequisites.json": prerequisites,
    "planning-constraints.json": planningConstraintsView({ rules, offeringPatterns, profile }),
    "schedule-2026-2027.json": scheduleView({ schedule, provenance, profile })
  };
}
