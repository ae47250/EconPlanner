import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

export async function loadCanonicalPolicy({ repositoryRoot = DEFAULT_ROOT } = {}) {
  const manifest = await readJson(repositoryRoot, "policy/manifest/econ-2025-2026.1.json");
  const documents = {};
  for (const input of manifest.inputs) documents[input.id] = await readJson(repositoryRoot, input.path);
  const rules = Object.values(documents).flatMap(document => document.records || []).filter(rule => rule.status === "ACTIVE").toSorted((left, right) => left.ruleId.localeCompare(right.ruleId));
  return Object.freeze({
    calendar: await readJson(repositoryRoot, "policy/calendars/hanover-undergraduate.json"),
    manifest,
    documents,
    rules,
    byRuleId: Object.fromEntries(rules.map(rule => [rule.ruleId, rule])),
    courses: documents.courses.courses,
    schedule: documents["schedule-2026-2027"],
    offeringPatterns: documents["offering-patterns"].patterns,
    messages: documents["messages-en-US"].messages,
    provenance: documents.provenance,
    unresolved: documents.unresolved.questions
  });
}

const REQUIREMENT_RULE = Object.freeze({
  "eco-113": "REQ-ECO-113", "eco-114": "REQ-ECO-114", "eco-213": "REQ-ECO-213", "eco-214": "REQ-ECO-214",
  statistics: "REQ-STATISTICS", finance: "REQ-FINANCE", "eco-461": "REQ-ECO-461", cognate: "REQ-COGNATE"
});

function requirementRuleId(requirementId) {
  return String(requirementId || "").startsWith("eco-elective") ? "REQ-ECO-ELECTIVES" : REQUIREMENT_RULE[requirementId];
}

export function oracleEvaluateAllocation(policy, course, requirementId, { assignments = [], level100Electives = 0 } = {}) {
  const placement = typeof course === "object" ? course : { course };
  const code = String(placement.course || "").toUpperCase();
  const ruleId = requirementRuleId(requirementId);
  const rule = policy.byRuleId[ruleId];
  if (!rule) return { status: "UNKNOWN", ruleIds: [], reasonCode: "UNKNOWN_REQUIREMENT" };
  if (ruleId !== "REQ-ECO-ELECTIVES" && placement.source === "requirement-placeholder" && Array.isArray(placement.options)) {
    return (rule.effect.options || []).every(option => placement.options.includes(option))
      ? { status: "ALLOW", ruleIds: [ruleId], reasonCode: "REQUIREMENT_PLACEHOLDER_OPTIONS_MATCH" }
      : { status: "BLOCK", ruleIds: [ruleId], reasonCode: "COURSE_NOT_ELIGIBLE_FOR_REQUIREMENT" };
  }
  if (ruleId === "REQ-ECO-ELECTIVES") {
    const equivalency = policy.rules.find(record => record.condition.equivalentCodes?.includes(code));
    const canonical = equivalency?.effect.canonicalCourse || code;
    const excludedByRule = policy.rules.find(record => record.condition.course === canonical && record.effect.excludedRequirementRuleIds?.includes(ruleId));
    const required = policy.rules.some(record => record.effect.kind === "exact" && record.effect.options?.includes(canonical));
    const tooSmall = policy.courses.some(record => record.code === canonical && record.units < rule.effect.minimumCourseUnits);
    const pairing = policy.documents['compatibility-profile'].requirements.electiveConditionalCourses[canonical];
    const maximum = policy.byRuleId['ELECTIVE-MAX-ONE-100-LEVEL'].effect.maximumAcrossElectiveSlots;
    const tooMany100 = /^ECO 1\d\d$/.test(canonical) && level100Electives >= maximum;
    const pairingMissing = pairing && !assignments.some(item => item.slotId === pairing.slotId && item.code === pairing.assignedCode);
    const blocked = required || excludedByRule || tooSmall || tooMany100 || pairingMissing || !(canonical.startsWith(`${rule.effect.subject} `) || canonical === 'ECO ELECTIVE');
    return { status: blocked ? 'BLOCK' : 'ALLOW', ruleIds: [excludedByRule?.ruleId || ruleId], reasonCode: excludedByRule?.reasonCode || (blocked ? 'COURSE_NOT_ELIGIBLE_FOR_REQUIREMENT' : 'REQUIREMENT_OPTION_MATCH') };
  }
  return (rule.effect.options || []).includes(code)
    ? { status: "ALLOW", ruleIds: [ruleId], reasonCode: "REQUIREMENT_OPTION_MATCH" }
    : { status: "BLOCK", ruleIds: [ruleId], reasonCode: "COURSE_NOT_ELIGIBLE_FOR_REQUIREMENT" };
}

