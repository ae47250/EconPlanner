import { reportPlanCount } from "./economics.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function display(value) {
  return value == null || value === "" ? "Advisor check" : escapeHtml(value);
}

function termCell(term) {
  if (!term.courses.length) return `<td class="dash">-</td>`;
  return `<td>${term.courses.map(course => `<span class="course">${escapeHtml(course.code)}${course.section ? `-${escapeHtml(course.section)}` : ""}</span><span class="cell-note">${escapeHtml(course.title)}</span>`).join("<br>")}</td>`;
}

function yearBlock(report) {
  const terms = ["Fall", "Winter", "May"].map(term => report.terms.find(item => item.term === term) || { term, courses: [] });
  const headers = terms.map(term => `<th>${escapeHtml(term.term)}</th>`).join("");
  const cells = terms.map(termCell).join("");
  return `<section class="year-block"><div class="year-heading"><h2>Economics schedule <span>- ${escapeHtml(report.planningHorizon)}</span></h2></div><div class="table-wrap"><table><thead><tr>${headers}</tr></thead><tbody><tr>${cells}</tr></tbody></table></div><p class="verified-line">Verified offerings are based on the supplied 2026/2027 schedule. S sections are displayed as May Term.</p></section>`;
}

function requirementTable(report) {
  const rows = report.requirements.map(requirement => `<tr><td>${escapeHtml(requirement.label)}</td><td>${display(requirement.strict)}</td><td>${display(requirement.optimistic)}</td><td>${display(requirement.projected)}</td><td>${display(requirement.evidence)}</td></tr>`).join("");
  return `<section class="year-block"><div class="year-heading"><h2>Requirement assignments</h2></div><div class="table-wrap"><table><thead><tr><th>Requirement</th><th>Strict</th><th>Optimistic</th><th>In progress</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function checks(report) {
  if (!report.unresolved.length && !report.advisorChecks.length) return "";
  const items = [
    ...report.unresolved.map(item => `${item.label || item.requirementId}: ${item.reason || "Remaining"}`),
    ...report.advisorChecks.map(item => `${item.course || "Advisor check"}: ${item.reason}`)
  ].map(item => `<li>${escapeHtml(item)}</li>`).join("");
  return `<section class="year-block"><div class="year-heading"><h2>Advisor checks</h2></div><ul>${items}</ul></section>`;
}

export function renderEconomicsHtml(report, templateHtml) {
  const withoutComments = String(templateHtml).replace(/<!--[\s\S]*?-->/g, "");
  const withoutTemplate = withoutComments.replace(/<template id="year-block-template">[\s\S]*?<\/template>/i, "");
  const replacements = {
    "{{STUDENT_NAME}}": report.student.displayName,
    "{{PLANNING_HORIZON}}": report.planningHorizon,
    "{{PREPARED_DATE}}": report.preparedDate,
    "{{INPUT_SUMMARY}}": report.inputSummary,
    "{{REMAINING_YEAR_COUNT}}": "1",
    "{{PLANNED_COURSE_COUNT}}": reportPlanCount(report),
    "{{ECO461_TARGET_TERM}}": report.terms.find(term => term.courses.some(course => course.code === "ECO 461"))?.term || "Advisor check",
    "{{YEAR_BLOCKS_HTML}}": `${yearBlock(report)}${requirementTable(report)}${checks(report)}`
  };
  return Object.entries(replacements).reduce((html, [token, value]) => {
    return html.replaceAll(token, token === "{{YEAR_BLOCKS_HTML}}" ? value : escapeHtml(value));
  }, withoutTemplate);
}
