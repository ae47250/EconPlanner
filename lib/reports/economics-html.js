import { reportPlanCount } from "./economics.js";
import { studentFriendlyCourseMarker } from "../planning/plan-presentation.js";
import { feasibilityMeaning, planReadinessLabel } from "../planning/plan-display.js";
import { courseNeedsApproval, preliminaryScheduleExplanation, studentDisplayMessages, studentTermLabel } from "../planning/student-language.js";
import { runtimePolicyBundle } from "../policy/compat-normalized.js";
import { planNeedsPetition, planningRequirementsNote, replacesLegacyCatalogNotice } from "../catalog/planning-requirements-note.js";
import { summerLastResortNote } from "../planning/summer-note.js";
import { noPlanStatusLabel } from "../planning/no-plan-presentation.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function studentNameProvided(report) {
  return report.student?.nameProvided ?? Boolean(report.student?.displayName && report.student.displayName !== "Student");
}

function availabilityBadge(course = {}, sharedSeats = false) {
  if (!course.availabilityDisplayApplicable || course.fixedInProgress) return "";
  const display = course.seatStatusDisplay || { label: "Seat availability not confirmed", tone: "unverified" };
  return `<span class="availability-badge availability-${escapeHtml(display.tone)}" data-availability-state="${escapeHtml(course.availability?.status || "")}">${sharedSeats ? "" : escapeHtml(display.label)}</span>`;
}

function termCell(term, sharedSeats = false, colspan = 1, policyMessages) {
  const attributes = term.slotId ? ` data-schedule-term="${escapeHtml(term.displayTerm || term.termKey || term.term)}"${term.publicationStatus === "STUDENT_CURRENT_TERM" ? ' data-display-only-current-term="true"' : ""}` : "";
  if (!term.courses.length) return term.studyAbroad
    ? `<td${attributes} colspan="${colspan}" class="study-abroad">Study abroad</td>`
    : `<td${attributes} colspan="${colspan}" class="dash">-</td>`;
  return `<td${attributes} colspan="${colspan}">${term.courses.map(course => {
    const approval = !courseNeedsApproval(course) ? "" : course.approvalRequired?.length
      ? course.approvalRequired.map(item => `<span class="course-requirement approval-marker" data-approval-authority="${escapeHtml(item.authority || item.type)}" data-approval-prerequisite="${escapeHtml(item.prerequisite)}">${escapeHtml(studentFriendlyCourseMarker("Approval required"))}</span>`).join("")
      : `<span class="course-requirement approval-marker">${escapeHtml(studentFriendlyCourseMarker("Approval required"))}</span>`;
    const requirementId = String(course.requirementId || "").trim();
    const requirement = course.extra ? '<span class="course-requirement">Extra</span>' : "";
    const fixed = course.fixedInProgress
      ? '<span class="course-requirement">Taking now</span>'
      : "";
    const preliminary = course.preliminaryScheduleEvidence
      ? `<span class="course-requirement">${escapeHtml(preliminaryScheduleExplanation(course.preliminaryScheduleEvidence.issuedOn, policyMessages))}</span>`
      : "";
    const markers = (course.planningMarkers || []).filter(marker => marker !== "Approval required")
      .map(marker => `<span class="course-requirement approval-marker">${escapeHtml(studentFriendlyCourseMarker(marker))}</span>`).join("");
    return `<div class="course-entry"><span class="course" data-course-code="${escapeHtml(course.code)}"${course.displayOnlyCurrent ? ' data-display-only-current-course="true"' : ""}${requirementId ? ` data-requirement-id="${escapeHtml(requirementId)}"` : ""}>${escapeHtml(course.displayLabel || course.code)}${course.section ? `-${escapeHtml(course.section)}` : ""}</span><span class="cell-note" data-course-title="${escapeHtml(course.title)}"></span>${availabilityBadge(course, sharedSeats)}${approval}${markers}${requirement}${fixed}${preliminary}</div>`;
  }).join("")}</td>`;
}