function approvalsCover(approvals, course, prerequisite, authority) {
  return approvals.some(approval => {
    if (approval.approvalId) {
      return approval.status === "APPROVED"
        && String(approval.scope?.course || "").toUpperCase() === course
        && String(approval.ruleId || "").includes(authority === "INSTRUCTOR" ? "MATH" : "INTERMEDIATE")
        && String(approval.authority || "").toUpperCase().includes(authority);
    }
    return String(approval.course || course).toUpperCase() === course
      && String(approval.prerequisite || "").toUpperCase() === prerequisite
      && String(approval.type || approval.authority || "").toUpperCase().includes(authority)
      && (!approval.authority || String(approval.authority).toUpperCase().includes(authority));
  });
}

export function oracleEvaluatePrerequisite(policy, course, { available = [], sameTerm = [], approvals = [] } = {}) {
  const code = String(course || "").toUpperCase();
  const availableSet = new Set(available.map(value => String(value).toUpperCase()));
  const sameTermSet = new Set(sameTerm.map(value => String(value).toUpperCase()));
  const rule = policy.rules.find(candidate => candidate.ruleType === "coursePrerequisite" && candidate.condition.course === code);
  if (!rule) return { status: "ALLOW", ruleIds: [], reasonCode: "NO_DECLARED_PREREQUISITE" };
  const concurrentApprovalCovers = prerequisite => {
    const permission = policy.rules.find(candidate => candidate.ruleType === "permissionException"
      && candidate.condition.dependentCourse === code
      && (candidate.condition.concurrentOptions || []).includes(prerequisite));
    return Boolean(permission && sameTermSet.has(prerequisite)
      && approvalsCover(approvals, code, prerequisite, permission.ruleId.includes("MATH") ? "INSTRUCTOR" : "DEPARTMENT"));
  };
  const unresolved = [];
  for (const prerequisite of rule.effect.allOf || []) {
    if (!availableSet.has(prerequisite) && !concurrentApprovalCovers(prerequisite)) unresolved.push(prerequisite);
  }
  for (const group of rule.effect.oneOfGroups || []) {
    const normalized = [...group].sort().join("|");
    const placeholderSatisfied = normalized === ["ECO 257", "MAT 217", "PSY 217"].sort().join("|")
      ? availableSet.has("STATISTICS REQUIREMENT")
      : normalized === ["MAT 113", "MAT 121"].sort().join("|")
        ? availableSet.has("MATHEMATICS COGNATE")
        : false;
    if (!placeholderSatisfied && !group.some(prerequisite => availableSet.has(prerequisite) || concurrentApprovalCovers(prerequisite))) unresolved.push(...group);
  }
  return unresolved.length
    ? { status: "BLOCK", ruleIds: [rule.ruleId], reasonCode: "PREREQUISITE_NOT_SATISFIED", missing: [...new Set(unresolved)] }
    : { status: "ALLOW", ruleIds: [rule.ruleId], reasonCode: "PREREQUISITES_SATISFIED" };
}

function canonicalTerm(term) {
  const value = String(term || "").toUpperCase();
  return ["SPRING", "SPRING/MAY", "MAY", "MAY TERM"].includes(value) ? "MAY" : value;
}

