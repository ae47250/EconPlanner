function text(value) {
  return String(value ?? "").trim();
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function decodeHtml(value) {
  return text(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function termRole(term = {}) {
  const label = text(term.displayTerm || term.termKey || term.term).toLowerCase();
  if (label.startsWith("fall")) return "Fall";
  if (label.startsWith("winter")) return "Winter";
  if (label.startsWith("spring") || label.startsWith("may")) return "Spring/May";
  if (label.startsWith("summer")) return "Summer";
  return text(term.displayTerm || term.termKey || term.term) || null;
}

function normalizedApproval(approval = {}, course = {}, term = {}) {
  return {
    authority: text(approval.authority || approval.type) || null,
    course: text(approval.course || course.course || course.code) || null,
    prerequisite: text(approval.prerequisite) || null,
    term: termRole(term)
  };
}

function normalizedCourse(course = {}, term = {}) {
  return {
    code: text(course.course || course.code) || null,
    section: text(course.section) || null,
    title: text(course.title) || null,
    requirementRole: text(course.requirementId || course.requirementRole) || null,
    extra: course.extra === true,
    approvals: (course.approvalRequired || [])
      .map(approval => normalizedApproval(approval, course, term))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    availabilityState: text(course.availability?.status || course.availability?.state) || null,
    courseGuidance: null
  };
}

function normalizedTerms(terms = []) {
  return terms.map(term => ({
    academicYear: text(term.academicYear) || null,
    term: termRole(term),
    courses: (term.courses || []).map(course => normalizedCourse(course, term))
  }));
}

function selectedPlanWarnings(plan = {}) {
  if (Array.isArray(plan.planConditions)) return uniqueSorted(plan.planConditions.map(item => item.message));
  if (Array.isArray(plan.displayWarnings)) return uniqueSorted(plan.displayWarnings);
  const noticeMessages = new Set((plan.studentNotices || []).map(notice => text(notice.message)));
  return uniqueSorted([
    ...(plan.warnings || []),
    ...(plan.studentMessages || []),
    ...(plan.feasibility?.warnings || [])
  ].map(text).filter(message => !noticeMessages.has(message) && !/projected placement/i.test(message)));
}

function advisorAttention(report = {}) {
  const coveredNotices = new Set((report.selectedPlan?.planConditions || []).flatMap(item => item.noticeCodes || []));
  const coveredMessages = new Set((report.selectedPlan?.planConditions || []).flatMap(item => [item.message, ...(item.sourceMessages || [])]));
  return (report.catalog?.advisorAttention || []).filter(notice => !["FUTURE_SCHEDULE_PROJECTION_NOTICE", "ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED"].includes(notice.code) && !coveredNotices.has(notice.code) && !coveredMessages.has(notice.message)).map(notice => ({
    code: text(notice.code) || null,
    title: text(notice.title) || null,
    severity: text(notice.severity) || null,
    message: text(notice.message) || null
  }));
}

export function projectSelectedPlanArtifact(selectedPlan, { advisorNotices = [] } = {}) {
  const coveredNotices = new Set((selectedPlan?.planConditions || []).flatMap(item => item.noticeCodes || []));
  const coveredMessages = new Set((selectedPlan?.planConditions || []).flatMap(item => [item.message, ...(item.sourceMessages || [])]));
  return {
    selectedPlanId: text(selectedPlan?.id) || null,
    graduationTarget: text(selectedPlan?.planningContext?.expectedGraduationTerm) || null,
    planningPace: text(selectedPlan?.planningContext?.planningPace) || null,
    projectedSeniorStandingAcademicYear: text(selectedPlan?.planningContext?.projectedSeniorStandingAcademicYear) || null,
    projectedSeniorStandingBasis: text(selectedPlan?.planningContext?.projectedSeniorStandingBasis) || null,
    feasibilityStatus: text(selectedPlan?.feasibilityStatus) || null,
    terms: normalizedTerms(selectedPlan?.terms || []),
    warnings: selectedPlanWarnings(selectedPlan),
    advisorAttention: advisorNotices.filter(notice => !["FUTURE_SCHEDULE_PROJECTION_NOTICE", "ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED"].includes(notice.code) && !coveredNotices.has(notice.code) && !coveredMessages.has(notice.message)).map(notice => ({
      code: text(notice.code) || null,
      title: text(notice.title) || null,
      severity: text(notice.severity) || null,
      message: text(notice.message) || null
    }))
  };
}

export function projectReportJsonArtifact(report) {
  return {
    selectedPlanId: text(report?.selectedPlan?.id) || null,
    graduationTarget: text(report?.student?.expectedGraduationTerm) || null,
    planningPace: text(report?.student?.planningPace) || null,
    projectedSeniorStandingAcademicYear: text(report?.student?.projectedSeniorStandingAcademicYear) || null,
    projectedSeniorStandingBasis: text(report?.student?.projectedSeniorStandingBasis) || null,
    feasibilityStatus: text(report?.selectedPlan?.feasibilityStatus) || null,
    terms: normalizedTerms(report?.terms || []),
    warnings: selectedPlanWarnings(report?.selectedPlan),
    advisorAttention: advisorAttention(report)
  };
}

function attributeValue(attributes, name) {
  const match = String(attributes || "").match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match ? decodeHtml(match[1]) : null;
}

function htmlScheduleTerms(html) {
  const terms = [];
  // Read the portrait grid independently from its semantic row/cell metadata.
  const gridRows = [...String(html || "").matchAll(/<tr data-schedule-year="([^"]+)">([\s\S]*?)<\/tr>/gi)];
  if (gridRows.length) {
    const legacyBlocks = gridRows.flatMap(row => [...row[2].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)]
      .filter(cell => attributeValue(cell[1], "data-schedule-term"))
      .map(cell => `<section class="year-block"><div class="year-heading"><h2>Economics schedule <span>- ${row[1]}</span></h2></div><div class="table-wrap"><table><thead><tr><th>${attributeValue(cell[1], "data-schedule-term")}</th></tr></thead><tbody><tr><td>${cell[2]}</td></tr>`)).join("");
    return htmlScheduleTerms(legacyBlocks);
  }
  const blockPattern = /<section class="year-block"><div class="year-heading"><h2>Economics schedule <span>- ([^<]+)<\/span><\/h2><\/div><div class="table-wrap"><table><thead><tr>([\s\S]*?)<\/tr><\/thead><tbody><tr>([\s\S]*?)<\/tr>/gi;
  for (const block of String(html || "").matchAll(blockPattern)) {
    const academicYear = decodeHtml(block[1]);
    const headings = [...block[2].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(match => termRole({ term: decodeHtml(match[1]) }));
    const cells = [...block[3].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
    for (let index = 0; index < headings.length; index += 1) {
      const courses = [];
      const coursePattern = /<span class="course"([^>]*)>([\s\S]*?)<\/span><span class="cell-note"([^>]*)>([\s\S]*?)<\/span>(?:<span class="availability-badge[^\"]*"([^>]*)>([\s\S]*?)<\/span>)?/gi;
      const cell = String(cells[index] || "");
      const courseEntries = [...cell.matchAll(coursePattern)];
      for (let entryIndex = 0; entryIndex < courseEntries.length; entryIndex += 1) {
        const entry = courseEntries[entryIndex];
        const label = decodeHtml(entry[2]);
        const identity = label.match(/^([A-Z]{2,5}\s+\d{3})(?:-([^\s]+))?$/);
        const note = decodeHtml(entry[4]);
        const suffix = cell.slice(entry.index + entry[0].length, courseEntries[entryIndex + 1]?.index ?? cell.length);
        const guidance = suffix.match(/<span class="course-requirement" data-course-guidance>([\s\S]*?)<\/span>/i);
        const availability = decodeHtml(entry[6] || "").match(/\b(open|full)\b/i)
          || note.match(/ - (open|full|closed|waitlisted|unknown)(?:\s|\(|$)/i);
        const approval = note.match(/ - ([^-]+?) approval for concurrent ([A-Z]{2,5}\s+\d{3})/i);
        const markers = [...suffix.matchAll(/<span[^>]+data-approval-authority="([^"]*)"[^>]+data-approval-prerequisite="([^"]*)"[^>]*>(?:Approval required|Advisor approval needed)<\/span>/gi)];
        const title = attributeValue(entry[3], "data-course-title") || note.split(/ - (?:open|full|closed|waitlisted|unknown)(?:\s|\(|$)| - [^-]+? approval for concurrent /i)[0].trim();
        courses.push({
          code: identity?.[1] || label.replace(/ \(200\+\)$/, "") || null,
          section: identity?.[2] || null,
          title: title || null,
          requirementRole: attributeValue(entry[1], "data-requirement-id") || attributeValue(entry[3], "data-requirement-id"),
          extra: /<span class="course-requirement">Extra<\/span>/.test(suffix),
          approvals: markers.length ? markers.map(marker => ({
            authority: decodeHtml(marker[1]), course: identity?.[1] || label || null,
            prerequisite: decodeHtml(marker[2]), term: headings[index]
          })) : approval ? [{
            authority: approval[1].trim(),
            course: identity?.[1] || label || null,
            prerequisite: approval[2],
            term: headings[index]
          }] : [],
          availabilityState: attributeValue(entry[5], "data-availability-state") || availability?.[1]?.toLowerCase() || null,
          courseGuidance: guidance ? decodeHtml(guidance[1]) : null
        });
      }
      terms.push({ academicYear, term: headings[index], courses });
    }
  }
  return terms;
}

function htmlWarnings(html) {
  return [...String(html || "").matchAll(/data-plan-warning(?:="[^"]*")?[^>]*>([\s\S]*?)<\//gi)]
    .map(match => decodeHtml(match[1]))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function htmlAdvisorAttention(html) {
  return [...String(html || "").matchAll(/<[^>]+data-advisor-attention-code="([^"]+)"([^>]*)>([\s\S]*?)<\/[^>]+>/gi)]
    .map(match => ({
      code: decodeHtml(match[1]),
      title: attributeValue(match[2], "data-title"),
      severity: attributeValue(match[2], "data-severity"),
      message: decodeHtml(match[3])
    }));
}

export function projectReportHtmlArtifact(html) {
  const source = String(html || "");
  const selectedPlanId = source.match(/data-selected-plan-id="([^"]+)"/i);
  const graduation = source.match(/data-graduation-target="([^"]+)"/i)
    || source.match(/Expected graduation(?: target)?:?\s*(Spring\/May\s+\d{4})/i);
  const status = decodeHtml(source).match(/Plan status:\s*([A-Z_ ]+?)\./i);
  const statusAttribute = source.match(/data-feasibility-status="([^"]+)"/i);
  const planningPace = source.match(/data-planning-pace="([^"]+)"/i);
  const seniorStandingAcademicYear = source.match(/data-senior-standing-academic-year="([^"]+)"/i);
  const seniorStandingBasis = source.match(/data-senior-standing-basis="([^"]+)"/i);
  return {
    selectedPlanId: selectedPlanId ? decodeHtml(selectedPlanId[1]) : null,
    graduationTarget: graduation ? decodeHtml(graduation[1]) : null,
    planningPace: planningPace ? decodeHtml(planningPace[1]) : null,
    projectedSeniorStandingAcademicYear: seniorStandingAcademicYear ? decodeHtml(seniorStandingAcademicYear[1]) : null,
    projectedSeniorStandingBasis: seniorStandingBasis ? decodeHtml(seniorStandingBasis[1]) : null,
    feasibilityStatus: statusAttribute ? decodeHtml(statusAttribute[1]) : status ? status[1].trim().toUpperCase().replaceAll(" ", "_") : null,
    terms: htmlScheduleTerms(source),
    warnings: htmlWarnings(source),
    advisorAttention: htmlAdvisorAttention(source)
  };
}

export function projectPdfCreatorRequestArtifact(requestBody) {
  return projectReportHtmlArtifact(requestBody?.html || "");
}

export function courseOccurrences(projection, courseCode) {
  return projection.terms.reduce((count, term) => (
    count + term.courses.filter(course => course.code === courseCode).length
  ), 0);
}

export function economics257Roles(projection) {
  return projection.terms.flatMap(term => term.courses)
    .filter(course => course.code === "ECO 257")
    .map(course => course.requirementRole);
}

export function projectionMetrics(projection) {
  const terms = projection?.terms || [];
  const courses = terms.flatMap(term => term.courses || []);
  return {
    selectedPlanId: projection?.selectedPlanId || null,
    termCount: terms.length,
    courseCount: courses.length,
    warningCount: projection?.warnings?.length || 0,
    approvalCount: courses.reduce((sum, course) => sum + (course.approvals?.length || 0), 0),
    advisorAttentionCount: projection?.advisorAttention?.length || 0,
    availabilityStateCounts: courses.reduce((counts, course) => {
      const state = course.availabilityState || "not_reported";
      counts[state] = (counts[state] || 0) + 1;
      return counts;
    }, {})
  };
}

export function projectionMismatches(expected, actual, path = "artifact") {
  if (Object.is(expected, actual)) return [];
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return [{ path, expected, actual }];
    }
    const mismatches = [];
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      mismatches.push(...projectionMismatches(expected[index], actual[index], `${path}[${index}]`));
    }
    return mismatches;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    return uniqueSorted([...Object.keys(expected), ...Object.keys(actual)])
      .flatMap(key => projectionMismatches(expected[key], actual[key], `${path}.${key}`));
  }
  return [{ path, expected: expected ?? null, actual: actual ?? null }];
}
