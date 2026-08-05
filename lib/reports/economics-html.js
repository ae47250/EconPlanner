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

function requirementLabel(requirementId) {
  const value = String(requirementId || "").trim();
  if (!value) return "Requirement";
  if (value === "statistics") return "Statistics requirement";
  if (value === "finance") return "Finance requirement";
  if (value.startsWith("eco-elective")) return "ECO elective";
  if (value.startsWith("supporting-elective")) return "Supporting-course elective";
  const course = value.match(/^([a-z]+)-(\d{3})$/i);
  return course ? `${course[1].toUpperCase()} ${course[2]} requirement` : `${value.replaceAll("-", " ")} requirement`;
}

function termCell(term) {
  if (!term.courses.length) return `<td class="dash">-</td>`;
  return `<td>${term.courses.map(course => {
    const availability = course.availability?.status
      ? ` - ${course.availability.status}${Number.isFinite(course.availability.seatsOpen) ? ` (${course.availability.seatsOpen} seats open)` : ""}`
      : "";
    const approval = course.approvalRequired?.length
      ? ` - ${course.approvalRequired.map(item => `${item.authority || item.type} approval for concurrent ${item.prerequisite}`).join("; ")}`
      : "";
    const requirementId = String(course.requirementId || "").trim();
    const requirement = requirementId
      ? `<span class="course-requirement">Requirement: ${escapeHtml(requirementLabel(requirementId))}</span>`
      : "";
    return `<span class="course"${requirementId ? ` data-requirement-id="${escapeHtml(requirementId)}"` : ""}>${escapeHtml(course.code)}${course.section ? `-${escapeHtml(course.section)}` : ""}</span><span class="cell-note">${escapeHtml(`${course.title}${availability}${approval}`)}</span>${requirement}`;
  }).join("<br>")}</td>`;
}

function reportTermKey(term = {}) {
  const label = String(term.displayTerm || term.termKey || term.term || "").toLowerCase();
  if (label.startsWith("fall")) return "Fall";
  if (label.startsWith("winter")) return "Winter";
  if (label.startsWith("spring") || label.startsWith("may")) return "May";
  return null;
}

function yearBlock(academicYear, sourceTerms) {
  const terms = ["Fall", "Winter", "May"].map(term => (
    sourceTerms.find(item => reportTermKey(item) === term) || { term, courses: [] }
  ));
  const headers = terms.map(term => `<th>${escapeHtml(term.term)}</th>`).join("");
  const cells = terms.map(termCell).join("");
  return `<section class="year-block"><div class="year-heading"><h2>Economics schedule <span>- ${escapeHtml(academicYear)}</span></h2></div><div class="table-wrap"><table><thead><tr>${headers}</tr></thead><tbody><tr>${cells}</tr></tbody></table></div></section>`;
}

function yearBlocks(report) {
  const grouped = new Map();
  for (const term of report.terms) {
    const academicYear = term.academicYear || report.planningHorizon;
    if (!grouped.has(academicYear)) grouped.set(academicYear, []);
    grouped.get(academicYear).push(term);
  }
  const blocks = [...grouped.entries()].map(([academicYear, terms]) => yearBlock(academicYear, terms)).join("");
  const status = report.selectedPlan?.feasibilityStatus
    ? `<p class="verified-line">Plan status: ${escapeHtml(report.selectedPlan.feasibilityStatus.replaceAll("_", " "))}. Verified offerings use the supplied 2026/2027 schedule; future terms remain preliminary until published.</p>`
    : "";
  const feasibility = report.selectedPlan?.feasibility;
  const conditions = feasibility ? `<section class="year-block"><div class="year-heading"><h2>Verification and conditions</h2></div><ul>
    <li>Offerings: ${escapeHtml(feasibility.verification?.offerings || "unknown")}</li>
    <li>Meeting times: ${escapeHtml(feasibility.verification?.meetings || "unknown")}</li>
    <li>Availability: ${escapeHtml(feasibility.verification?.availability || "unknown")}</li>
    ${(feasibility.requiredApprovals || []).map(item => `<li>${escapeHtml(item.message)}</li>`).join("")}
    ${(feasibility.enrollmentConditions || []).map(item => `<li>${escapeHtml(`${item.course}${item.section ? `-${item.section}` : ""} in ${item.term}: ${item.type.replaceAll("_", " ")}`)}</li>`).join("")}
  </ul></section>` : "";
  return `${blocks}${status}${conditions}`;
}

