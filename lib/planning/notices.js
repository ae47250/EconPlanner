import {loadPlanningFlexibilityPolicy} from "../catalog/policy-releases.js";

export const SCHEDULE_PROVENANCE = Object.freeze({
  PUBLISHED_SCHEDULE: "PUBLISHED_SCHEDULE",
  PLANNING_PROJECTION: "PLANNING_PROJECTION"
});

const PROJECTED_SOURCES = new Set([
  "future-placeholder",
  "projected-offering",
  "recurring-rule-unconfirmed"
]);

export function courseScheduleProvenance(course = {}) {
  if (Object.values(SCHEDULE_PROVENANCE).includes(course.scheduleProvenance)) {
    return course.scheduleProvenance;
  }
  return PROJECTED_SOURCES.has(course.source)
    ? SCHEDULE_PROVENANCE.PLANNING_PROJECTION
    : SCHEDULE_PROVENANCE.PUBLISHED_SCHEDULE;
}

export function planPublicationStatus(plan = {}) {
  return (plan.terms || []).some(term => (
    (term.courses || []).some(course => courseScheduleProvenance(course) === SCHEDULE_PROVENANCE.PLANNING_PROJECTION)
  ))
    ? SCHEDULE_PROVENANCE.PLANNING_PROJECTION
    : SCHEDULE_PROVENANCE.PUBLISHED_SCHEDULE;
}

function policyNotice(source, ruleId, policyVersion, extra = {}) {
  return Object.freeze({
    code: source.code,
    title: "Planning information",
    severity: "info",
    message: source.message,
    blocking: false,
    readinessImpact: "NONE",
    audience: source.audience,
    controllingRuleIds: [ruleId],
    policyVersion,
    ...extra
  });
}

export function buildPlanNotices(plan = {}, planningContext = {}, catalogApplicability = null) {
  const bundle = loadPlanningFlexibilityPolicy();
  const policy = bundle.policy;
  const notices = [];
  if (planningContext?.acceleratedPlanAssumesSeniorStanding) {
    notices.push(policyNotice(
      policy.acceleratedSeniorStanding.notice,
      policy.acceleratedSeniorStanding.ruleId,
      bundle.bundleVersion,
      {category: "PLANNING_ASSUMPTION"}
    ));
  }
  if (planPublicationStatus(plan) === SCHEDULE_PROVENANCE.PLANNING_PROJECTION) {
    notices.push(policyNotice(
      policy.futureScheduleProjection.notice,
      policy.futureScheduleProjection.ruleId,
      bundle.bundleVersion,
      {
        category: "SCHEDULE_PUBLICATION_STATUS",
        publicationStatus: SCHEDULE_PROVENANCE.PLANNING_PROJECTION
      }
    ));
  }
  notices.push(...(catalogApplicability?.advisorNotifications || []).map(notice => ({
    ...notice,
    audience: ["ACADEMIC_ADVISOR"]
  })));
  return [...new Map(notices.map(notice => [notice.code, notice])).values()];
}