function termId(term) {
  const key = canonicalTerm(term.termKey || term.term);
  const years = String(term.academicYear || "").match(/(\d{4})\D+(\d{4})/);
  return years ? `${key === "FALL" ? years[1] : years[2]}-${key}` : null;
}

export function oracleEvaluateOffering(policy, course, term) {
  const normalizeCode = value => String(value || "").trim().toUpperCase();
  course = { ...course, course: normalizeCode(course.course) };
  term = { ...term, courses: (term.courses || []).map(row => ({ ...row, course: normalizeCode(row.course) })) };
  const key = canonicalTerm(term.termKey || term.term);
  const sections = policy.schedule.terms.find(row => row.termId === termId(term))?.sections || [];
  const verified = code => sections.some(row => row.course === code || (row.crossListedAs || []).includes(code));
  const reviewedScope = release => {
    const equivalency = policy.rules.find(record => record.condition.equivalentCodes?.includes(course.course));
    const identity = equivalency?.effect.canonicalCourse || course.course;
    const courseScope = (release?.coverageScopes || []).find(scope => scope.course === identity);
    return courseScope || (release?.coverageScopes || []).find(scope => scope.subject === identity.split(" ")[0]);
  };
  const block = (id, reason) => ({ status: "BLOCK", ruleIds: [id], reasonCode: reason });
  const capstone = policy.byRuleId["CAPSTONE-WINTER-ONLY"];
  if (course.course === capstone.condition.course && key !== "TBC" && !capstone.effect.allowedCanonicalTerms.includes(key)) {
    return block(capstone.ruleId, capstone.reasonCode);
  }
  const may = policy.byRuleId["PLANNING-MAY-COURSE-EXCLUSIONS"];
  if (key === may.condition.canonicalTerm && may.effect.excludedCourses.includes(course.course)
    && !(may.override.permitted && may.override.authority === "ACTIVE_EXACT_SCHEDULE" && verified(course.course))) {
    return block(may.ruleId, may.reasonCode);
  }
  for (const pattern of policy.offeringPatterns) {
    const codes = [pattern.course].flat();
    if (!codes.includes(course.course)) continue;
    const exactOverride = pattern.projectionPolicy.activeExactScheduleOverrides && verified(course.course);
    if (pattern.projectionPolicy.unpublishedTermEligibility === "APPROVED_RECURRING_TERMS_ONLY") {
      const releaseTerm = policy.schedule.terms.find(row => row.termId === termId(term));
      if (reviewedScope(releaseTerm)?.coverage === "COMPLETE" && !verified(course.course)) {
        return block("SCHEDULE-AVAILABILITY-BEHAVIOR", "NOT_OFFERED_IN_COMPLETE_SCHEDULE");
      }
      if (!pattern.approvedRecurringTerms.includes(key) && !exactOverride) {
        return block(pattern.patternId, "UNAPPROVED_UNPUBLISHED_TERM");
      }
    }
    if ((pattern.hardExcludedTerms || []).includes(key) && !exactOverride) {
      return block(pattern.patternId, "COURSE_TERM_EXCLUDED");
    }
    const others = (term.courses || []).filter(row => row.course !== course.course && codes.includes(row.course));
    if (key !== "TBC" && pattern.projectionPolicy.sameTerm === "REQUIRE_MATCHING_VERIFIED_SECTIONS"
      && others.length && !(verified(course.course) && others.every(row => verified(row.course)))) {
      return block(pattern.patternId, "INTERMEDIATE_SAME_TERM_REQUIRES_VERIFIED_SCHEDULE");
    }
  }
  const releaseTerm = policy.schedule.terms.find(candidate => candidate.termId === termId(term));
  const confirmation = policy.byRuleId["PLANNING-FUTURE-COURSE-CONFIRMATION"];
  const electiveNamed = (course.extra === true || String(course.requirementId || "").startsWith(confirmation.condition.electiveRequirementPrefix))
    && String(course.course).toUpperCase() !== "ECO ELECTIVE";
  const uncertainFinance = course.requirementId === confirmation.condition.financeRequirementId
    && course.course === confirmation.effect.unconfirmedFinanceCourse;
  if ((electiveNamed || uncertainFinance) && !course.fixedInProgress
    && !releaseTerm?.sections.some(row => (row.course === course.course || row.crossListedAs.includes(course.course))
      && (!course.section || row.sectionId.endsWith(`-${course.section}`)))) {
    return { status: "BLOCK", ruleIds: [confirmation.ruleId], reasonCode: confirmation.reasonCode };
  }
  if (course.source === "requirement-placeholder") {
    return { status: "PRELIMINARY", ruleIds: ["PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY"], reasonCode: "UNPUBLISHED_OFFERING_TBC" };
  }
  if (!releaseTerm && ["catalog-statement", "recurring-rule-unconfirmed", "historical-pattern"].includes(course.source)) {
    const key = canonicalTerm(term.termKey || term.term);
    const year = termId(term)?.split("-")[0];
    let supported = false;
    if (course.source === "historical-pattern") {
      const records = policy.documents["historical-offerings"]?.records || [];
      supported = records.some(record => record.courseIdentity === course.course
        && record.activationStatus === "ACTIVE_OWNER_APPROVED" && record.ownerApproval?.approved === true
        && Object.keys(record.conditionalTermDistribution || {}).includes(key));
    } else {
      const capstone = policy.byRuleId["CAPSTONE-WINTER-ONLY"];
      supported = course.source === "recurring-rule-unconfirmed" && course.course === capstone.condition.course
        && capstone.effect.allowedCanonicalTerms.includes(key) && Boolean(year)
        && capstone.effective.from <= `${year}-01-01`
        && (!capstone.effective.through || capstone.effective.through >= `${year}-12-31`);
      for (const pattern of policy.offeringPatterns) {
        if (![pattern.course].flat().includes(course.course)) continue;
        if (pattern.evidenceType !== (course.source === "catalog-statement" ? "OFFICIAL_CATALOG_STATEMENT" : "DEPARTMENT_RECURRING")) continue;
        if (!pattern.authorityBoundary || !pattern.sourceRefs?.length) continue;
        if (!pattern.approvedRecurringTerms.includes(key) || pattern.hardExcludedTerms.includes(key)) continue;
        if (!pattern.projectionPolicy.scheduleCoverage.some(coverage => coverage === "UNKNOWN" || coverage === "UNAVAILABLE")) continue;
        if (!year || !(pattern.effective.from <= `${year}-01-01`)) continue;
        if (pattern.effective.through && pattern.effective.through < `${year}-12-31`) continue;
        if (policy.offeringPatterns.some(replacement => replacement.supersedes.includes(pattern.patternId))) continue;
        supported = true;
      }
    }
    if (!supported) return { status: "UNKNOWN", ruleIds: [], reasonCode: "PROJECTION_EVIDENCE_OUT_OF_SCOPE" };
    return { status: "ALLOW", ruleIds: ["FUTURE-UNPUBLISHED-SCHEDULE-PLANNING-PROJECTION"], reasonCode: "FUTURE_SCHEDULE_PLANNING_PROJECTION" };
  }
  if (!releaseTerm && ["future-placeholder", "projected-offering"].includes(course.source)) {
    return { status: "ALLOW", ruleIds: ["FUTURE-UNPUBLISHED-SCHEDULE-PLANNING-PROJECTION"], reasonCode: "FUTURE_SCHEDULE_PLANNING_PROJECTION" };
  }
  if (!releaseTerm) return { status: "UNKNOWN", ruleIds: [], reasonCode: "SCHEDULE_TERM_NOT_COVERED" };
  const section = releaseTerm.sections.find(candidate => (candidate.course === course.course || candidate.crossListedAs.includes(course.course))
    && (!course.section || candidate.sectionId.endsWith(`-${course.section}`)));
  if (!section) {
    if (course.source === "verified-offering" && course.section) return {status:"BLOCK",ruleIds:["SCHEDULE-AVAILABILITY-BEHAVIOR"],reasonCode:"VERIFIED_SECTION_NOT_IN_ACTIVE_SCHEDULE"};
    const scope = reviewedScope(releaseTerm);
    return { status: scope?.coverage === "COMPLETE" ? "BLOCK" : "UNKNOWN", ruleIds: ["SCHEDULE-AVAILABILITY-BEHAVIOR"], reasonCode: scope?.coverage === "COMPLETE" ? "NOT_OFFERED_IN_COMPLETE_SCHEDULE" : "OFFERING_UNKNOWN", sourceRefs: scope?.sourceRefs || [] };
  }
  const outcome = policy.byRuleId["SCHEDULE-AVAILABILITY-BEHAVIOR"].effect[section.enrollmentState];
  return { status: outcome === "VERIFIED" ? "ALLOW" : outcome === "BLOCK" ? "BLOCK" : outcome === "CONDITIONAL" ? "CONDITIONAL" : outcome === "PRELIMINARY" ? "PRELIMINARY" : outcome, ruleIds: ["SCHEDULE-AVAILABILITY-BEHAVIOR"], reasonCode: `ENROLLMENT_${section.enrollmentState}` };
}