function requirementTable(report) {
  const rows = report.requirements.map(requirement => `<tr><td>${escapeHtml(requirement.label)}</td><td>${display(requirement.strict)}</td><td>${display(requirement.optimistic)}</td><td>${display(requirement.projected)}</td><td>${display(requirement.evidence)}</td></tr>`).join("");
  return `<section class="year-block"><div class="year-heading"><h2>Requirement assignments</h2></div><div class="table-wrap"><table><thead><tr><th>Requirement</th><th>Strict</th><th>Optimistic</th><th>In progress</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
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
  const seniorStandingBasisLabel = seniorStandingBasis === "student_reported_registrar_or_advisor_confirmation"
    ? `Student-reported Registrar or advisor confirmation${seniorStandingAcademicYear ? ` for ${seniorStandingAcademicYear}` : ""}`
    : seniorStandingBasis === "college_year_progression"
      ? "College-year progression"
      : seniorStandingBasis;
  if (!planId && !graduationTarget) return "";
  const details = [
    planId ? `<li><strong>Plan ID:</strong> <span data-selected-plan-id="${escapeHtml(planId)}">${escapeHtml(planId)}</span></li>` : "",
    graduationTarget ? `<li><strong>Expected graduation:</strong> <span data-graduation-target="${escapeHtml(graduationTarget)}">${escapeHtml(graduationTarget)}</span></li>` : "",
    paceLabel ? `<li><strong>Planning pace:</strong> <span data-planning-pace="${escapeHtml(planningPace)}">${escapeHtml(paceLabel)}</span></li>` : "",
    seniorStandingBasisLabel ? `<li><strong>Senior-standing basis:</strong> <span data-senior-standing-basis="${escapeHtml(seniorStandingBasis)}"${seniorStandingAcademicYear ? ` data-senior-standing-academic-year="${escapeHtml(seniorStandingAcademicYear)}"` : ""}>${escapeHtml(seniorStandingBasisLabel)}</span></li>` : ""
  ].filter(Boolean).join("");
  return `<section class="year-block"><div class="year-heading"><h2>Plan details</h2></div><ul>${details}</ul></section>`;
}

function planWarnings(report) {
  const selectedPlan = report.selectedPlan || {};
  return [...new Set([
    ...(selectedPlan.warnings || []),
    ...(selectedPlan.studentMessages || []),
    ...(selectedPlan.feasibility?.warnings || [])
  ].map(item => String(item || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function warningSection(report) {
  const warnings = planWarnings(report);
  if (!warnings.length) return "";
  return `<section class="year-block"><div class="year-heading"><h2>Plan warnings</h2></div><ul>${warnings.map(warning => `<li data-plan-warning>${escapeHtml(warning)}</li>`).join("")}</ul></section>`;
}

function advisorAttentionSection(report) {
  const notices = report.catalog?.advisorAttention || [];
  if (!notices.length) return "";
  const items = notices.map(notice => `<li data-advisor-attention-code="${escapeHtml(notice.code)}" data-title="${escapeHtml(notice.title)}" data-severity="${escapeHtml(notice.severity)}">${escapeHtml(notice.message)}</li>`).join("");
  return `<section class="year-block"><div class="year-heading"><h2>Advisor attention</h2></div><ul>${items}</ul></section>`;
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
    "{{REMAINING_YEAR_COUNT}}": report.selectedPlan?.planningContext?.remainingYears || "Advisor check",
    "{{PLANNED_COURSE_COUNT}}": reportPlanCount(report),
    "{{ECO461_TARGET_TERM}}": report.terms.find(term => term.courses.some(course => course.code === "ECO 461"))?.term || "Advisor check",
    "{{YEAR_BLOCKS_HTML}}": `${planDetails(report)}${yearBlocks(report)}${requirementTable(report)}${warningSection(report)}${advisorAttentionSection(report)}${checks(report)}`
  };
  return Object.entries(replacements).reduce((html, [token, value]) => {
    return html.replaceAll(token, token === "{{YEAR_BLOCKS_HTML}}" ? value : escapeHtml(value));
  }, withoutTemplate);
}