function reportTermKey(term = {}) {
  const label = String(term.displayTerm || term.termKey || term.term || "").toLowerCase();
  if (label.startsWith("fall")) return "Fall";
  if (label.startsWith("winter")) return "Winter";
  if (label.startsWith("spring") || label.startsWith("may")) return "May";
  if (label === "tbc" || label.includes("term to be confirmed")) return "TBC";
  return null;
}

function yearBlock(academicYear, sourceTerms, sharedSeats, policyMessages) {
  const hasTbc = sourceTerms.some(item => reportTermKey(item) === "TBC");
  const terms = hasTbc
    ? sourceTerms.filter(item => reportTermKey(item) === "TBC")
    : ["Fall", "Winter", "May"].map(term => (
        sourceTerms.find(item => reportTermKey(item) === term) || { term, courses: [] }
      ));
  const cells = terms.map(term => termCell(term, sharedSeats, hasTbc ? 3 : 1, policyMessages)).join("");
  return `<tr data-schedule-year="${escapeHtml(academicYear)}"><th scope="row">${escapeHtml(academicYear)}</th>${cells}</tr>`;
}

function yearBlocks(report, policyMessages) {
  const grouped = new Map();
  for (const term of report.terms) {
    const academicYear = term.academicYear || report.planningHorizon;
    if (!grouped.has(academicYear)) grouped.set(academicYear, []);
    grouped.get(academicYear).push(term);
  }
  const published = report.terms.flatMap(term => term.courses).filter(course => course.availabilityDisplayApplicable && !course.fixedInProgress);
  const sharedSeats = published.length > 0 && published.every(course => !course.seatStatusDisplay || course.seatStatusDisplay.label === "Seat availability not confirmed");
  const hasSeatReminder = (report.planConditions || []).some(item => item.kind === "seat");
  const rows = [...grouped.entries()].map(([academicYear, terms]) => yearBlock(academicYear, terms, sharedSeats, policyMessages)).join("");
  const titles = [...new Map(report.terms.flatMap(term => term.courses).map(course => [course.displayLabel || course.code, course])).values()];
  return `<section class="card schedule-card" data-term-grid><h2>Your plan by term</h2><table class="schedule" aria-label="Remaining course schedule"><thead><tr><th scope="col">Year</th><th scope="col">Fall</th><th scope="col">Winter</th><th scope="col">May</th></tr></thead><tbody>${rows}</tbody></table><div class="course-titles" aria-label="Course titles">${titles.map(course => `<p><strong>${escapeHtml(course.displayLabel || course.code)}</strong> — ${escapeHtml(course.title)}${course.offeringInformation ? ` <span class="meta">${escapeHtml(course.offeringInformation.label)}</span>` : ""}${course.source === "summer-last-resort" ? `<br><span class="meta summer-term-note">${escapeHtml(summerLastResortNote())}</span>` : ""}</p>`).join("")}</div>${sharedSeats && !hasSeatReminder ? '<p class="seat-note">Seat availability not confirmed</p>' : ""}</section>`;
}

// A full-sentence checklist note gets its own line across the course and status columns; squeezed into
// the narrow status column it read as tiny (owner report 2026-11-26). Short tags ("Approval needed") stay.
// Long sentences only (more than about eight words); short ones such as "Confirm with your advisor that it counts." fit the cell.
const isChecklistSentence = marker => /[.?!]$/.test(String(marker).trim()) && String(marker).trim().length > 45;
const noteRow = row => {
  const notes = row.markers.filter(isChecklistSentence);
  return notes.length ? `<tr class="checklist-note-row" data-checklist-note-for="${escapeHtml(row.id)}"><td></td><td colspan="2">${notes.map(marker => `<span class="checklist-marker">${escapeHtml(marker)}</span>`).join("")}</td></tr>` : "";
};

