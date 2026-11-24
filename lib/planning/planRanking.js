// Ranking depends on planner helpers passed at creation time so economics.js does not import itself.
export function createPlanRanking({
  MATH_OPTIONS,
  STATISTICS_OPTIONS,
  ECONOMICS_LOAD_PREFERENCE,
  CAPSTONE_CONCURRENCY_PREFERENCE,
  loadPlanningFlexibilityPolicy,
  plannerTrackedYearLoads,
  plannerTrackedTermLoad,
  termShapePenalty,
  completedCourseSet,
  financePreferenceRank,
  isEconomicCourse,
  capstoneYearIndex,
  semanticPlanSignature
}) {
  function yearIndexForCourse(plan, code) {
    const term = (plan?.terms || []).find(item => (
      (item.courses || []).some(course => course.course === code)
    ));
    return term ? Number(term.yearIndex) : Number.POSITIVE_INFINITY;
  }

  function firstYearCourseCount(plan, matcher) {
    return (plan?.terms || [])
      .filter(term => term.yearIndex === 0)
      .flatMap(term => term.courses || [])
      .filter(matcher)
      .length;
  }

  function annualLoads(plan) {
    return plannerTrackedYearLoads(plan);
  }

  function fallWinterImbalance(plan) {
    const loads = (plan?.terms || [])
      .filter(term => ["Fall", "Winter"].includes(term.termKey))
      .map(term => term.courses.length);
    return loads.length ? Math.max(...loads) - Math.min(...loads) : 0;
  }

  function statisticsCourse(plan) {
    return (plan?.terms || [])
      .flatMap(term => (term.courses || []).map(course => ({ term, course })))
      .find(item => STATISTICS_OPTIONS.includes(item.course.course)) || null;
  }

  function statisticsSafetyPenalty(plan) {
    const selected = statisticsCourse(plan);
    if (!selected) return 10;
    const course = selected.course;
    const availability = course.availability?.status;
    const availabilityRank = availability === "open" ? 0 : availability === "waitlisted" ? 1 : availability === "unknown" ? 2 : 3;
    const verifiedFirstYearRank = selected.term.yearIndex === 0 && course.source === "verified-offering" ? 0 : 1;
    const meetingRank = course.meeting?.days?.length
      && Number.isFinite(course.meeting?.startMinutes)
      && Number.isFinite(course.meeting?.endMinutes)
      ? 0
      : 1;
    return verifiedFirstYearRank * 100 + availabilityRank * 10 + meetingRank * 3 + selected.term.yearIndex;
  }

  function electiveRelevancePenalty(plan, preferredPrerequisites, prerequisites = {}) {
    const electives = (plan?.terms || [])
      .flatMap(term => (term.courses || []).map(course => ({ term, course })))
      .filter(item => String(item.course.requirementId || "").startsWith("eco-elective"));
    if (!electives.length) return 0;
    return electives.some(item => (
      (prerequisites?.[item.course.course]?.all || []).some(code => preferredPrerequisites.has(code))
    )) ? 0 : 1;
  }

  function strategyScore(plan, { planVariant, student, prerequisites = {} } = {}) {
    const loads = annualLoads(plan);
    const target = plan?.distribution?.targetYearCounts || [];
    const annualDistance = target.reduce((sum, count, index) => sum + Math.abs(count - (loads[index] || 0)), 0);
    const withinYearPenalty = termShapePenalty(plan, plan?.distribution);
    const maximumAnnualLoad = Math.max(0, ...loads);
    const regularLoads = (plan?.terms || [])
      .filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey))
      .map(term => term.courses.length);
    const maxTermLoad = Math.max(0, ...regularLoads);

    if (planVariant?.strategy === "explore-first") {
      const preferences = planVariant.rankingPreferences || {};
      const firstYearTargetDistance = preferences.firstYearTargetFormula
        ? Math.abs((loads[0] || 0) - (target[0] || 0))
        : 0;
      const nondecreasingViolations = preferences.preferNondecreasingAnnualLoad
        ? loads.slice(1).reduce((sum, load, index) => sum + Math.max(0, loads[index] - load), 0)
        : 0;
      const typicalFinalYearLoads = preferences.typicalFinalYearTrackedLoad || [];
      const finalYearLoad = loads.at(-1) || 0;
      const finalYearGuidancePenalty = typicalFinalYearLoads.includes(finalYearLoad)
        ? 0
        : finalYearLoad === preferences.acceptableFinalYearTrackedLoad ? 1 : 2;
      const pacingScore = [firstYearTargetDistance, annualDistance, withinYearPenalty, nondecreasingViolations, finalYearGuidancePenalty];
      const completed = completedCourseSet(student);
      const standing = plan?.planningContext?.effectiveStanding || String(student?.academicStanding || "").toLowerCase();
      const firstYear = item => firstYearCourseCount(plan, item);
      if (standing === "freshman") {
        const introductions = ["ECO 113", "ECO 114"].filter(code => !completed.has(code));
        const introByYearOne = introductions.some(code => yearIndexForCourse(plan, code) === 0) ? 0 : 1;
        const introductionsInYearOne = introductions.filter(code => yearIndexForCourse(plan, code) === 0).length;
        const portableCount = firstYear(course => (
          [...MATH_OPTIONS, ...STATISTICS_OPTIONS].includes(course.course)
        ));
        const earlyAdvanced = firstYear(course => (
          /^ECO (2\d{2}|3\d{2}|4\d{2})$/.test(course.course)
          && !["ECO 257"].includes(course.course)
        ));
        return [...pacingScore, introByYearOne, introductionsInYearOne > 1 ? introductionsInYearOne - 1 : 0, portableCount ? 0 : 1, earlyAdvanced];
      }

      if (standing === "sophomore") {
        const has113 = completed.has("ECO 113");
        const has114 = completed.has("ECO 114");
        const hasMath = MATH_OPTIONS.some(code => completed.has(code));
        const priorityCourses = has113 && !has114
          ? ["ECO 114", ...(hasMath ? ["ECO 213"] : [])]
          : has114 && !has113
            ? ["ECO 113", ...(hasMath ? ["ECO 214"] : [])]
            : [];
        const sequenceLate = priorityCourses.reduce((sum, code) => (
          sum + (completed.has(code) || yearIndexForCourse(plan, code) === 0 ? 0 : 1)
        ), 0);
        const statsLate = STATISTICS_OPTIONS.some(code => completed.has(code))
          || STATISTICS_OPTIONS.some(code => yearIndexForCourse(plan, code) === 0)
          ? 0
          : 1;
        const mathLate = hasMath || MATH_OPTIONS.some(code => yearIndexForCourse(plan, code) === 0) ? 0 : 1;
        const preferredPrerequisites = new Set(has113 ? ["ECO 113", "ECO 213"] : ["ECO 114", "ECO 214"]);
        return [
          ...pacingScore,
          mathLate,
          sequenceLate,
          statsLate,
          statisticsSafetyPenalty(plan),
          electiveRelevancePenalty(plan, preferredPrerequisites, prerequisites)
        ];
      }
    }

    if (planVariant?.strategy === "one-year-early") {
      const maxEco = Math.max(0, ...(plan?.terms || []).map(term => (
        (term.courses || []).filter(course => isEconomicCourse(course.course)).length
      )));
      return [maxTermLoad, maxEco, annualDistance, withinYearPenalty];
    }

    return [annualDistance, withinYearPenalty, fallWinterImbalance(plan), maximumAnnualLoad];
  }

  function compareScoreArrays(left = [], right = []) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const difference = Number(left[index] || 0) - Number(right[index] || 0);
      if (difference) return difference;
    }
    return 0;
  }

  function compareStrategyCandidates(left, right, options) {
    const financeDifference = financePreferenceRank(left, options.student) - financePreferenceRank(right, options.student);
    const economicsLoadPenalty = plan => (plan?.terms || []).reduce((sum, term) => (
      sum + Math.max(0, (term.courses || []).filter(course => isEconomicCourse(course.course)).length
        - Number(ECONOMICS_LOAD_PREFERENCE?.preferredMaximumPerTerm || 2))
    ), 0);
    // ECONOMICS_LOAD_PREFERENCE: stay within the preferred Economics load when possible.
    if (ECONOMICS_LOAD_PREFERENCE?.aboveMaximumOnlyWhenNoValidPlanWithinPreferenceMeetsTarget) {
      const loadDifference = economicsLoadPenalty(left) - economicsLoadPenalty(right);
      if (loadDifference) return loadDifference;
    }
    const capstoneConcurrencyPenalty = plan => (plan?.terms || []).filter(term => (
      (term.courses || []).some(course => course.course === CAPSTONE_CONCURRENCY_PREFERENCE?.course)
        && (term.courses || []).some(course => CAPSTONE_CONCURRENCY_PREFERENCE?.concurrentCourses?.includes(course.course))
    )).length;
    // CAPSTONE_CONCURRENCY_PREFERENCE: concurrent capstone courses are a last resort.
    if (CAPSTONE_CONCURRENCY_PREFERENCE?.lastResortOnly) {
      const concurrencyDifference = capstoneConcurrencyPenalty(left) - capstoneConcurrencyPenalty(right);
      if (concurrencyDifference) return concurrencyDifference;
    }
    // Planning-flexibility policy: prefer an earlier capstone.
    const capstoneDifference = capstoneYearIndex(left) - capstoneYearIndex(right);
    if (capstoneDifference) return capstoneDifference;
    const projectedStatisticsPenalty = plan => (plan?.terms || []).flatMap(term => term.courses || [])
      .some(course => course.requirementId === "statistics" && course.course === "ECO 257"
        && course.source === "projected-offering") ? 1 : 0;
    // Planning-flexibility policy: prefer the frequent statistics option for Explore.
    if (options.planVariant.strategy === "explore-first"
      && loadPlanningFlexibilityPolicy().policy.supportingCoursePlacement.ranking.preferFrequentStatisticsOptionWhenEquallySafe) {
      const statisticsDifference = projectedStatisticsPenalty(left) - projectedStatisticsPenalty(right);
      if (statisticsDifference) return statisticsDifference;
    }
    const leftScore = strategyScore(left, options);
    const rightScore = strategyScore(right, options);
    const yearlyScoreLength = options.planVariant.strategy === "explore-first" ? 2
      : options.planVariant.strategy === "one-year-early" ? 3 : 1;
    const yearlyDifference = compareScoreArrays(leftScore.slice(0, yearlyScoreLength), rightScore.slice(0, yearlyScoreLength));
    // Planning-flexibility policy: One Year Early puts finance before yearly fit.
    if (options.planVariant.strategy === "one-year-early" && financeDifference) return financeDifference;
    // plan-ranking-decision-2026-11-23: Balanced and Explore put yearly fit first.
    if (yearlyDifference) return yearlyDifference;
    // Planning-flexibility policy: then prefer the verified finance option.
    if (financeDifference) return financeDifference;
    // plan-ranking-decision-2026-11-23: verified courses break equal yearly fit.
    const safetyDifference = compareAcademicSafetyPlans(left, right);
    if (safetyDifference) return safetyDifference;
    const scoreDifference = compareScoreArrays(leftScore.slice(yearlyScoreLength), rightScore.slice(yearlyScoreLength));
    // Planning-flexibility policy: use the remaining strategy pacing rules.
    if (scoreDifference) return scoreDifference;
    const preliminaryMatches = plan => (plan?.terms || []).reduce((count, term) => (
      count + (term.courses || []).filter(course => course.preliminaryScheduleEvidence).length
    ), 0);
    // Planning-flexibility policy: preliminary evidence and plan safety settle final ties.
    return preliminaryMatches(right) - preliminaryMatches(left) || compareEconomicsPlans(left, right);
  }

  function planSafetyMetrics(plan) {
    const terms = plan?.terms || [];
    const courses = terms.flatMap(term => term.courses || []);
    const requiredApprovals = plan?.feasibility?.requiredApprovals || courses.flatMap(course => course.approvalRequired || []);
    const enrollmentConditions = plan?.feasibility?.enrollmentConditions || [];
    const assignableCourses = courses.filter(course => course.fixedInProgress !== true);
    const verifiedCount = assignableCourses.filter(course => ["verified-offering", "summer-last-resort"].includes(course.source)).length;
    const namedProjectionCount = assignableCourses.filter(course => (
      course.course !== "ECO elective" && course.source !== "requirement-placeholder"
    )).length;
    const placeholderCount = assignableCourses.filter(course => (
      course.course === "ECO elective" || course.source === "requirement-placeholder"
    )).length;
    const veryLowHistoricalCount = assignableCourses.filter(course => course.historicalPriority === "VERY_LOW").length;
    const maxEco = Math.max(0, ...terms.map(term => term.courses.filter(course => isEconomicCourse(course.course)).length));
    const regularLoads = terms.filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey)).map(term => term.courses.length);
    const yearTerms = new Map();
    for (const term of terms.filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey))) {
      const loads = yearTerms.get(term.yearIndex) || {Fall: 0, Winter: 0, May: 0};
      const key = term.termKey === "Spring" ? "May" : term.termKey;
      loads[key] = plannerTrackedTermLoad(term);
      yearTerms.set(term.yearIndex, loads);
    }
    let annualOverFour = 0;
    let fourCoursePatternPenalty = 0;
    let mayCourseCount = 0;
    let mayTermCount = 0;
    for (const loads of yearTerms.values()) {
      const total = loads.Fall + loads.Winter + loads.May;
      annualOverFour += Math.max(0, total - 4);
      if (total === 4) {
        const signature = `${loads.Fall}/${loads.Winter}/${loads.May}`;
        fourCoursePatternPenalty += ["1/2/1", "2/1/1"].includes(signature) ? 0 : signature === "2/2/0" ? 1 : 2;
      }
      if (loads.May > 0) {
        mayTermCount += 1;
        mayCourseCount += loads.May;
      }
    }
    const overloadCount = (plan?.validation?.conditions || []).filter(item => item.reasonCode === "TERM_OVERLOAD_APPROVED").length;
    return {
      verifiedCount,
      namedProjectionCount,
      placeholderCount,
      veryLowHistoricalCount,
      approvalWeight: requiredApprovals.reduce((sum, item) => sum + (item.type === "department" ? 2 : 1), 0),
      conditionCount: enrollmentConditions.length,
      annualOverFour,
      fourCoursePatternPenalty,
      mayCourseCount,
      mayTermCount,
      overloadCount,
      maxEco,
      loadSquares: regularLoads.reduce((sum, count) => sum + count * count, 0),
      imbalance: regularLoads.length ? Math.max(...regularLoads) - Math.min(...regularLoads) : 0,
      signature: semanticPlanSignature(plan)
    };
  }

  const SAFETY_KEYS = [
    ["verifiedCount", -1],
    ["namedProjectionCount", -1],
    ["placeholderCount", 1],
    ["approvalWeight", 1],
    ["conditionCount", 1],
    ["veryLowHistoricalCount", 1]
  ];

  function compareSharedSafetyKeys(a, b) {
    for (const [key, direction] of SAFETY_KEYS) {
      const difference = direction * (a[key] - b[key]);
      if (difference) return difference;
    }
    return 0;
  }

  function compareAcademicSafetyPlans(left, right) {
    const a = planSafetyMetrics(left);
    const b = planSafetyMetrics(right);
    return compareSharedSafetyKeys(a, b)
      || a.overloadCount - b.overloadCount
      || a.maxEco - b.maxEco;
  }

  function compareEconomicsPlans(left, right) {
    const a = planSafetyMetrics(left);
    const b = planSafetyMetrics(right);
    return capstoneYearIndex(left) - capstoneYearIndex(right)
      || compareSharedSafetyKeys(a, b)
      || a.annualOverFour - b.annualOverFour
      || a.fourCoursePatternPenalty - b.fourCoursePatternPenalty
      || b.mayTermCount - a.mayTermCount
      || b.mayCourseCount - a.mayCourseCount
      || a.overloadCount - b.overloadCount
      || a.maxEco - b.maxEco
      || a.loadSquares - b.loadSquares
      || a.imbalance - b.imbalance
      || a.signature.localeCompare(b.signature);
  }

  return { compareStrategyCandidates, compareEconomicsPlans, planSafetyMetrics, strategyScore };
}
