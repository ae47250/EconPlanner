import { createDecision } from "./contracts.js";
import { canonicalTerm, courseTermEligibility } from "./placement.js";

const TERM_KEYS = Object.freeze(["FALL", "WINTER", "MAY"]);

function academicYear(value) {
  const match = String(value || "").match(/(\d{4})\D+(\d{4})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function academicYearStart(value) {
  const match = String(value || "").match(/(\d{4})/);
  return match ? Number(match[1]) : null;
}

function allowedTerms(course, bundle, year) {
  const decisions = TERM_KEYS.map(key => ({ key, decision: courseTermEligibility(course,
    { termKey: key, academicYear: year }, bundle) }));
  return { keys: decisions.filter(item => item.decision.allowed).map(item => item.key),
    ruleIds: [...new Set(decisions.map(item => item.decision.ruleId).filter(Boolean))] };
}

function exactScheduleCoversYear(year, bundle) {
  const start = academicYearStart(year);
  if (!Number.isInteger(start)) return false;
  const ids = [`${start}-FALL`, `${start + 1}-WINTER`, `${start + 1}-MAY`];
  return ids.every(id => bundle.indexes.offeringByTerm?.[id]?.coverage === "COMPLETE");
}

function termCapacity(termKey, bundle) {
  const rule = bundle.rules.find(candidate => candidate.ruleType === "termLoad" && candidate.condition.canonicalTerm === termKey);
  return {
    maximum: Number(rule?.effect?.maxTotalCourses || (termKey === "MAY" ? 1 : 4)),
    ruleId: rule?.ruleId || null,
    sourceRefs: rule?.sourceRefs || []
  };
}

function reservedUnits(context, year, termKey) {
  const normalized = academicYear(year);
  const slot = (context.authoritativeSlots || []).find(candidate => (
    academicYear(candidate.academicYear) === normalized
    && canonicalTerm(candidate.canonicalTerm || candidate.termKey) === termKey
  ));
  return Math.max(0, Number(slot?.reservedCourseUnits || 0));
}

function approvalFor(course, prerequisite, permissionRule, facts, year) {
  const attached = Array.isArray(course.approvalRequired)
    ? course.approvalRequired
    : course.approvalRequired
      ? [course.approvalRequired]
      : [];
  return [...(facts.approvals || []), ...attached].find(approval => {
    if (approval?.status && approval.status !== "APPROVED" && !approval?._attachedRequired) return false;
    if (approval?.ruleId && approval.ruleId !== permissionRule.ruleId) return false;
    const dependent = String(approval?.scope?.course || approval?.course || "").toUpperCase();
    if (dependent && dependent !== String(course.course || "").toUpperCase()) return false;
    const approvalPrerequisite = String(approval?.prerequisite || "").toUpperCase();
    if (approvalPrerequisite && approvalPrerequisite !== prerequisite) return false;
    const term = String(approval?.scope?.termId || approval?.term || "");
    return !term || term.includes(String(year).replace("-", "/")) || term.includes(String(year));
  }) || null;
}

function plannedNodes(plan, bundle) {
  return (plan?.terms || []).flatMap(term => {
    if (canonicalTerm(term.termKey || term.canonicalTerm || term.term) !== "TBC") return [];
    const year = academicYear(term.academicYear);
    return (term.courses || []).map(course => {
      const allowed = allowedTerms(course, bundle, year);
      const courseId = [year, String(course.course || "").toUpperCase(), course.requirementId || "UNASSIGNED"].join("|");
      return {
        courseId,
        course: String(course.course || "").toUpperCase(),
        requirementId: course.requirementId || null,
        academicYear: year,
        rawCourse: course,
        placementWindow: {
          academicYear: year,
          allowedTermKeys: allowed.keys,
          earliestOrdinal: Math.min(...allowed.keys.map(key => TERM_KEYS.indexOf(key) + 1)),
          latestOrdinal: Math.max(...allowed.keys.map(key => TERM_KEYS.indexOf(key) + 1)),
          sourceRuleIds: [...new Set(allowed.ruleIds)].sort()
        }
      };
    });
  }).sort((left, right) => left.courseId.localeCompare(right.courseId));
}

function precedenceEdges(nodes, facts, bundle) {
  const completed = new Set((facts.courses || [])
    .filter(course => ["COMPLETED", "TRANSFER"].includes(course.status))
    .map(course => course.course));
  const byCourse = new Map();
  for (const node of nodes) byCourse.set(node.course, [...(byCourse.get(node.course) || []), node]);
  const edges = [];

  for (const after of nodes) {
    const rule = bundle.rules.find(candidate => candidate.ruleType === "coursePrerequisite" && candidate.condition.course === after.course);
    if (!rule) continue;
    const requiredGroups = [
      ...(rule.effect.allOf || []).map(code => [code]),
      ...(rule.effect.oneOfGroups || [])
    ];
    for (const group of requiredGroups) {
      if (group.some(code => completed.has(code))) continue;
      const before = group.flatMap(code => byCourse.get(code) || [])[0];
      if (!before) continue;
      const permissionRule = bundle.rules.find(candidate => candidate.ruleType === "permissionException"
        && candidate.condition.dependentCourse === after.course
        && (candidate.condition.concurrentOptions || []).includes(before.course));
      const approval = permissionRule ? approvalFor(after.rawCourse, before.course, permissionRule, facts, after.academicYear) : null;
      edges.push({
        beforeCourseId: before.course,
        afterCourseId: after.course,
        beforeAllocationCourseId: before.courseId,
        afterAllocationCourseId: after.courseId,
        relation: approval ? "CONCURRENT_WITH_APPROVAL" : "STRICT_PRIOR",
        approvalRuleId: approval ? permissionRule.ruleId : null,
        approvalEvidenceRef: approval?.evidenceRef || approval?.sourceRef || null,
        governingAuthority: approval ? permissionRule.authority : rule.authority,
        sourceRuleIds: [...new Set([rule.ruleId, ...(approval ? [permissionRule.ruleId] : [])])].sort(),
        sourceRefs: [...new Set([...(rule.sourceRefs || []), ...(approval ? permissionRule.sourceRefs || [] : [])])].sort()
      });
    }
  }
  return [...new Map(edges.map(edge => [`${edge.beforeAllocationCourseId}|${edge.afterAllocationCourseId}|${edge.relation}`, edge])).values()]
    .sort((left, right) => `${left.afterAllocationCourseId}|${left.beforeAllocationCourseId}`.localeCompare(`${right.afterAllocationCourseId}|${right.beforeAllocationCourseId}`));
}

function legalEdge(edge, assignments) {
  const before = assignments.get(edge.beforeAllocationCourseId);
  const after = assignments.get(edge.afterAllocationCourseId);
  if (!before || !after) return true;
  if (before.yearOrdinal > after.yearOrdinal) return false;
  if (edge.relation === "STRICT_PRIOR") return before.yearOrdinal < after.yearOrdinal;
  return before.yearOrdinal <= after.yearOrdinal;
}

function buildWitness(nodes, edges, context, bundle, plan) {
  const assignments = new Map();
  const capacity = new Map();
  const domains = new Map(nodes.map(node => [node.courseId, node.placementWindow.allowedTermKeys.map(termKey => ({
    termKey,
    ordinal: TERM_KEYS.indexOf(termKey) + 1,
    yearOrdinal: Number(academicYearStart(node.academicYear)) * TERM_KEYS.length + TERM_KEYS.indexOf(termKey) + 1
  }))]));

  function visit(index) {
    if (index >= nodes.length) return true;
    const node = nodes[index];
    for (const placement of domains.get(node.courseId)) {
      const capacityKey = `${node.academicYear}|${placement.termKey}`;
      const cap = termCapacity(placement.termKey, bundle);
      const available = Math.max(0, cap.maximum - reservedUnits(context, node.academicYear, placement.termKey));
      if ((capacity.get(capacityKey) || 0) >= available) continue;
      const fixedTermCourses = (plan.terms || []).filter(term => academicYear(term.academicYear) === node.academicYear
        && canonicalTerm(term.termKey || term.canonicalTerm || term.term) === placement.termKey)
        .flatMap(term => term.courses || []);
      const sameTerm = fixedTermCourses.concat(nodes.filter(other => other.academicYear === node.academicYear
        && assignments.get(other.courseId)?.termKey === placement.termKey).map(other => other.rawCourse));
      if (!courseTermEligibility(node.rawCourse, {
        academicYear: node.academicYear, termKey: placement.termKey, courses: sameTerm
      }, bundle).allowed) continue;
      assignments.set(node.courseId, placement);
      capacity.set(capacityKey, (capacity.get(capacityKey) || 0) + 1);
      if (edges.every(edge => legalEdge(edge, assignments)) && visit(index + 1)) return true;
      capacity.set(capacityKey, capacity.get(capacityKey) - 1);
      assignments.delete(node.courseId);
    }
    return false;
  }

  return visit(0) ? assignments : null;
}

export function buildTbcTemporalWitness(plan, facts, context = {}, bundle, { traceId = null } = {}) {
  const nodes = plannedNodes(plan, bundle);
  if (!nodes.length) return Object.freeze({ status: "NOT_APPLICABLE", placements: [], precedenceEdges: [], topologicalWitness: null, decisions: [] });
  const exactYear = nodes.find(node => exactScheduleCoversYear(node.academicYear, bundle));
  const edges = precedenceEdges(nodes, facts, bundle);
  const assignments = exactYear ? null : buildWitness(nodes, edges, context, bundle, plan);
  const preliminaryRule = bundle.indexes.byRuleId["PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY"];
  const sourceRuleIds = [...new Set(nodes.flatMap(node => node.placementWindow.sourceRuleIds).concat(edges.flatMap(edge => edge.sourceRuleIds)))].sort();
  const sourceRefs = [...new Set(edges.flatMap(edge => edge.sourceRefs).concat(preliminaryRule?.sourceRefs || []))].sort();
  const status = assignments ? "PRELIMINARY" : "BLOCK";
  const reasonCode = exactYear
    ? "EXACT_SCHEDULE_OVERRIDES_TBC_WINDOW"
    : assignments
      ? "TBC_TEMPORAL_WITNESS_FEASIBLE"
      : "TBC_TEMPORAL_WITNESS_IMPOSSIBLE";
  const decision = createDecision({
    bundle,
    traceId,
    status,
    classification: assignments ? "EVIDENCE" : "HARD",
    ruleIds: sourceRuleIds.length ? sourceRuleIds : [preliminaryRule?.ruleId].filter(Boolean),
    reasonCode,
    subject: { academicYears: [...new Set(nodes.map(node => node.academicYear))].sort() },
    objectPath: "$.terms",
    sourceRefs
  });
  const placements = nodes.map(node => ({
    courseId: node.courseId,
    course: node.course,
    requirementId: node.requirementId,
    placementWindow: node.placementWindow,
    assignedTermKey: assignments?.get(node.courseId)?.termKey || null,
    assignedOrdinal: assignments?.get(node.courseId)?.ordinal || null
  }));
  const topologicalWitness = assignments ? {
    legal: true,
    placements: placements.map(placement => ({
      courseId: placement.courseId,
      course: placement.course,
      academicYear: placement.placementWindow.academicYear,
      termKey: placement.assignedTermKey,
      ordinal: placement.assignedOrdinal
    })).sort((left, right) => (
      academicYearStart(left.academicYear) - academicYearStart(right.academicYear)
      || left.ordinal - right.ordinal
      || left.courseId.localeCompare(right.courseId)
    )),
    sourceRuleIds
  } : { legal: false, placements: [], sourceRuleIds };
  return Object.freeze({ status, placements, precedenceEdges: edges, topologicalWitness, decisions: [decision] });
}