function requirementTable(report) {
  const checklist = report.majorRequirementsChecklist;
  if (!checklist?.rows?.length) return "";
  const icon = status => `<span class="status-icon status-icon-${escapeHtml(status)}" aria-hidden="true"></span>`;
  const displayCourseTerm = value => String(value || "").replaceAll("ECO elective (200+)", "Economics elective (200 level or higher)");
  const rows = checklist.rows.map(row => `<tr data-requirement-checklist-id="${escapeHtml(row.id)}"><th scope="row">${escapeHtml(row.label)}</th><td>${notesText(displayCourseTerm(row.courseTerm))}</td><td><span class="checklist-status is-${escapeHtml(row.status)}">${icon(row.status)} ${row.status === "in_progress" ? "Taking now" : escapeHtml(row.statusLabel)}</span>${row.markers.filter(marker => !isChecklistSentence(marker)).map(marker => `<span class="checklist-marker">${escapeHtml(marker)}</span>`).join("")}</td></tr>${noteRow(row)}`).join("");
  const choiceLabels = { cognate: "Math choices", statistics: "Statistics choices", finance: "Finance choices" };
  const alternatives = checklist.rows.filter(row => row.alternatives.length > 1).map(row => `<span><strong>${escapeHtml(choiceLabels[row.id] || `${row.label} choices`)}:</strong> ${notesText(row.alternatives.join(" or "))}.</span>`).join(" ");
  const legend = (checklist.legend || []).map(state => `<span class="checklist-status is-${state.status}">${icon(state.status)} ${state.status === "in_progress" ? "Taking now" : escapeHtml(state.label)}</span>`).join("");
  const unmet = (checklist.unmetRequirements || []).map(row => `<li>${escapeHtml(row.label)}</li>`).join("");
  return `<section class="card checklist-section" data-major-requirements-checklist><h2>Your Economics major checklist</h2><table class="requirements" aria-label="Major requirements"><thead><tr><th scope="col">Requirement</th><th scope="col">Course / term</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table>${alternatives ? `<p class="checklist-alternatives">${alternatives}</p>` : ""}${unmet ? `<h3>Requirements still needing a class</h3><ul>${unmet}</ul>` : ""}<div class="checklist-legend" aria-label="Checklist status legend">${legend}</div><p class="checklist-note">${escapeHtml(checklist.note)}</p></section>`;
}

function planDetails(report) {
  const selectedPlan = report.selectedPlan || {};
  const planId = String(selectedPlan.id || "").trim();
  const graduationTarget = String(
    selectedPlan.planningContext?.expectedGraduationTerm || report.student?.expectedGraduationTerm || ""
  ).trim();
  const planningPace = String(
    selectedPlan.planningContext?.planningPace || report.student?.planningPace || ""
  ).trim();
  const paceLabel = {
    standard: "Standard",
    one_year_early: "One year early",
    one_year_extended: "One extra year"
  }[planningPace] || planningPace;
  const seniorStandingAcademicYear = String(
    selectedPlan.planningContext?.projectedSeniorStandingAcademicYear
      || report.student?.projectedSeniorStandingAcademicYear
      || ""
  ).trim();
  const seniorStandingBasis = String(
    selectedPlan.planningContext?.projectedSeniorStandingBasis
      || report.student?.projectedSeniorStandingBasis
      || ""
  ).trim();
  if (!planId && !graduationTarget) return "";
  // Like the screen header: a standard plan also names the one-year-early target, but only when
  // a one-year-early plan exists for this student.
  const earlyTarget = !selectedPlan.planningContext?.earlyGraduation && report.earlyGraduationTarget
    ? studentTermLabel(report.earlyGraduationTarget) : "";
  const targetText = earlyTarget && earlyTarget !== studentTermLabel(graduationTarget)
    ? `${studentTermLabel(graduationTarget)} (one year early: ${earlyTarget})` : studentTermLabel(graduationTarget);
  const details = [
    graduationTarget ? `<li><strong>Graduation target:</strong> <span data-graduation-target="${escapeHtml(graduationTarget)}">${escapeHtml(targetText)}</span></li>` : "",
    paceLabel && planningPace !== "standard" ? `<li><strong>Timeline:</strong> <span data-planning-pace="${escapeHtml(planningPace)}">${escapeHtml(paceLabel)}</span></li>` : "",
    planNeedsPetition(selectedPlan) ? "<li>See the notes below for paperwork to file.</li>" : "",
  ].filter(Boolean).join("");
  const status = planReadinessLabel(selectedPlan);
  return `<section class="year-block plan-details" data-selected-plan-id="${escapeHtml(planId)}" data-feasibility-status="${escapeHtml(selectedPlan.feasibilityStatus)}" data-planning-pace="${escapeHtml(planningPace)}" data-senior-standing-basis="${escapeHtml(seniorStandingBasis)}" data-senior-standing-academic-year="${escapeHtml(seniorStandingAcademicYear)}"><div class="year-heading"><h2>Status: ${status}</h2></div><p>${escapeHtml(feasibilityMeaning(selectedPlan.feasibilityStatus))}</p><ul>${details}</ul></section>`;
}