export function oracleEvaluateTermLoad(policy, term) {
  const key = canonicalTerm(term.termKey || term.term);
  if (key === "TBC") return { status: "PRELIMINARY", ruleIds: ["PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY"], reasonCode: "TERM_LOAD_TO_BE_CONFIRMED" };
  const rule = policy.rules.find(candidate => candidate.ruleType === "termLoad" && candidate.condition.canonicalTerm === key);
  if (!rule) return { status: "UNKNOWN", ruleIds: [], reasonCode: "TERM_CAPACITY_RULE_MISSING" };
  const economics = (term.courses || []).filter(course => String(course.course).startsWith("ECO ") || course.course === "ECO elective").length;
  const units = (term.courses || []).reduce((sum, course) => sum + Number(course.units ?? 1), 0) + Number(term.reservedCourseUnits || 0);
  const normal = rule.effect.normalCourseUnits ?? rule.effect.maxTotalCourses;
  const ceiling = rule.effect.conditionalMaximumCourseUnits ?? normal;
  const approval = term.termLoadEvidence?.advisorApproval === "APPROVED" && term.termLoadEvidence?.academicProbationStatus === "NOT_ON_ACADEMIC_PROBATION";
  if (units > ceiling || (rule.effect.maxEconomicsCourses && economics > rule.effect.maxEconomicsCourses)) return {status: "BLOCK", ruleIds: [rule.ruleId], reasonCode: "TERM_CAPACITY_EXCEEDED"};
  if (units > normal && !approval) {
    const probation = term.termLoadEvidence?.academicProbationStatus === "ON_ACADEMIC_PROBATION";
    const denied = term.termLoadEvidence?.advisorApproval === "NOT_APPROVED";
    return {status: probation || denied ? "BLOCK" : "UNKNOWN", ruleIds: [rule.ruleId], reasonCode: probation ? "TERM_OVERLOAD_NOT_ALLOWED_ON_ACADEMIC_PROBATION" : denied ? "TERM_OVERLOAD_APPROVAL_DENIED" : "TERM_OVERLOAD_EVIDENCE_REQUIRED"};
  }
  const preference = policy.byRuleId["PLANNING-ECO-LOAD-PREFERENCE"];
  const abovePreference = ["FALL", "WINTER"].includes(key) && economics > preference.effect.preferredMaxEconomicsCourses;
  return {status: units > normal ? "CONDITIONAL" : "ALLOW", ruleIds: abovePreference ? [rule.ruleId, preference.ruleId] : [rule.ruleId], reasonCode: units > normal ? "TERM_OVERLOAD_APPROVED" : abovePreference ? "ECONOMICS_LOAD_ABOVE_PREFERENCE" : "TERM_CAPACITY_AVAILABLE"};
}

