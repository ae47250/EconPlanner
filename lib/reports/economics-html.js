import { reportPlanCount } from "./economics.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function availabilityBadge(course = {}, sharedSeats = false) {
  if (!course.availabilityDisplayApplicable) return "";
  const display = course.seatStatusDisplay || { label: "Current seat status unverified", tone: "unverified" };
  return `<span class="availability-badge availability-${escapeHtml(display.tone)}" data-availability-state="${escapeHtml(course.availability?.status || "")}">${sharedSeats ? "" : escapeHtml(display.label)}</span>`;
}

function termCell(term, sharedSeats = false, colspan = 1) {
  const attributes = term.slotId ? ` data-schedule-term="${escapeHtml(term.displayTerm || term.termKey || term.term)}"` : "";
  if (!term.courses.length) return `<td${attributes} colspan="${colspan}" class="dash">-</td>`;
  return `<td${attributes} colspan="${colspan}">${term.courses.map(course => {
    const approval = course.approvalRequired?.length
      ? course.approvalRequired.map(item => `<span class="course-requirement approval-marker" data-approval-authority="${escapeHtml(item.authority || item.type)}" data-approval-prerequisite="${escapeHtml(item.prerequisite)}">Approval required</span>`).join("")
      : "";
    const requirementId = String(course.requirementId || "").trim();
    const requirement = "";
    const fixed = course.fixedInProgress
      ? '<span class="course-requirement">Taking now - fixed in this term</span>'
      : "";
    const preliminary = course.preliminaryScheduleEvidence
      ? `<span class="course-requirement">Preliminary schedule (${escapeHtml(course.preliminaryScheduleEvidence.issuedOn)}); course and term subject to change</span>`
      : "";
    const markers = (course.planningMarkers || []).filter(marker => marker !== "Approval required" || !course.approvalRequired?.length)
      .map(marker => `<span class="course-requirement approval-marker">${escapeHtml(marker)}</span>`).join("");
    return `<div class="course-entry"><span class="course"${requirementId ? ` data-requirement-id="${escapeHtml(requirementId)}"` : ""}>${escapeHtml(course.displayLabel || course.code)}${course.section ? `-${escapeHtml(course.section)}` : ""}</span><span class="cell-note" data-course-title="${escapeHtml(course.title)}"></span>${availabilityBadge(course, sharedSeats)}${approval}${markers}${requirement}${fixed}${preliminary}</div>`;
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

function yearBlock(academicYear, sourceTerms, sharedSeats) {
  const hasTbc = sourceTerms.some(item => reportTermKey(item) === "TBC");
  const terms = hasTbc
    ? sourceTerms.filter(item => reportTermKey(item) === "TBC")
    : ["Fall", "Winter", "May"].map(term => (
        sourceTerms.find(item => reportTermKey(item) === term) || { term, courses: [] }
      ));
  const cells = terms.map(term => termCell(term, sharedSeats, hasTbc ? 3 : 1)).join("");
  return `<tr data-schedule-year="${escapeHtml(academicYear)}"><th scope="row">${escapeHtml(academicYear)}</th>${cells}</tr>`;
}

function yearBlocks(report) {
  const grouped = new Map();
  for (const term of report.terms) {
    const academicYear = term.academicYear || report.planningHorizon;
    if (!grouped.has(academicYear)) grouped.set(academicYear, []);
    grouped.get(academicYear).push(term);
  }
  const published = report.terms.flatMap(term => term.courses).filter(course => course.availabilityDisplayApplicable);
  const sharedSeats = published.length > 0 && published.every(course => !course.seatStatusDisplay || course.seatStatusDisplay.label === "Current seat status unverified");
  const rows = [...grouped.entries()].map(([academicYear, terms]) => yearBlock(academicYear, terms, sharedSeats)).join("");
  const titles = [...new Map(report.terms.flatMap(term => term.courses).map(course => [course.displayLabel || course.code, course])).values()];
  return `<section class="card schedule-card" data-term-grid><h2>Remaining years at a glance</h2><table class="schedule" aria-label="Remaining course schedule"><thead><tr><th scope="col">Year</th><th scope="col">Fall</th><th scope="col">Winter</th><th scope="col">May</th></tr></thead><tbody>${rows}</tbody></table><div class="course-titles" aria-label="Course titles">${titles.map(course => `<p><strong>${escapeHtml(course.displayLabel || course.code)}</strong> — ${escapeHtml(course.title)}</p>`).join("")}</div>${sharedSeats ? '<p class="seat-note">Current seat status unverified</p>' : ""}</section>`;
}

function requirementTable(report) {
  const checklist = report.majorRequirementsChecklist;
  if (!checklist?.rows?.length) return "";
  const rows = checklist.rows.filter(row => row.status !== "still_needed").map(row => `<tr data-requirement-checklist-id="${escapeHtml(row.id)}"><th scope="row">${escapeHtml(row.label)}</th><td>${notesText(row.courseTerm)}</td><td><span class="checklist-status is-${escapeHtml(row.status)}"><span class="status-icon" aria-hidden="true">${row.symbol}</span> ${escapeHtml(row.statusLabel)}</span>${row.markers.map(marker => `<span class="checklist-marker">${escapeHtml(marker)}</span>`).join("")}</td></tr>`).join("");
  const alternatives = checklist.rows.filter(row => row.alternatives.length > 1).map(row => `<span><strong>${escapeHtml(row.label)} options:</strong> ${notesText(row.alternatives.join(" / "))}</span>`).join(" · ");
  const unmet = checklist.rows.filter(row => row.status === "still_needed");
  const gaps = unmet.length ? `<div class="incomplete-candidate" data-incomplete-candidate><h3>Incomplete candidate — unmet requirements</h3><p>No qualifying assignment is recorded for the requirements below. This alone does not establish that no viable plan exists.</p><ul>${unmet.map(row => `<li><strong>${escapeHtml(row.label)}</strong>: ${notesText(row.courseTerm)}${row.markers.length ? `; ${escapeHtml(row.markers.join("; "))}` : ""}</li>`).join("")}</ul></div>` : "";
  const legend = (checklist.legend || []).map(state => `<span class="checklist-status is-${state.status}"><span aria-hidden="true">${state.symbol}</span> ${state.label}</span>`).join("");
  return `<section class="card checklist-section" data-major-requirements-checklist><h2>${escapeHtml(checklist.title)}</h2><table class="requirements" aria-label="Major requirements"><thead><tr><th scope="col">Requirement</th><th scope="col">Course / term</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table>${gaps}${alternatives ? `<p class="checklist-alternatives">${alternatives}</p>` : ""}<div class="checklist-legend" aria-label="Checklist status legend">${legend}</div><p class="checklist-note">${escapeHtml(checklist.note)}</p></section>`;
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
    standard: "Standard pace",
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
  const details = [
    graduationTarget ? `<li><strong>Expected graduation:</strong> <span data-graduation-target="${escapeHtml(graduationTarget)}">${escapeHtml(graduationTarget)}</span></li>` : "",
    paceLabel ? `<li><strong>Planning pace:</strong> <span data-planning-pace="${escapeHtml(planningPace)}">${escapeHtml(paceLabel)}</span></li>` : "",
  ].filter(Boolean).join("");
  const status = { VERIFIED_FEASIBLE: "Verified feasible", CONDITIONALLY_FEASIBLE: "Conditional plan", PRELIMINARY_ONLY: "Preliminary plan", SEARCH_INCOMPLETE: "More information needed", NOT_FEASIBLE: "Plan needs attention" }[selectedPlan.feasibilityStatus] || "Plan needs confirmation";
  return `<section class="year-block plan-details" data-selected-plan-id="${escapeHtml(planId)}" data-feasibility-status="${escapeHtml(selectedPlan.feasibilityStatus)}" data-senior-standing-basis="${escapeHtml(seniorStandingBasis)}" data-senior-standing-academic-year="${escapeHtml(seniorStandingAcademicYear)}"><div class="year-heading"><h2>${status}</h2></div><ul>${details}</ul></section>`;
}

function noPlanSection(report) {
  if (report.selectedPlan || !report.economicsPlanResult) return "";
  const result = report.economicsPlanResult;
  const label = result.conclusion === "PROVEN_INFEASIBLE" ? "Not possible" : "More information needed";
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
    result.acceleratedTarget ? `<li><strong>Accelerated target:</strong> ${escapeHtml(result.acceleratedTarget)}</li>` : ""
  ].filter(Boolean).join("");
  return `<section class="year-block" data-accelerated-planning-result="${escapeHtml(result.status)}"><div class="year-heading"><h2>${escapeHtml(result.label || "Accelerated graduation")}: ${escapeHtml(statusLabel)}</h2></div><p>${escapeHtml(result.message)}</p>${targets ? `<ul>${targets}</ul>` : ""}</section>`;
}

function planningNoticeSection(report) {
  const coveredNotices = new Set((report.planConditions || []).flatMap(item => item.noticeCodes || []));
  const coveredMessages = new Set((report.planConditions || []).flatMap(item => [item.message, ...(item.sourceMessages || [])]));
  const notices = (report.studentNotices || []).filter(notice => !["FUTURE_SCHEDULE_PROJECTION_NOTICE", "ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED"].includes(notice.code) && !coveredNotices.has(notice.code) && !coveredMessages.has(notice.message));
  if (!notices.length) return "";
  const items = notices.map(notice => `<li data-plan-notice-code="${escapeHtml(notice.code)}" data-advisor-attention-code="${escapeHtml(notice.code)}" data-title="${escapeHtml(notice.title)}" data-severity="${escapeHtml(notice.severity)}">${escapeHtml(notice.message)}</li>`).join("");
  return `<section class="year-block"><div class="year-heading"><h2>Planning information</h2></div><ul>${items}</ul></section>`;
}

function notesText(value) {
  return escapeHtml(value).replace(/\b[A-Z]{2,5} \d{3}\b/g, code => `<strong>${code}</strong>`);
}

function planNotesSection(report) {
  if (!report.planNotes?.length) return "";
  const sections = report.planNotes.map(note => `<section class="card note-card" data-plan-note="${escapeHtml(note.id)}"${note.id === "ccr-ace" ? " data-degree-requirement-information" : ""}><h2>${escapeHtml(note.title)}</h2>${note.description ? `<p>${escapeHtml(note.description)}</p>` : ""}<ul class="${note.id === "upcoming" ? "upcoming" : "history"}">${note.items.map(item => `<li${item.code ? ` data-degree-designation-code="${escapeHtml(item.code)}"` : ""}>${item.code ? `<strong>${escapeHtml(item.code)}</strong> ` : ""}${item.label ? `<strong class="term-heading">${escapeHtml(item.label)}</strong>: ` : ""}${item.lines ? `<div class="${note.id === "upcoming" ? "offerings" : "history-lines"}">${item.lines.map(line => `<div>${notesText(line)}</div>`).join("")}</div>` : notesText(item.text)}</li>`).join("")}</ul>${note.caveat ? `<p class="caveat">${escapeHtml(note.caveat)}</p>` : ""}</section>`).join("");
  return `<section class="plan-notes-section" data-plan-notes><header class="notes-header"><h1>Plan Notes</h1><p class="meta">${escapeHtml(report.student.displayName)} | ${escapeHtml(report.selectedPlan?.label || "Incomplete candidate")} | ${escapeHtml(report.preparedDate)}</p></header>${sections}</section>`;
}

function warningSection(report) {
  if (!report.planConditions?.length) return "";
  return `<section class="year-block plan-conditions" data-plan-conditions><div class="year-heading"><h2>Actions and conditions</h2></div><ul>${report.planConditions.map(item => `<li data-plan-warning>${escapeHtml(item.message)}</li>`).join("")}</ul></section>`;
}

function advisorAttentionSection(report) {
  const studentNoticeCodes = new Set((report.studentNotices || []).map(notice => notice.code));
  const coveredMessages = new Set((report.planConditions || []).flatMap(item => [item.message, ...(item.sourceMessages || [])]));
  const notices = (report.catalog?.advisorAttention || []).filter(notice => !studentNoticeCodes.has(notice.code) && !coveredMessages.has(notice.message));
  if (!notices.length) return "";
  const items = notices.map(notice => `<li data-advisor-attention-code="${escapeHtml(notice.code)}" data-title="${escapeHtml(notice.title)}" data-severity="${escapeHtml(notice.severity)}">${escapeHtml(notice.message)}</li>`).join("");
  return `<section class="year-block"><div class="year-heading"><h2>Advisor attention</h2></div><ul>${items}</ul></section>`;
}

export function renderEconomicsHtml(report, templateHtml) {
  const withoutComments = String(templateHtml).replace(/<!--[\s\S]*?-->/g, "");
  const withoutTemplate = withoutComments.replace(/<template id="year-block-template">[\s\S]*?<\/template>/i, "");
  const replacements = {
    "{{STUDENT_NAME}}": report.student.displayName,
    "{{PLAN_STRATEGY_LABEL}}": report.selectedPlan?.label || "Incomplete candidate",
    "{{PLANNING_HORIZON}}": report.planningHorizon,
    "{{PREPARED_DATE}}": report.preparedDate,
    "{{INPUT_SUMMARY}}": report.inputSummary,
    "{{REMAINING_YEAR_COUNT}}": report.selectedPlan?.planningContext?.remainingYears || "Advisor check",
    "{{PLANNED_COURSE_COUNT}}": reportPlanCount(report),
    "{{ECO461_TARGET_TERM}}": report.terms.find(term => term.courses.some(course => course.code === "ECO 461"))?.term || "Advisor check",
    "{{YEAR_BLOCKS_HTML}}": `${yearBlocks(report)}${warningSection(report)}${planningNoticeSection(report)}${advisorAttentionSection(report)}${noPlanSection(report)}${acceleratedPlanningSection(report)}${requirementTable(report)}`,
    "{{PLAN_NOTES_HTML}}": planNotesSection(report),
    "{{PLAN_DETAILS_HTML}}": planDetails(report),
    "{{STANDING}}": report.student.academicStanding
  };
  return withoutTemplate.replace(/\{\{[A-Z_]+\}\}/g, token => {
    const value = replacements[token] ?? "";
    return ["{{YEAR_BLOCKS_HTML}}", "{{PLAN_DETAILS_HTML}}", "{{PLAN_NOTES_HTML}}"].includes(token) ? value : escapeHtml(value);
  });
}