function noPlanSection(report) {
  if (report.selectedPlan || !report.economicsPlanResult) return "";
  const result = report.economicsPlanResult;
  const label = noPlanStatusLabel(result);
  return `<section class="year-block" data-major-completion-result="${escapeHtml(result.conclusion)}"><h2>${label}</h2>${result.evidence?.message ? `<p>${escapeHtml(result.evidence.message)}</p>` : ""}${(result.evidence?.blockingReasons || []).map(reason => `<p>${escapeHtml(reason.message)}</p>`).join("")}</section>`;
}

function acceleratedPlanningSection(report) {
  const result = report.acceleratedPlanningResult;
  if (!result?.requested) return "";
  const statusLabel = {
    POSSIBLE: "Possible",
    NOT_POSSIBLE: "Not possible",
    MORE_INFORMATION_NEEDED: "More information needed"
  }[result.status] || "More information needed";
  const targets = [
    result.standardTarget ? `<li><strong>Standard target:</strong> ${escapeHtml(result.standardTarget)}</li>` : "",
    result.acceleratedTarget ? `<li><strong>One-year-early target:</strong> ${escapeHtml(result.acceleratedTarget)}</li>` : ""
  ].filter(Boolean).join("");
  const refusalNotice = result.status === "NOT_POSSIBLE"
    ? `<p class="accelerated-refusal">You cannot finish by ${escapeHtml(result.acceleratedTarget)}. The plan below is for ${escapeHtml(result.standardTarget)}.</p>` : "";
  return `<section class="year-block" data-accelerated-planning-result="${escapeHtml(result.status)}">${refusalNotice}<div class="year-heading"><h2>${escapeHtml(result.label || "One-year-early target")}: ${escapeHtml(statusLabel)}</h2></div><p>${escapeHtml(result.message)}</p>${targets ? `<ul>${targets}</ul>` : ""}</section>`;
}

function planningNoticeSection(report) {
  const coveredNotices = new Set((report.planConditions || []).flatMap(item => item.noticeCodes || []));
  const coveredMessages = new Set((report.planConditions || []).flatMap(item => [item.message, ...(item.sourceMessages || [])]));
  const notices = (report.studentNotices || []).filter(notice => !["FUTURE_SCHEDULE_PROJECTION_NOTICE", "ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED"].includes(notice.code) && !coveredNotices.has(notice.code) && !coveredMessages.has(notice.message));
  if (!notices.length) return "";
  const items = notices.map(notice => `<li data-plan-notice-code="${escapeHtml(notice.code)}" data-advisor-attention-code="${escapeHtml(notice.code)}" data-title="${escapeHtml(notice.title)}" data-severity="${escapeHtml(notice.severity)}">${escapeHtml(notice.message)}</li>`).join("");
  return `<section class="year-block"><div class="year-heading"><h2>Planning information</h2></div><ul>${items}</ul></section>`;
}

function notesText(value, emphasizeSectionIds = false) {
  const text = escapeHtml(value).replace(/\b[A-Z]{2,5} \d{3}\b/g, code => `<strong>${code}</strong>`);
  return emphasizeSectionIds
    ? text.replace(/(— |; | or )(Section [A-Z]:)(?= )/g, "$1<strong>$2</strong>")
    : text;
}