export function oracleEvaluateElectiveTerm(policy, term) {
  const rule = policy.byRuleId["PLANNING-UNPUBLISHED-ELECTIVE-LIMIT"];
  const key = canonicalTerm(term.termKey || term.term);
  const assigned = (term.courses || []).filter(row => row.extra === true || String(row.requirementId || "").startsWith("eco-elective") || String(row.course).toUpperCase() === "ECO ELECTIVE");
  const exact = policy.schedule.terms.find(row => row.termId === termId(term));
  const matches = assigned.every(row => row.source === "verified-offering" && row.section && exact?.sections.some(section =>
    (section.course === row.course || section.crossListedAs.includes(row.course)) && section.sectionId.endsWith(`-${row.section}`)));
  const blocked = key === "TBC" ? assigned.length > rule.condition.canonicalTerms.length * rule.effect.maximumElectives
    : rule.condition.canonicalTerms.includes(key) && assigned.length > rule.effect.maximumElectives && !matches;
  return { status: blocked ? "BLOCK" : "ALLOW", ruleIds: [rule.ruleId], reasonCode: blocked ? rule.reasonCode : "ELECTIVE_TERM_CAPACITY_AVAILABLE" };
}

export function oracleEvaluateCanonicalPlan(policy, student, plan, expectedContext = null) {
  const findings = [];
  const slotContract = policy.rules.find(rule => rule.ruleId === "ELECTIVE-SLOT-UNIQUE-ASSIGNMENT");
  const declaredElectiveSlots = new Set();
  const assignments = (plan.terms || []).flatMap(term => (term.courses || []).filter(course => course.extra !== true).map(course => ({slotId:course.requirementId,code:course.course})));
  // The finance pairing can be satisfied by recorded work, not just a new
  // placement. Select it independently from the canonical requirement and its
  // recorded preference; never import the production mapper's assignments.
  const financeRule = policy.byRuleId["REQ-FINANCE"];
  const financePreference = policy.documents["compatibility-profile"].requirements.slots.find(slot => slot.id === "finance")?.preferredOptions || financeRule.effect.options;
  const recorded = new Set((student.courses || []).filter(course => ["completed", "transfer", "in_progress"].includes(course.status)).map(course => String(course.code).toUpperCase()));
  const recordedFinance = financePreference.find(code => financeRule.effect.options.includes(code) && recorded.has(code));
  if (recordedFinance && !assignments.some(item => item.slotId === "finance")) assignments.push({slotId: "finance", code: recordedFinance});
  let level100Electives = 0;
  const completed = (student.courses || []).filter(course => ["completed", "transfer"].includes(course.status)).map(course => String(course.code).toUpperCase());
  const inProgress = (student.courses || []).filter(course => course.status === "in_progress").map(course => String(course.code).toUpperCase());
  const available = new Set(completed);
  const currentTerm = policy.calendar.initialDropAddWindows.filter(window => window.start <= student.planCreationDate).toSorted((a, b) => b.start.localeCompare(a.start))[0];
  const termPosition = term => Number(String(term.academicYear).slice(0, 4)) * 3 + ["FALL", "WINTER", "MAY"].indexOf(canonicalTerm(term.canonicalTerm || term.termKey));
  for (const [termIndex, term] of (plan.terms || []).entries()) {
    if (currentTerm ? termPosition(term) > termPosition(currentTerm) : term.inProgressPrerequisitesAvailable === true) for (const code of inProgress) available.add(code);
    const isTbc = canonicalTerm(term.termKey || term.term) === "TBC";
    const termWindow = policy.calendar.initialDropAddWindows.find(window =>
      window.academicYear.replace("-", "/") === String(term.academicYear).replace("-", "/")
      && window.canonicalTerm === canonicalTerm(term.termKey));
    if (termWindow && student.planCreationDate > termWindow.end && (term.courses || []).some(course => !course.fixedInProgress)) findings.push({
      path: `$.terms[${termIndex}]`, status: "BLOCK", ruleIds: ["PLANNING-CURRENT-TERM-ADD-DROP"], reasonCode: "CURRENT_TERM_NEW_PLACEMENT_CLOSED"
    });
    findings.push({ path: `$.terms[${termIndex}]`, ...oracleEvaluateTermLoad(policy, { ...term, termLoadEvidence: student.termLoadOverrides?.[term.slotId] || student.termLoadOverrides?.[term.term] || student.termLoadOverrides?.[canonicalTerm(term.termKey)] || null, reservedCourseUnits: student.reservedCourseUnits?.[term.slotId] ?? student.reservedCourseUnits?.[term.term] ?? 0 }) });
    findings.push({ path: `$.terms[${termIndex}]`, ...oracleEvaluateElectiveTerm(policy, term) });
    if (isTbc) {
      const projectedGroups = new Map();
      for (const course of term.courses || []) {
        const projectedTerm = course.projectedTerm || "TBC";
        projectedGroups.set(projectedTerm, [...(projectedGroups.get(projectedTerm) || []), course]);
      }
      for (const [projectedTerm, courses] of projectedGroups) {
        if (projectedTerm !== "TBC") {
          findings.push({ path: `$.terms[${termIndex}]`, ...oracleEvaluateTermLoad(policy, { ...term, termKey: projectedTerm, courses }) });
          findings.push({ path: `$.terms[${termIndex}]`, ...oracleEvaluateElectiveTerm(policy, { ...term, termKey: projectedTerm, courses }) });
        }
      }
    }
    const indexedCourses = (term.courses || []).map((course, courseIndex) => ({ course, courseIndex }));
    const orderedCourses = isTbc
      ? indexedCourses.toSorted((left, right) => Number(left.course.planningSequence ?? Number.MAX_SAFE_INTEGER)
        - Number(right.course.planningSequence ?? Number.MAX_SAFE_INTEGER))
      : indexedCourses;
    const exactTerm = policy.schedule.terms.find(row => row.termId === termId(term));
    const sections = (term.courses || []).map(course => {
      const choices = exactTerm?.sections.filter(row => (row.course === course.course || row.crossListedAs.includes(course.course)) && (!course.section || row.sectionId.endsWith(`-${course.section}`))) || [];
      const scope = exactTerm?.coverageScopes.find(row => row.course === course.course)
        || exactTerm?.coverageScopes.find(row => row.subject === course.course.split(" ")[0]);
      return course.fixedInProgress && !course.section && (choices.length !== 1 || scope?.coverage !== "COMPLETE") ? null : choices[0];
    }).filter(Boolean);
    for (let left = 0; left < sections.length; left++) for (let right = left + 1; right < sections.length; right++) {
      const a = sections[left].meeting, b = sections[right].meeting;
      if (a?.days?.some(day => b?.days?.includes(day)) && a.startTime && a.endTime && b.startTime && b.endTime && a.startTime < b.endTime && b.startTime < a.endTime) findings.push({path: `$.terms[${termIndex}]`, status: "BLOCK", ruleIds: ["SCHEDULE-AVAILABILITY-BEHAVIOR"], reasonCode: "AUTHORITATIVE_MEETING_CONFLICT"});
    }
    let currentProjectedTerm = null;
    let pendingCourses = [];
    for (const { course, courseIndex } of orderedCourses) {
      if (isTbc && currentProjectedTerm !== null && course.projectedTerm !== currentProjectedTerm) {
        for (const pending of pendingCourses) available.add(String(pending).toUpperCase());
        pendingCourses = [];
      }
      if (isTbc) currentProjectedTerm = course.projectedTerm || `sequence-${course.planningSequence}`;
      const sameTerm = (term.courses || [])
        .filter(candidate => !isTbc || (candidate !== course && candidate.projectedTerm === course.projectedTerm))
        .flatMap(candidate => candidate.source === "requirement-placeholder" && Array.isArray(candidate.options)
          ? candidate.options
          : [candidate.course]);
      const path = `$.terms[${termIndex}].courses[${courseIndex}]`;
      if (course.fixedInProgress) {
        const section = sections.find(row => row.course === course.course || row.crossListedAs.includes(course.course));
        if (!section?.meeting?.days?.length || !section.meeting.startTime || !section.meeting.endTime) findings.push({path,status:"REVIEW_REQUIRED",ruleIds:["SCHEDULE-AVAILABILITY-BEHAVIOR"],reasonCode:"IN_PROGRESS_SECTION_MEETINGS_REVIEW"});
        continue;
      }
      if (slotContract?.scope.requirements.includes(course.requirementId)) {
        if (declaredElectiveSlots.has(course.requirementId)) findings.push({
          path: `${path}.requirementId`, status: "BLOCK", ruleIds: [slotContract.ruleId],
          reasonCode: slotContract.reasonCode
        });
        declaredElectiveSlots.add(course.requirementId);
      }
      // Owner-approved Extra contract, 2026-10-17: no degree allocation.
      if (course.extra === true) {
        if (!/^extra-economics-[1-9]\d*$/.test(course.requirementId || "") || !/^ECO (?:\d{3}|elective)$/.test(course.course || "")) findings.push({path,status:"BLOCK",ruleIds:[],reasonCode:"INVALID_EXTRA_COURSE"});
      } else findings.push({ path, ...oracleEvaluateAllocation(policy, course, course.requirementId, {assignments, level100Electives}) });
      if (String(course.requirementId).startsWith('eco-elective-') && /^ECO 1\d\d$/.test(course.course)) level100Electives++;
      if (course.course === policy.byRuleId['CAPSTONE-SENIOR-STANDING'].condition.course && expectedContext) findings.push({path, ...oracleEvaluateStanding(policy, term, expectedContext)});
      findings.push({ path, ...oracleEvaluateOffering(policy, course, term) });
      if (course.course !== "ECO elective" && !String(course.source).includes("placeholder")) findings.push({ path, ...oracleEvaluatePrerequisite(policy, course.course, { available: [...available], sameTerm, approvals: course.approvalRequired || [] }) });
      if (isTbc) pendingCourses.push(course.course);
    }
    if (isTbc) {
      for (const pending of pendingCourses) available.add(String(pending).toUpperCase());
    } else {
      for (const course of term.courses || []) available.add(String(course.course).toUpperCase());
    }
  }
  const status = findings.some(item => item.status === "BLOCK") ? "BLOCK"
    : findings.some(item => item.status === "UNKNOWN") ? "UNKNOWN"
      : findings.some(item => item.status === "REVIEW_REQUIRED") ? "REVIEW_REQUIRED"
        : findings.some(item => item.status === "PRELIMINARY") ? "PRELIMINARY"
          : findings.some(item => item.status === "CONDITIONAL") ? "CONDITIONAL" : "ALLOW";
  return { status, valid: !["BLOCK", "UNKNOWN"].includes(status), findings };
}

// Independent interpretation of the owner-approved final-year boundary.
export function oracleEvaluateStanding(policy, term, context) {
  const year = Number(String(term.academicYear).slice(0,4));
  const normal = policy.byRuleId['CAPSTONE-SENIOR-STANDING'];
  const early = policy.byRuleId['ACCELERATED-PLAN-FINAL-YEAR-SENIOR-STANDING'];
  const assumedFinal = early?.effect.assumeSeniorStandingInFinalPlanningYear === true
    && context.acceleratedPlanAssumesSeniorStanding === true
    && year + 1 === context.expectedGraduationYear
    && context.projectedSeniorStandingAcademicYear === `${year}/${year+1}`;
  const ordinarySenior = Number.isInteger(context.entryAcademicYearStart)
    && year - context.entryAcademicYearStart + 1 >= normal.effect.normalStandingBeginsCollegeYear;
  return {status: assumedFinal || ordinarySenior ? 'ALLOW' : 'BLOCK',ruleIds:[assumedFinal ? early.ruleId : normal.ruleId],reasonCode:assumedFinal ? early.reasonCode : normal.reasonCode};
}