function planNotesSection(report) {
  if (!report.planNotes?.length) return "";
  const sections = report.planNotes.map(note => `<section class="card note-card" data-plan-note="${escapeHtml(note.id)}"${note.id === "ccr-ace" ? " data-degree-requirement-information" : ""}><h2>${escapeHtml(note.title)}</h2>${note.description ? `<p>${escapeHtml(note.description)}</p>` : ""}<ul class="${note.id === "upcoming" ? "upcoming" : "history"}">${note.items.map(item => `<li${item.code ? ` data-degree-designation-code="${escapeHtml(item.code)}"` : ""}>${item.code && item.code !== "W2" ? `<strong>${escapeHtml(item.code)}</strong> ` : ""}${item.label ? `<strong class="term-heading">${escapeHtml(item.label)}</strong>: ` : ""}${item.lines ? `<div class="${note.id === "upcoming" ? "offerings" : "history-lines"}">${item.lines.map(line => `<div>${notesText(line, note.id === "upcoming")}</div>`).join("")}</div>` : notesText(item.text)}</li>`).join("")}</ul>${note.caveat ? `<p class="caveat">${escapeHtml(note.caveat)}</p>` : ""}</section>`).join("");
  const preparedDate = /^\d{4}-\d{2}-\d{2}$/.test(report.preparedDate || "")
    ? new Date(`${report.preparedDate}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })
    : report.preparedDate;
  const name = studentNameProvided(report) ? `${escapeHtml(report.student.displayName)} | ` : "";
  return `<section class="plan-notes-section" data-plan-notes><header class="notes-header"><h1>Plan Notes</h1><p class="meta">${name}${escapeHtml(report.selectedPlan?.label || "Incomplete candidate")} | Prepared ${escapeHtml(preparedDate)}</p></header>${sections}</section>`;
}

function catalogContextForReport(report) {
  const planningContext = report.selectedPlan?.planningContext || {};
  return {
    ...planningContext,
    majorDeclarationCatalogYear: planningContext.majorDeclarationCatalogYear
      || report.catalog?.catalogApplicability?.submittedDeclarationCatalogYear,
    entryCatalogYear: planningContext.entryCatalogYear
      || report.catalog?.catalogApplicability?.studentIncomingCatalogYear
  };
}

function warningSection(report) {
  const prerequisites = (report.planConditions || []).filter(item => item.kind === "prerequisite");
  const seats = (report.planConditions || []).filter(item => ["seat", "registration"].includes(item.kind));
  const other = (report.planConditions || []).filter(item => !["prerequisite", "seat", "registration"].includes(item.kind));
  const catalogContext = catalogContextForReport(report);
  const catalogYearNotices = (report.catalog?.advisorAttention || []).filter(item => item.code === "FLEXIBLE_MAJOR_REQUIREMENTS_INCOMING_YEAR_UNKNOWN"
    && !replacesLegacyCatalogNotice(catalogContext)
    && !(report.studentNotices || []).some(notice => notice.code === item.code)
    && !other.some(condition => condition.message === item.message));
  const catalogNote = planningRequirementsNote(catalogContext, report.selectedPlan);
  if (!prerequisites.length && !seats.length && !other.length && !catalogYearNotices.length && !catalogNote) return "";
  const list = items => `<ul>${items.map(item => `<li data-plan-warning>${escapeHtml(item.message)}</li>`).join("")}</ul>`;
  const catalogItem = catalogNote ? [{ message: `${catalogNote.heading} ${catalogNote.details.join(" ")}` }] : [];
  return `<section class="year-block plan-conditions" data-plan-conditions><div class="year-heading"><h2>What to check for this plan</h2></div>${prerequisites.length ? `<h3>Finish these classes first</h3>${list(prerequisites)}` : ""}${seats.length ? `<h3>Before you register</h3>${list(seats)}` : ""}${other.length || catalogYearNotices.length || catalogNote ? `<h3>Check with your advisor</h3>${list([...other, ...catalogYearNotices, ...catalogItem])}` : ""}</section>`;
}

function advisorAttentionSection(report) {
  const studentNoticeCodes = new Set((report.studentNotices || []).map(notice => notice.code));
  const coveredMessages = new Set((report.planConditions || []).flatMap(item => [item.message, ...(item.sourceMessages || [])]));
  const catalogContext = catalogContextForReport(report);
  const notices = (report.catalog?.advisorAttention || []).filter(notice => notice.code !== "FLEXIBLE_MAJOR_REQUIREMENTS_INCOMING_YEAR_UNKNOWN"
    && (!replacesLegacyCatalogNotice(catalogContext) || notice.code !== "FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE")
    && !studentNoticeCodes.has(notice.code) && !coveredMessages.has(notice.message));
  const conditions = (report.planConditions || []).filter(item => item.advisorPrompt);
  const studentItems = report.studentAdvisorContext || [];
  if (!notices.length && !conditions.length && !studentItems.length) return "";
  const studentContextItems = studentItems.map(item => `<li data-student-advisor-context>${escapeHtml(item)}</li>`).join("");
  const conditionItems = conditions.map(item => `<li data-advisor-plan-condition="${escapeHtml(item.id)}">${escapeHtml(item.advisorPrompt)}</li>`).join("");
  const noticeItems = notices.map(notice => `<li data-advisor-attention-code="${escapeHtml(notice.code)}" data-title="${escapeHtml(notice.title)}" data-severity="${escapeHtml(notice.severity)}">${escapeHtml(notice.message)}</li>`).join("");
  return `<section class="year-block" data-for-advisor><div class="year-heading"><h2>For your advisor</h2></div><ul>${studentContextItems}${conditionItems}${noticeItems}</ul></section>`;
}

export function renderEconomicsHtml(report, templateHtml) {
  const policyMessages = studentDisplayMessages(runtimePolicyBundle());
  const withoutComments = String(templateHtml).replace(/<!--[\s\S]*?-->/g, "");
  const withoutTemplate = withoutComments.replace(/<template id="year-block-template">[\s\S]*?<\/template>/i, "");
  const replacements = {
    "{{STUDENT_NAME_PREFIX}}": studentNameProvided(report) ? `<strong>${escapeHtml(report.student.displayName)}</strong> | ` : "",
    "{{PLAN_STRATEGY_LABEL}}": report.selectedPlan?.label || "Incomplete candidate",
    "{{PLANNING_HORIZON}}": report.planningHorizon,
    "{{PREPARED_DATE}}": /^\d{4}-\d{2}-\d{2}$/.test(report.preparedDate || "")
      ? new Date(`${report.preparedDate}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })
      : report.preparedDate,
    "{{INPUT_SUMMARY}}": report.inputSummary,
    "{{REMAINING_YEAR_COUNT}}": report.selectedPlan?.planningContext?.remainingYears || "Advisor check",
    "{{PLANNED_COURSE_COUNT}}": reportPlanCount(report),
    "{{ECO461_TARGET_TERM}}": report.terms.find(term => term.courses.some(course => course.code === "ECO 461"))?.term || "Advisor check",
    "{{YEAR_BLOCKS_HTML}}": `${yearBlocks(report, policyMessages)}${warningSection(report)}${advisorAttentionSection(report)}${planningNoticeSection(report)}${noPlanSection(report)}${acceleratedPlanningSection(report)}${requirementTable(report)}`,
    "{{PLAN_NOTES_HTML}}": planNotesSection(report),
    "{{PLAN_DETAILS_HTML}}": planDetails(report),
    "{{STANDING}}": report.student.classStandingSummary || report.student.academicStanding,
    "{{STUDY_ABROAD_SUMMARY}}": report.student.studyAbroadLabel ? ` | Study abroad: ${report.student.studyAbroadLabel}` : ""
  };
  const html = withoutTemplate.replace(/\{\{[A-Z_]+\}\}/g, token => {
    const value = replacements[token] ?? "";
    return ["{{YEAR_BLOCKS_HTML}}", "{{PLAN_DETAILS_HTML}}", "{{PLAN_NOTES_HTML}}", "{{STUDENT_NAME_PREFIX}}"].includes(token) ? value : escapeHtml(value);
  });
  // Students read "May", never "Spring/May". Only visible text changes; attributes keep the stored term names.
  return html.replace(/>([^<]*)</g, (match, text) => text.includes("Spring/May") ? `>${text.replaceAll("Spring/May", "May")}<` : match);
}
