"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  buildEarlyGraduationContext,
  buildPlanningSlots,
  PLANNING_PACES,
  resolvePlanningContext,
  transferPlanningOptions
} from "../lib/planning/horizon.js";
import {
  buildPrerequisiteFollowUp,
  unansweredPrerequisiteQuestions,
  validateStudentPrerequisites
} from "../lib/planning/prerequisiteFormValidation.js";
import { acceleratedMathSequenceNotes } from "../lib/planning/acceleratedMathSequence.js";
import {
  createGeneratedPlannerSession,
  economicsResultFromReport,
  migratePlannerInputState,
  PLANNER_INPUT_STATE_VERSION,
  PLANNER_VIEWS,
  plannerViewFromSearch,
  replaceEconomicsPlan
} from "../lib/planning/uiState.js";
import { validateSavedPlannerSession } from "../lib/planning/session-restoration.js";
import { compactEconomicsPlanForValidation } from "../lib/planning/validation-payload.js";
import { requirementFormGroups } from "../lib/planning/requirementFormChoices.js";
import economicsRequirements from "../data/normalized/economics/requirements.json";
import economicsCourseData from "../data/normalized/economics/courses.json";
import economicsPlanningConstraints from "../data/normalized/economics/planning-constraints.json";
import { seatStatusPresentation } from "../lib/planning/seat-status.js";
import { studentFriendlyCourseMarker, studentFriendlyUnavailableReason } from "../lib/planning/student-language.js";

const PLANNER_STORAGE_KEY = "econ-planner-ui-state";
const GENERATED_PLANNER_SESSION_KEY = "econ-planner-generated-session";
const PLANNER_STORAGE_VERSION = PLANNER_INPUT_STATE_VERSION;
const COURSE_CATALOG = economicsCourseData.courses || [];
const COURSE_ALIASES = new Map(COURSE_CATALOG.flatMap(course => (
  (course.aliases || []).map(alias => [alias, course.code])
)));
const NON_SELECTABLE_COURSE_CODES = new Set(COURSE_CATALOG
  .filter(course => course.studentSelectable === false)
  .map(course => course.code));
const AP_CREDIT_ALLOWED_COURSE_CODES = new Set(COURSE_CATALOG
  .filter(course => course.apEligible)
  .map(course => course.code));
const COURSE_PREREQUISITES = Object.fromEntries(COURSE_CATALOG
  .filter(course => (
    (course.prerequisites?.all || []).length
    || (course.prerequisites?.any || []).length
  ))
  .map(course => [course.code, course.prerequisites]));

const SELECTABLE_COURSE_CATALOG = COURSE_CATALOG.filter(course => course.studentSelectable !== false);
const STANDING_LABELS = Object.freeze({
  freshman: "Freshman",
  sophomore: "Sophomore",
  junior: "Junior",
  senior: "Senior"
});

const SUPPORTING_COURSE_GROUPS = requirementFormGroups(economicsRequirements, courseTitle);
const GROUPED_COURSE_CODES = new Set(SUPPORTING_COURSE_GROUPS.flatMap(group => group.courseCodes));

const COURSE_DISPLAY_GROUPS = [
  {
    id: "ECO 113",
    code: "ECO 113",
    title: courseTitle("ECO 113"),
    courseCodes: ["ECO 113"]
  },
  {
    id: "ECO 114",
    code: "ECO 114",
    title: courseTitle("ECO 114"),
    courseCodes: ["ECO 114"]
  },
  {
    id: "ECO 160",
    code: "ECO 160",
    title: courseTitle("ECO 160"),
    courseCodes: ["ECO 160"]
  },
  {
    id: "ECO 161",
    code: "ECO 161",
    title: courseTitle("ECO 161"),
    courseCodes: ["ECO 161"]
  },
  {
    id: "ECO 213",
    code: "ECO 213",
    title: courseTitle("ECO 213"),
    courseCodes: ["ECO 213"]
  },
  {
    id: "ECO 214",
    code: "ECO 214",
    title: courseTitle("ECO 214"),
    courseCodes: ["ECO 214"]
  },
  {
    id: "ECO 461",
    code: "ECO 461",
    title: courseTitle("ECO 461"),
    courseCodes: ["ECO 461"]
  },
  ...SUPPORTING_COURSE_GROUPS,
  ...COURSE_CATALOG
    .filter(course => course.studentSelectable !== false && !GROUPED_COURSE_CODES.has(course.code) && !["ECO 113", "ECO 114", "ECO 160", "ECO 161", "ECO 213", "ECO 214"].includes(course.code))
    .map(course => ({
      id: course.code,
      code: course.code,
      title: course.title,
      courseCodes: [course.code]
    }))
];

const DECLARATION_COURSE_IDS = ["ECO 113", "ECO 114", "ECO 213", "ECO 214"];
const DECLARATION_REQUIREMENT_IDS = ["math-requirement", "statistics-requirement"];
const MAX_COURSE_NAME_CHARS = Math.max(...COURSE_DISPLAY_GROUPS.map(group => `${group.code} ${group.title}`.length));
const COURSE_COLUMNS_STYLE = { "--course-name-width": `calc(${MAX_COURSE_NAME_CHARS}ch + .4rem)` };

const blankCourse = course => ({
  id: course.code,
  code: course.code,
  title: course.title,
  status: "not_started",
  units: String(course.units ?? 1),
  grade: "",
  source: "manual_code",
  notes: ""
});

const SAVED_STATUS_PRIORITY = {
  completed: 5,
  transfer: 4,
  in_progress: 3,
  not_started: 2,
  uncertain: 1
};

function canonicalSavedCode(value) {
  const normalized = String(value || "").toUpperCase().replace(/^([A-Z]{2,5})\s*-?\s*(\d{3})$/, "$1 $2");
  return COURSE_ALIASES.get(normalized) || normalized;
}

function migrateSavedCourses(savedCourses = []) {
  const byCode = new Map();
  for (const savedCourse of savedCourses) {
    const code = canonicalSavedCode(savedCourse.code);
    if (!code || NON_SELECTABLE_COURSE_CODES.has(code) || !COURSE_CATALOG.some(course => course.code === code)) continue;
    const existing = byCode.get(code);
    if (!existing || (SAVED_STATUS_PRIORITY[savedCourse.status] || 0) > (SAVED_STATUS_PRIORITY[existing.status] || 0)) {
      byCode.set(code, { ...savedCourse, code });
    }
  }

  return SELECTABLE_COURSE_CATALOG.map(course => {
    const saved = byCode.get(course.code);
    return saved
      ? {
          ...blankCourse(course),
          ...saved,
          id: course.code,
          code: course.code,
          title: course.title,
          units: String(course.units ?? 1)
        }
      : blankCourse(course);
  });
}

function plannerInputSignature(formData) {
  const currentTermWindow = resolvePlanningContext(formData).currentTermPlanningWindow;
  return JSON.stringify({
    academicStanding: formData.academicStanding,
    majorDeclarationCatalogYear: formData.majorDeclarationCatalogYear,
    planningPace: formData.planningPace,
    planCreationDate: formData.planCreationDate,
    isTransferStudent: formData.isTransferStudent,
    customGraduationEnabled: formData.customGraduationEnabled,
    customExpectedGraduationYear: formData.customExpectedGraduationYear,
    transferExpectedGraduationYear: formData.transferExpectedGraduationYear,
    transferEntryAcademicYear: formData.transferEntryAcademicYear,
    reservedCourseUnits: formData.reservedCourseUnits,
    termLoadOverrides: formData.termLoadOverrides,
    studyAbroadTerm: formData.studyAbroadTerm,
    currentTermScheduleSet: currentTermWindow
      ? [currentTermWindow.slotId, formData.scheduleSetByTerm?.[currentTermWindow.slotId] === true]
      : null,
    courses: selectedCourses(formData.courses)
      .map(course => [canonicalSavedCode(course.code), course.status, course.units, course.source])
      .sort((left, right) => left[0].localeCompare(right[0]))
  });
}

const initialForm = {
  displayName: "",
  academicStanding: "",
  majorDeclarationCatalogYear: "",
  planningPace: PLANNING_PACES.STANDARD,
  planCreationDate: "",
  planCreationDateEdited: false,
  isTransferStudent: false,
  customGraduationEnabled: false,
  customExpectedGraduationYear: "",
  transferExpectedGraduationYear: "",
  transferEntryAcademicYear: "",
  expectedGraduationTerm: "",
  reservedCourseUnits: {},
  termLoadOverrides: {},
  reservationMemory: {},
  scheduleSetByTerm: {},
  studyAbroadTerm: "",
  courses: SELECTABLE_COURSE_CATALOG.map(blankCourse),
  advisorApprovals: ""
};

function courseLevel(code) {
  return Number(String(code).match(/\d+$/)?.[0] || 0);
}

function isTaken(course) {
  return course.status === "completed" || course.status === "transfer";
}

function visibleCourseStatus(course = {}) {
  if (isTaken(course)) return "completed";
  if (course.status === "in_progress") return "in_progress";
  if (course.status === "uncertain") return "uncertain";
  return "";
}

function completionSourceLabel(course = {}) {
  if (course.status === "transfer") return "Another college / transfer credit";
  if (course.source === "ap_credit" || /\bap\b|exam/i.test(course.source || "")) return "AP or exam credit";
  return "Hanover College";
}

function hasExplicitPrerequisiteConflict(question = {}) {
  return Boolean(
    question.blocking
    && (question.statuses || []).some(item => item.status && item.status !== "not_started")
  );
}

function prerequisiteStatusLabel(status) {
  return ({
    completed: "Completed",
    transfer: "Completed with transfer credit",
    in_progress: "Taking now",
    uncertain: "Not taken / not sure",
    repeated: "Repeated",
    failed: "Not completed",
    withdrawn: "Withdrawn"
  })[status] || plainCodeText(status);
}

function explicitPrerequisiteStatusText(question = {}) {
  return (question.statuses || [])
    .filter(item => item.status && item.status !== "not_started")
    .map(item => `${item.code} is marked ${prerequisiteStatusLabel(item.status)}`)
    .join("; ");
}

function selectedCourses(courses) {
  return courses.filter(course => !NON_SELECTABLE_COURSE_CODES.has(course.code) && ["completed", "transfer", "in_progress"].includes(course.status));
}

function courseTitle(code) {
  return COURSE_CATALOG.find(course => course.code === code)?.title || code;
}

function economicsResult(report) {
  return economicsResultFromReport(report);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasValidGeneratedPlan(plan) {
  return isPlainObject(plan)
    && typeof plan.id === "string"
    && plan.id.length > 0
    && Array.isArray(plan.terms)
    && plan.terms.every(term => (
      isPlainObject(term)
      && typeof (term.slotId || term.term) === "string"
      && Array.isArray(term.courses)
      && term.courses.every(course => isPlainObject(course) && typeof course.course === "string" && course.course.length > 0)
    ));
}

function isValidGeneratedPlannerReport(report) {
  if (!isPlainObject(report) || !Array.isArray(report.programs)) return false;
  const result = economicsResult(report);
  if (!isPlainObject(result) || !isPlainObject(result.program)) return false;
  if (result.program.id !== "economics-base" && result.program.name !== "Economics") return false;
  if (!Array.isArray(result.economicsPlans)
    || !Array.isArray(result.economicsPlanningGaps)
    || !Array.isArray(result.economicsCandidateOutcomes)) return false;

  if (!result.economicsPlans.every(hasValidGeneratedPlan)) return false;
  if (!result.economicsPlans.length) return result.economicsPlan === null;
  return hasValidGeneratedPlan(result.economicsPlan)
    && result.economicsPlan.id === result.economicsPlans[0].id;
}

function studentFacingRequestError(error, fallback, connectionMessage = "The planner could not connect. Please try again.", timeoutSubject = "The planner") {
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  if (error?.name === "AbortError" || /abort(?:ed|error)?/i.test(message)) {
    return "The request was interrupted. Please try again.";
  }
  if (error?.name === "TimeoutError" || /timed?\s*out|timeout/i.test(message)) {
    return `${timeoutSubject} took too long to respond. Please try again.`;
  }
  if (!message || /failed to fetch|networkerror|network request failed|load failed|network stack/i.test(message)) {
    return connectionMessage;
  }
  return message || fallback;
}

function planCourseIdentity(course) {
  return course.requirementId || `${course.course}-${course.source || "course"}`;
}

function domId(value) {
  return String(value || "item").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function localToday() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatAcademicYear(value) {
  return value ? String(value).replace("-", "/") : "Academic year";
}

function formatAcademicYearCompact(startYear) {
  return `${startYear}\u2013${String(startYear + 1).slice(-2)}`;
}

function PlanningGaps({ items = [] }) {
  if (!items.length) return null;
  return (
    <div className="plan-notes planning-gaps">
      <strong>What still needs attention</strong>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.requirementId || item.code || "gap"}-${index}`}>
            {item.course ? `${item.course}: ` : ""}{item.reason || item.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function isFlattenedPlanNotice(notice) {
  return String(notice?.code || "").startsWith("PLAN_")
    || ["Graduation planning assumption", "Graduation plan advisor review"].includes(notice?.title);
}

function academicYearKey(value) {
  return String(value || "").replace("/", "-");
}

function scheduleTermKey(term) {
  const value = String(term?.termKey || term?.scheduleTerm || term?.displayTerm || term?.term || "");
  if (/spring|may/i.test(value)) return "May";
  return value;
}

function termReservationLimit(slot = {}) {
  const key = slot.termKey === "Spring" ? "May" : slot.termKey;
  const contract = economicsPlanningConstraints.terms?.[key];
  return Math.max(0, Number(contract?.normalCourseUnits ?? contract?.maxTotalCourses ?? 0));
}

function planningSlotsLabel(slotId, planningContext) {
  return buildPlanningSlots(planningContext).find(slot => slot.id === slotId)?.label || slotId;
}

function structuredItemText(item, fallback) {
  if (typeof item === "string") return item;
  return item?.message || item?.question || item?.prompt || item?.reason || item?.label || item?.code || fallback;
}

function plainCodeText(value) {
  const words = String(value || "").trim().replaceAll("_", " ").toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "";
}

function PlanNoteText({ text = "", emphasizeSectionIds = false }) {
  const pattern = emphasizeSectionIds ? /(ECO \d{3}|[A-Z]:)/g : /(ECO \d{3})/g;
  return String(text).split(pattern).map((part, index) =>
    /^ECO \d{3}$/.test(part) || (emphasizeSectionIds && /^[A-Z]:$/.test(part))
      ? <strong key={index}>{part}</strong> : part);
}

function UpcomingCourseEntry({ line }) {
  const separator = line.indexOf(" — ");
  const courseLabel = separator >= 0 ? line.slice(0, separator) : line;
  const meetingTimes = separator >= 0 ? line.slice(separator + 3) : "";
  const titleSeparator = courseLabel.indexOf(" · ");
  const courseCode = titleSeparator >= 0 ? courseLabel.slice(0, titleSeparator) : courseLabel;
  const courseTitle = titleSeparator >= 0 ? courseLabel.slice(titleSeparator + 3) : "";
  return <div className="upcoming-course-entry">
    <div className="upcoming-course-heading">
      <PlanNoteText text={courseCode} emphasizeSectionIds />{courseTitle && <> · <span className="upcoming-course-title">{courseTitle}</span></>}
    </div>
    {meetingTimes && <div className="upcoming-course-times">— <PlanNoteText text={meetingTimes} emphasizeSectionIds /></div>}
  </div>;
}

function AdvisorAttention({ plan }) {
  const notes = plan?.planNotes || [];
  if (!notes.length) return null;
  const presentation = {
    "ccr-ace": { title: "Other graduation requirements" },
    history: { title: "When these classes ran before" },
    upcoming: { title: "Upcoming courses" },
    future: { title: "Courses in future years" }
  };
  return (
    <div className="student-evidence-groups" data-plan-id={plan?.id || ""} data-plan-notes>
      {notes.map(note => {
        const display = presentation[note.id] || { title: note.title };
        return <section className="student-evidence-group" data-plan-note={note.id}
          data-degree-requirement-information={note.id === "ccr-ace" ? "" : undefined} key={note.id}>
          <h3 className="student-evidence-title">{display.title}</h3>
          <div className="student-evidence-content">
            {note.description && <p>{note.description}</p>}
            <ul>{note.items.map((item, index) => (
              <li key={index}>
                {item.code && <><strong>{item.code}</strong> </>}
                {item.label && <><strong>{item.label}</strong>: </>}
                {item.lines ? item.lines.map(line => note.id === "upcoming"
                  ? <UpcomingCourseEntry key={line} line={line} />
                  : <div key={line}><PlanNoteText text={line} /></div>)
                  : <PlanNoteText text={item.text} emphasizeSectionIds={note.id === "upcoming"} />}
              </li>
            ))}</ul>
            {note.caveat && <p>{note.caveat}</p>}
          </div>
        </section>;
      })}
    </div>
  );
}

function PlanConditions({ plan, catalog }) {
  const conditions = (plan?.planConditions || []).filter(item => item.kind !== "unmet"
    || !plan?.majorRequirementsChecklist?.unmetRequirements?.some(row => row.id === item.requirementId));
  const prerequisiteConditions = conditions.filter(item => item.kind === "prerequisite");
  const seatConditions = conditions.filter(item => item.kind === "seat");
  const otherConditions = conditions.filter(item => !["prerequisite", "seat"].includes(item.kind));
  const messages = new Set(conditions.flatMap(item => [item.message, ...(item.sourceMessages || [])]));
  const coveredNotices = new Set(conditions.flatMap(item => item.noticeCodes || []));
  const notices = (catalog?.advisorAttention || []).filter(item => !isFlattenedPlanNotice(item)
    && !["FUTURE_SCHEDULE_PROJECTION_NOTICE", "ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED"].includes(item.code)
    && !coveredNotices.has(item.code) && !messages.has(item.message));
  if (!conditions.length && !notices.length) return null;
  return <section className="plan-notes upfront-conditions" data-plan-conditions>
    <h2>Things to keep in mind</h2>
    {prerequisiteConditions.length > 0 && <div><h3>Classes to finish first</h3><ul>{prerequisiteConditions.map(item => <li key={item.id}>{item.message}</li>)}</ul></div>}
    {seatConditions.length > 0 && <div><h3>Before you register</h3><ul>{seatConditions.map(item => <li key={item.id}>{item.message}</li>)}</ul></div>}
    {otherConditions.length > 0 && <ul>{otherConditions.map(item => <li key={item.id}>{item.message}</li>)}</ul>}
    {notices.length > 0 && <ul>{notices.map(item => <li key={item.code}>{item.code === "FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE"
        ? <><strong>Ask your advisor whether a catalog petition is needed.</strong><details><summary>Catalog details</summary><p>{item.message}</p></details></>
        : item.message}</li>)}</ul>}
  </section>;
}

function MajorRequirementsChecklist({ plan }) {
  const checklist = plan?.majorRequirementsChecklist;
  if (!checklist?.rows?.length) return null;
  return <section className="major-checklist" data-major-requirements-checklist>
    <details className="comparison-disclosure"><summary>{checklist.title}</summary>
    <div className="comparison-disclosure-content">
    <table>
      <thead><tr><th scope="col">Requirement</th><th scope="col">Course / term</th><th scope="col">Status</th></tr></thead>
      <tbody>{checklist.rows.filter(row => row.status !== "still_needed").map(row => <tr key={row.id} data-requirement-checklist-id={row.id}>
        <th scope="row">{row.label}</th>
        <td>{row.course ? <><strong>{row.course}</strong>{row.term && ` — ${row.term}`}</> : row.courseTerm}{row.alternatives.length > 1 && <span className="checklist-alternatives">Requirement options: {row.alternatives.join(" / ")}</span>}</td>
        <td><span className={`checklist-status is-${row.status}`}><span className="checklist-symbol" aria-hidden="true">{row.symbol}</span> {row.statusLabel}</span>
          {row.markers.map(marker => <span className="checklist-marker" key={marker}>{marker}</span>)}</td>
      </tr>)}</tbody>
    </table>
    <div className="checklist-legend" aria-label="Checklist status legend">{checklist.legend?.map(state => <span key={state.status} className={`checklist-status is-${state.status}`}><span aria-hidden="true">{state.symbol}</span> {state.label}</span>)}</div>
    <p className="checklist-note">{checklist.note}</p>
    {checklist.unmetRequirements?.length > 0 && <div className="incomplete-candidate" data-incomplete-candidate>
      <h3>Requirements without a planned class</h3>
      <p>We haven’t matched a class to these requirements yet. A complete plan may still be possible.</p>
      <ul>{checklist.unmetRequirements.map(row => <li key={row.id}><strong>{row.label}</strong>: {row.courseTerm}{row.markers.length > 0 && `; ${row.markers.join("; ")}`}</li>)}</ul>
    </div>}
    </div>
    </details>
  </section>;
}

function CourseChange({ course, termId, planId, onEdit, busy, feedback, onUndo, canUndo }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const trigger = useRef(null);
  const moves = (course.moveDestinationOptions || []).filter(item => item.status !== "CURRENT")
    .map(item => ({ ...item, key: `move:${item.id}`, edit: { type: "move", toTermId: item.id },
      action: `Keep ${compactPlanCourse(course)} — ${item.label}` }));
  const replacements = (course.replacementDestinationOptions || []).map(item => ({ ...item,
    key: `replace:${item.id}`, edit: { type: "replace-move", toTermId: item.toTermId, replacementCourse: item.course },
    action: item.course === "ECO elective"
      ? `Move as a 200+ elective — choose the course later: ${item.label}`
      : `Replace with ${item.course} — ${item.label}` }));
  const all = [...moves, ...replacements];
  const usable = all.filter(item => ["ALLOWED", "CONDITIONAL"].includes(item.status));
  const unavailable = all.filter(item => !["ALLOWED", "CONDITIONAL"].includes(item.status));
  const selected = usable.find(item => item.key === choice);
  const close = () => { setOpen(false); setChoice(""); trigger.current?.focus(); };
  return <div className="plan-course-actions">
    <button type="button" ref={trigger} data-course-edit-id={`${planId}:${planCourseIdentity(course)}:change`}
      aria-label={`Change ${compactPlanCourse(course)}`} aria-expanded={open}
      disabled={busy} onClick={() => { setOpen(!open); setChoice(""); }}>Change</button>
    <div hidden={!open} className="course-change-panel" onKeyDown={event => { if (event.key === "Escape" && !busy) { event.stopPropagation(); close(); } }}>
      {usable.length ? <>
        <label>Course and destination
          <select aria-label={`Change ${compactPlanCourse(course)} to`} value={choice || `move:${termId}`} disabled={busy}
            onChange={event => setChoice(event.target.value)}>
            <option value={`move:${termId}`}>Choose a change…</option>
            {usable.map(item => <option key={item.key} value={item.key}>{item.action}{item.status === "CONDITIONAL" ? " (check before applying)" : ""}</option>)}
          </select>
        </label>
        {selected && <>
          <p className="change-preview">{selected.action}</p>
          {selected.edit.replacementCourse === "ECO elective" && <p>This replaces the named class with a 200+ Economics elective. You’ll choose the exact class later; the same requirement stays in your plan.</p>}
          <details className="course-choice-details" open={selected.status === "CONDITIONAL"}>
            <summary>{selected.status === "CONDITIONAL" ? "Before you apply" : "Why this move works"}</summary>
            <p>{studentFriendlyUnavailableReason(selected)}</p>
            <details className="course-reason-details"><summary>Full check details</summary>
              <p>{selected.message}</p>
              {selected.sourceRefs?.length > 0 && <details className="course-source-details"><summary>Sources for this check</summary><p>{selected.sourceRefs.join("; ")}</p></details>}
            </details>
          </details>
        </>}
        <button type="button" disabled={busy || !selected} onClick={async event => {
          const saved = await onEdit({ ...selected.edit, planId, fromTermId: termId, courseId: planCourseIdentity(course) }, event.currentTarget);
          if (saved) close();
        }}>{busy ? "Checking…" : "Apply change"}</button>
      </> : <p>No other move is available for this class right now.</p>}
      <button type="button" disabled={busy} onClick={close}>Cancel</button>
      {unavailable.length > 0 && <details className="course-choice-details">
        <summary>Why can’t I choose other terms? ({unavailable.length})</summary>
        <ul>{unavailable.map(item => <li key={item.key}>
          <strong>{item.edit.type === "move" ? item.label : item.action}</strong>
          <p>{studentFriendlyUnavailableReason(item)}</p>
          <details className="course-reason-details"><summary>Full check details</summary>
            <p>{item.message}</p>
            {item.sourceRefs?.length > 0 && <details className="course-source-details"><summary>Sources for this check</summary><p>{item.sourceRefs.join("; ")}</p></details>}
          </details>
        </li>)}</ul>
      </details>}
      {course.offeringInformation && <details className="course-offering-details">
        <summary>{course.offeringInformation.label}</summary><p>{course.offeringInformation.detail}</p>
        {course.offeringInformation.sourceRefs?.length > 0 && <details className="course-source-details"><summary>Sources</summary><p>{course.offeringInformation.sourceRefs.join("; ")}</p></details>}
      </details>}
    </div>
    {feedback && <p className={`plan-course-edit-feedback${feedback.failed ? " is-error" : ""}`} role={feedback.failed ? "alert" : "status"}>{feedback.message}</p>}
    {canUndo && <button type="button" disabled={busy} onClick={onUndo}>Undo last plan edit</button>}
  </div>;
}

function PlanTimeline({
  plans = [],
  planningGaps = [],
  activePlanId,
  schedule,
  onSelectPlan,
  onEditPlanCourse,
  editingPlanCourseKey,
  planEditFeedback,
  onUndoPlanEdit,
  undoCourseId
}) {
  if (!plans.length) {
    return planningGaps.length ? (
      <section className="plan-section">
        <PlanningGaps items={planningGaps} />
      </section>
    ) : null;
  }

  const activePlan = plans.find(plan => plan.id === activePlanId) || plans[0];
  const mathSequenceNotes = acceleratedMathSequenceNotes(activePlan, COURSE_PREREQUISITES);
  const academicYearGroups = (activePlan.terms || []).reduce((groups, term) => {
    const label = term.academicYear || formatAcademicYear(activePlan.academicYear);
    const group = groups.find(item => item.label === label);
    if (group) {
      group.terms.push(term);
    } else {
      groups.push({ label, terms: [term] });
    }
    return groups;
  }, []);

  return (
    <section className="plan-section">
      {undoCourseId === "__plan__" && <button type="button" className="undo-plan-edit-button" disabled={Boolean(editingPlanCourseKey)} onClick={onUndoPlanEdit}>Undo last plan edit</button>}
      {plans.length > 1 && (
        <div className="plan-tabs" role="group" aria-label="Generated plans">
          {plans.map(plan => (
            <button
              type="button"
              className={`plan-tab${plan.id === activePlan.id ? " is-active" : ""}`}
              aria-pressed={plan.id === activePlan.id}
              key={plan.id}
              onClick={() => onSelectPlan?.(plan.id)}
            >
              {plan.label}
            </button>
          ))}
        </div>
      )}
      <div
        id={activePlan.id}
        role="region"
        aria-label={`${activePlan.label} plan`}
      >
        <div className="academic-year-groups">
          {academicYearGroups.map(group => (
            <section className="academic-year-group" key={group.label}>
              <h3 className="academic-year-label">{group.label}</h3>
              <div className="plan-grid">
                {group.terms.map(term => (
                  <article
                    className={`term-card${term.isPlaceholder ? " is-placeholder" : ""}`}
                    data-academic-year={term.academicYear || ""}
                    data-placeholder={term.isPlaceholder ? "true" : "false"}
                    data-term-key={term.termKey || ""}
                    data-publication-status={term.publicationStatus || ""}
                    key={term.slotId || term.term}
                  >
                    <h4>{term.displayTerm || term.term}</h4>
                    {term.courses.length > 0 ? (
                      <ul>
                        {term.courses.map(course => {
                          const termId = term.slotId || term.term;
                          const courseId = planCourseIdentity(course);
                          const feedback = planEditFeedback?.planId === activePlan.id
                            && planEditFeedback.fromTermId === termId
                            && planEditFeedback.courseId === courseId
                            ? planEditFeedback : null;
                          return (
                            <li data-requirement-id={courseId} key={`${activePlan.id}-${termId}-${courseId}`}>
                              <div className="plan-course-summary">
                                <strong>{compactPlanCourse(course)}</strong>
                                <span>{course.title}</span>
                                {course.fixedInProgress && <span>Taking now — fixed in this term</span>}
                                <CourseAvailabilityStatus course={course} term={term} schedule={schedule} referenceDate={new Date().toISOString()} />
                                {course.preliminaryScheduleEvidence && <span className="plan-course-availability">Preliminary schedule ({course.preliminaryScheduleEvidence.issuedOn}); course and term subject to change</span>}
                                {(course.planningMarkers || []).map(marker => <span className="plan-course-approval" key={marker}>{studentFriendlyCourseMarker(marker)}</span>)}
                              </div>
                              {course.offeringInformation && <span className="offering-pattern">{course.offeringInformation.label}</span>}
                              {onEditPlanCourse && !course.fixedInProgress && <CourseChange
                                course={course} termId={termId} planId={activePlan.id} onEdit={onEditPlanCourse}
                                busy={Boolean(editingPlanCourseKey)} feedback={feedback}
                                onUndo={onUndoPlanEdit} canUndo={undoCourseId === courseId} />}

                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="empty-term">No courses placed</p>
                    )}
                    {term.isSummer && (
                      <p className="summer-term-note">Summer, online, last-resort option.</p>
                    )}
                    {term.isPlaceholder && (
                      <p className="placeholder-term-note">Exact course offerings and terms must be confirmed after the schedule is published.</p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
        {activePlan.validation?.valid === false && (
          <div className="plan-validation-errors">
            <strong role="alert">This edited plan needs attention.</strong>
            <ul>
              {activePlan.validation.errors.map(error => <li key={error}>{error}</li>)}
            </ul>
          </div>
        )}
        {activePlan.summerFallbacks?.length > 0 && (
          <div className="plan-notes summer-fallback-note">
            <strong>Summer fallback used</strong>
            <ul>
              {activePlan.summerFallbacks.map(item => (
                <li key={`${activePlan.id}-summer-${item.course}-${item.term}`}>
                  {item.course} in {item.term}: Summer, online, last-resort option. {item.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(mathSequenceNotes.length > 0 || activePlan.planningDetailMessages?.length > 0) && <details className="plan-notes">
          <summary>More planning details</summary>
          <ul>
            {mathSequenceNotes.map(note => <li className="accelerated-math-sequence-note" role="note" key={note}>{note}</li>)}
            {(activePlan.planningDetailMessages || []).map(message => <li key={message}>{message}</li>)}
          </ul>
        </details>}
      </div>
    </section>
  );
}

function compactPlanCourse(course) {
  return course.course === "ECO elective" && course.minimumLevel >= 200 ? "ECO elective (200+)" : course.course;
}

function feasibilityLabel(status) {
  return ({
    VERIFIED_FEASIBLE: "Verified feasible",
    CONDITIONALLY_FEASIBLE: "Conditionally feasible",
    PRELIMINARY_ONLY: "Preliminary only",
    SEARCH_INCOMPLETE: "Search incomplete - advisor review needed",
    NOT_FEASIBLE: "Not feasible"
  })[status] || "Status pending";
}

function hasExactAvailabilityEvidence(course) {
  return course?.source === "verified-offering"
    || course?.source === "summer-last-resort"
    || course?.verificationStatus === "verified";
}

function exactPublishedScheduleSection(course, term, schedule) {
  if (!course?.course || !course.section) return null;
  if (academicYearKey(term?.academicYear) !== academicYearKey(schedule?.academicYear)) return null;
  return (schedule?.terms?.[scheduleTermKey(term)] || []).find(section => (
    section.course === course.course && String(section.section || "") === String(course.section)
  )) || null;
}

function courseAvailabilityLabel(course, exactSection = false, referenceDate) {
  return seatStatusPresentation(course?.availability, { verified: exactSection && hasExactAvailabilityEvidence(course), referenceDate }).label;
}

function availabilityClassName(course, exactSection = false, referenceDate) {
  return `is-${seatStatusPresentation(course?.availability, { verified: exactSection && hasExactAvailabilityEvidence(course), referenceDate }).tone}`;
}

function CourseAvailabilityStatus({ course, term, schedule, referenceDate }) {
  if (academicYearKey(term?.academicYear) !== academicYearKey(schedule?.academicYear)) return null;
  const selectedSection = exactPublishedScheduleSection(course, term, schedule);
  return <span className={`plan-course-availability ${availabilityClassName(selectedSection, Boolean(selectedSection), referenceDate)}`}>{courseAvailabilityLabel(selectedSection, Boolean(selectedSection), referenceDate)}</span>;
}

function CandidateOutcomes({ outcomes = [], convergences = [] }) {
  if (!outcomes.length && !convergences.length) return null;
  return (
    <section className="candidate-outcomes" aria-label="Other planning results">
      {outcomes.length > 0 && (
        <ul>
          {outcomes.map(outcome => (
            <li key={`${outcome.id}-${outcome.label}`}>
              <strong>{outcome.label}:</strong> {feasibilityLabel(outcome.status)}
              {outcome.reasons?.length > 0 && ` — ${outcome.reasons.map(item => item.reason || item.message || item).join("; ")}`}
            </li>
          ))}
        </ul>
      )}
      {convergences.map(item => <p key={`${item.keptPlanId}-${item.convergedPlanId}`}>{item.message}</p>)}
    </section>
  );
}

function ScheduleAvailability({ schedule, plan }) {
  const scheduleYear = academicYearKey(schedule?.academicYear);
  const plannedByTerm = new Map((plan?.terms || [])
    .filter(term => academicYearKey(term.academicYear) === scheduleYear)
    .map(term => [scheduleTermKey(term), term.courses || []]));
  const terms = Object.entries(schedule?.terms || {})
    .map(([term, sections]) => [term, (plannedByTerm.get(term) || []).map(course => ({
      course,
      section: sections.find(item => (
        item.course === course.course && String(item.section || "") === String(course.section || "")
      )) || null
    }))])
    .filter(([, courses]) => courses.length > 0)
    .sort(([a], [b]) => ["Fall", "Winter", "May", "Summer"].indexOf(a) - ["Fall", "Winter", "May", "Summer"].indexOf(b));
  if (!terms.length) return null;
  const referenceDate = new Date().toISOString();
  const entries = terms.flatMap(([, courses]) => courses);
  const status = ({ course, section }) => courseAvailabilityLabel(section || course, Boolean(section), referenceDate);
  const allUnverified = entries.every(entry => status(entry) === "Seat availability not confirmed");
  const recorded = entries.filter(({ section }) => section?.availability?.status);
  const allRecordedOpenUndated = recorded.length === entries.length
    && recorded.every(({ section }) => section.availability.status === "open" && !section.availability.asOf);
  const courseLabel = course => `${course.course}${course.section ? `-${course.section}` : ""}`;
  return (
    <details className="schedule-availability comparison-disclosure">
      <summary>Class seats · {plan?.label || "This plan"} · {formatAcademicYear(schedule.academicYear)}</summary>
      <div className="comparison-disclosure-content">
      <p>{allUnverified ? "Seat availability hasn’t been confirmed. " : ""}Check the registration system before you register.</p>
      <dl className="seat-term-list">{terms.map(([term, courses]) => (
        <div key={term}><dt>{term}</dt><dd>{courses.map((entry, index) => <span key={`${term}-${courseLabel(entry.course)}-${index}`}>
          {index > 0 && ", "}{courseLabel(entry.course)}
          {!allUnverified && <> — <span className={availabilityClassName(entry.section || entry.course, Boolean(entry.section), referenceDate)}>{status(entry)}</span></>}
        </span>)}</dd></div>
      ))}</dl>
      {recorded.length > 0 && <details className="recorded-seat-information">
        <summary>Recorded seat information</summary>
        {allRecordedOpenUndated
          ? <p>These sections were recorded as open, but the observation dates are unavailable.</p>
          : <ul>{recorded.map(({ course, section }, index) => <li key={`${courseLabel(course)}-${index}`}>
            <strong>{courseLabel(course)}:</strong> Recorded as {section.availability.status}; observation date {section.availability.asOf || "unavailable"}.
          </li>)}</ul>}
        <p>Being listed on the schedule does not guarantee an open seat.</p>
      </details>}
      </div>
    </details>
  );
}

function comparisonScheduleRows(plan) {
  const rows = (plan?.terms || [])
    .map(term => ({
      key: `${term.academicYear || ""}-${term.isPlaceholder ? "TBC" : term.displayTerm || term.term}`,
      academicYear: formatAcademicYear(term.academicYear),
      term: term.isPlaceholder ? "Term to be confirmed" : term.displayTerm || term.term,
      courses: (term.courses || []).map(compactPlanCourse)
    }));

  return rows.map((row, index) => {
    if (index > 0 && rows[index - 1].academicYear === row.academicYear) {
      return row;
    }

    const yearRowSpan = rows.slice(index).findIndex(item => item.academicYear !== row.academicYear);
    return { ...row, yearRowSpan: yearRowSpan === -1 ? rows.length - index : yearRowSpan };
  });
}

function PlanComparisonScreen({
  report,
  planResult,
  fallbackPlanningContext,
  courses,
  displayName,
  view,
  selectedPlanId,
  isExiting,
  isGenerating,
  editingPlanCourseKey,
  planEditStatus,
  planEditFeedback,
  canUndoPlanEdit,
  onEditCourses,
  onReviewTimeline,
  onClearAll,
  onBackToCompare,
  onChoosePlan,
  onSelectPlan,
  onRegenerate,
  onDownloadPdf,
  downloadButtonRef,
  isDownloadingPdf,
  pdfStatus,
  onEditPlanCourse,
  onUndoPlanEdit
}) {
  const result = economicsResult(report);
  const plans = result?.economicsPlans || [];
  const planningGaps = result?.economicsPlanningGaps || [];
  const candidateOutcomes = result?.economicsCandidateOutcomes || [];
  const convergences = result?.economicsPlanConvergences || [];
  const comparisonContext = result?.planningContext || fallbackPlanningContext;
  const canonicalPlanResult = result?.economicsPlanResult || planResult || null;
  const acceleratedResult = result?.economicsAcceleratedResult || null;
  const mergePossibleEarlyResult = acceleratedResult?.status === "POSSIBLE"
    && plans.some(plan => plan.id === "one-year-early");
  const [highlightDifferences, setHighlightDifferences] = useState(false);
  const resultHeadingRef = useRef(null);
  const isPlanView = view === PLANNER_VIEWS.PLAN;
  const selectedPlan = plans.find(plan => plan.id === selectedPlanId) || plans[0];
  const planningContext = isPlanView ? selectedPlan?.planningContext || comparisonContext : comparisonContext;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => resultHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [view]);

  const rowsByPlan = new Map(plans.map(plan => [plan.id, comparisonScheduleRows(plan)]));
  const allRowKeys = new Set([...rowsByPlan.values()].flatMap(rows => rows.map(row => row.key)));
  const sharedCoursesByRow = new Map([...allRowKeys].map(key => {
    const courseSets = plans.map(plan => new Set(
      rowsByPlan.get(plan.id)?.find(item => item.key === key)?.courses || []
    ));
    const shared = courseSets.length > 1
      ? [...courseSets[0]].filter(course => courseSets.every(set => set.has(course)))
      : [];
    return [key, new Set(shared)];
  }));
  const standing = displayName?.trim() || (planningContext?.customGraduationEnabled ? "Custom timeline" : planningContext?.effectiveStandingLabel)
    || planningContext?.standingLabel
    || "Student";
  const graduationTarget = planningContext?.expectedGraduationTerm || "To be confirmed";
  const completedCodes = courses.filter(isTaken).map(course => course.code);
  const inProgressCodes = courses.filter(course => course.status === "in_progress").map(course => course.code);
  const overallStatus = overallPlanReadiness(isPlanView && selectedPlan ? [selectedPlan] : plans);
  const noPlan = noPlanPresentation(canonicalPlanResult?.category, canonicalPlanResult?.reason);
  const displayedOverallStatus = plans.length
    ? overallStatus
    : canonicalPlanResult?.category === "INPUT_BLOCKED"
      ? "Needs one more detail"
      : canonicalPlanResult?.category === "INFEASIBLE_PROVEN"
        ? "Not possible"
        : ["MISSING_OFFERING", "TERM_OVERLOAD_EVIDENCE_REQUIRED"].includes(canonicalPlanResult?.reason) || canonicalPlanResult?.category === "SEARCH_INCOMPLETE"
          ? "More information needed"
          : "Needs advisor attention";
  const statusPlans = isPlanView && selectedPlan ? [selectedPlan] : plans;
  const statusReason = statusPlans.flatMap(plan => plan.planConditions || [])
    .find(item => item.kind === "review" && item.shortMessage)?.shortMessage;
  const planBadge = plan => {
    if (plan.planningMode !== "graduation_priority") return null;
    const mayCourse = plan.terms
      ?.find(term => term.scheduleTerm === "May")
      ?.courses?.[0]?.course;
    return mayCourse ? `${mayCourse} in May` : "Graduation priority";
  };
  const planDescription = plan => ({
    balanced: "Spreads the required classes you still need across the years before you graduate.",
    "explore-first": "Plans a lighter course load in the first year than Balanced. Classes that need an earlier class are scheduled later.",
    "one-year-early": "Plans to finish your remaining major requirements a year earlier."
  })[plan.id] || plan.description;

  return (
    <main className={`comparison-page${isExiting ? " is-exiting" : ""}`}>
      <style jsx global>{`
        body {
          margin: 0;
          background: #f5f5f7;
          color: #1d1d1f;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
        }
        button, input, select { font-family: inherit; }
        .comparison-page {
          box-sizing: border-box;
          min-height: 100vh;
          overflow-wrap: anywhere;
          animation: comparison-enter .28s ease-out both;
        }
        .comparison-page * { box-sizing: border-box; }
        .comparison-page.is-exiting { animation: comparison-exit .24s ease-in both; }
        @keyframes comparison-enter {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes comparison-exit {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        .comparison-topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 1rem 2rem;
          border-bottom: 1px solid #e5e5ea;
          background: #fff;
          box-shadow: 0 1px 5px rgba(25, 30, 45, .035);
        }
        .comparison-brand {
          display: flex;
          align-items: flex-start;
          flex-direction: column;
          gap: .35rem;
          color: #4b2e83;
          font-size: 25px;
          font-weight: 700;
          letter-spacing: -.03em;
        }
        .comparison-brand-logo { display: block; width: 168px; height: auto; }
        .comparison-student {
          display: flex;
          align-items: center;
          gap: .45rem;
          margin-left: auto;
          color: #2f1c57;
          font-size: 15px;
        }
        .comparison-student strong { font-weight: 700; }
        .comparison-actions {
          display: flex;
          align-items: center;
          gap: .65rem;
          margin-left: 1.25rem;
        }
        .edit-courses-button,
        .regenerate-plans-button,
        .compare-plans-button,
        .download-pdf-button,
        .undo-plan-edit-button {
          width: auto;
          min-height: 44px;
          margin: 0;
          padding: .65rem 1rem;
          border: 1px solid #85709f;
          border-radius: .7rem;
          background: #fff;
          color: #2f1c57;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
        }
        .edit-courses-button:hover,
        .regenerate-plans-button:hover,
        .compare-plans-button:hover,
        .download-pdf-button:hover,
        .undo-plan-edit-button:hover { background: #f4f1f8; }
        .comparison-page button:focus-visible,
        .comparison-page input:focus-visible,
        .comparison-page select:focus-visible,
        .comparison-page summary:focus-visible {
          outline: 3px solid #8ab4f8;
          outline-offset: 2px;
        }
        .regenerate-plans-button:disabled,
        .download-pdf-button:disabled,
        .undo-plan-edit-button:disabled { cursor: wait; opacity: .65; }
        .pdf-download-status { color: #33425d; font-size: 12px; }
        .comparison-content {
          width: min(1460px, calc(100% - 3rem));
          margin: 0 auto;
          padding: 1.15rem 0 3rem;
        }
        .comparison-back {
          width: auto;
          min-height: 0;
          margin: 0;
          padding: .25rem 0;
          border: 0;
          background: transparent;
          color: #4b2e83;
          font-size: 14px;
          cursor: pointer;
        }
        .comparison-back:hover { text-decoration: underline; }
        .comparison-course-status {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: .25rem;
          margin: .65rem 0 .9rem;
          padding: .65rem .8rem;
          border: 1px solid #cbd5e1;
          border-radius: .5rem;
          background: rgba(255, 255, 255, .82);
          color: #33425d;
          font-size: 12px;
        }
        .comparison-course-status p { margin: 0; }
        .comparison-course-status strong { color: #2f1c57; }
        .comparison-course-status span { display: block; margin-top: .2rem; font-size: 14px; }
        .result-status-value { font-weight: 700; }
        .result-status-reason { color: #52627a; font-size: 12px !important; line-height: 1.4; }
        .comparison-heading-row {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 1.5rem;
          margin: .55rem 0 1rem;
        }
        .comparison-heading-row h1 {
          margin: 0;
          color: #2f1c57;
          font-size: clamp(29px, 3vw, 42px);
          line-height: 1.05;
          letter-spacing: -.035em;
        }
        .comparison-heading-row p {
          margin: .45rem 0 0;
          color: #53627a;
          font-size: 15px;
        }
        @media (max-width: 900px) {
          .comparison-heading-row { align-items: flex-start; flex-wrap: wrap; gap: .6rem; }
          .comparison-heading-row > div { min-width: 0; flex: 1 1 100%; }
          .difference-toggle { margin-left: auto; }
        }
        .difference-toggle {
          display: flex;
          align-items: center;
          gap: .6rem;
          flex: 0 0 auto;
          color: #2f1c57;
          font-size: 14px;
          cursor: pointer;
        }
        .difference-toggle input {
          width: 2.7rem;
          height: 1.45rem;
          accent-color: #4b2e83;
          cursor: pointer;
        }
        .comparison-difference-key {
          margin: -.35rem 0 1rem;
          padding: .65rem .8rem;
          border: 1px solid #b8cdf4;
          border-radius: .5rem;
          background: #f3f7ff;
          color: #33425d;
          font-size: 13px;
        }
        .comparison-difference-key strong { color: #4169a6; }
        .comparison-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
          gap: 1rem;
          align-items: stretch;
        }
        .comparison-plan-card {
          display: flex;
          min-width: 0;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid #d9d9df;
          border-radius: 1rem;
          background: #fff;
          box-shadow: 0 .4rem 1.25rem rgba(25, 30, 45, .045);
        }
        .comparison-plan-card.is-selected {
          border-color: #9b86bd;
          box-shadow: 0 .6rem 1.5rem rgba(75, 46, 131, .1);
        }
        .comparison-plan-summary {
          min-height: 8rem;
          padding: 1.15rem 1.15rem .9rem;
          text-align: center;
        }
        .plan-title-row {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: .6rem;
          flex-wrap: wrap;
        }
        .comparison-plan-summary h2 {
          margin: 0;
          color: #2f1c57;
          font-size: 25px;
          line-height: 1.1;
        }
        .comparison-plan-summary p {
          max-width: 26rem;
          margin: .65rem auto 0;
          color: #41506a;
          font-size: 15px;
          line-height: 1.5;
        }
        .early-plan-status {
          display: inline-block;
          padding: .35rem .55rem;
          border: 1px solid #c5b5df;
          border-radius: 999px;
          background: #f7f4fb;
          color: #4f2d7f;
          font-size: 12px;
          font-weight: 650;
        }
        .early-plan-graduation-dates {
          max-width: 24rem;
          margin: .75rem auto 0;
          text-align: left;
        }
        .early-plan-graduation-dates > div { grid-template-columns: minmax(7rem, 1fr) auto; }
        .plan-strategy-badge {
          padding: .35rem .55rem;
          border: 1px solid #9dc7ff;
          border-radius: .4rem;
          background: #f3f8ff;
          color: #4b2e83;
          font-size: 12px;
        }
        .comparison-plan-card:nth-child(3) .plan-strategy-badge {
          border-color: #94cfbd;
          background: #f1fbf7;
          color: #087257;
        }
        .compact-schedule {
          width: calc(100% - 1.4rem);
          margin: 0 .7rem .85rem;
          border-collapse: collapse;
          table-layout: fixed;
          font-size: 14px;
        }
        .compact-schedule th,
        .compact-schedule td {
          padding: .48rem .5rem;
          border: 1px solid #d9dce2;
          text-align: left;
          vertical-align: top;
        }
        .compact-schedule th {
          background: #f2f5f9;
          color: #46536a;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: .035em;
        }
        .compact-schedule th:first-child,
        .compact-schedule td:first-child { width: 29%; white-space: nowrap; }
        .compact-schedule th:nth-child(2),
        .compact-schedule td:nth-child(2) { width: 26%; }
        .compact-schedule td:last-child {
          color: #111d36;
          font-weight: 700;
          line-height: 1.35;
          overflow-wrap: normal;
          word-break: normal;
        }
        .comparison-shared-course {
          color: #4169a6;
          font-weight: 500;
        }
        .comparison-empty-term {
          color: #68758a;
          font-weight: 500;
        }
        .plan-validation {
          margin: auto .9rem .7rem;
          color: #087257;
          font-size: 11px;
          font-weight: 700;
          text-align: center;
        }
        .plan-validation.is-invalid { color: #a52a1f; }
        .comparison-page .plan-section {
          margin-top: 1rem;
          padding: 1rem;
          border: 1px solid #d9d9df;
          border-radius: 1rem;
          background: #fff;
        }
        .comparison-page .plan-tabs {
          display: flex;
          gap: .4rem;
          margin-bottom: 1rem;
          border-bottom: 1px solid #cbd5e1;
        }
        .comparison-page .plan-tab {
          width: auto;
          margin: 0;
          padding: .65rem .9rem;
          border: 0;
          border-bottom: 3px solid transparent;
          background: transparent;
          color: #41506a;
          cursor: pointer;
        }
        .comparison-page .plan-tab.is-active {
          border-bottom-color: #4b2e83;
          color: #2f1c57;
          font-weight: 700;
        }
        .comparison-page .academic-year-group { margin-top: 1rem; }
        .comparison-page .academic-year-label { margin: 0 0 .55rem; color: #4b2e83; font-size: 17px; }
        .comparison-page .plan-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .8rem; }
        .comparison-page .term-card { align-self: start; min-width: 0; min-height: 8rem; padding: .8rem; border: 1px solid #cbd5e1; border-radius: .5rem; }
        .comparison-page .term-card.is-placeholder { border-style: dashed; background: #f7fbff; }
        .comparison-page .term-card h4 { margin: 0 0 .65rem; color: #17345b; }
        .comparison-page .term-card ul { display: grid; gap: .55rem; margin: 0; padding: 0; list-style: none; }
        .comparison-page .term-card li { padding: .55rem; border: 1px solid #d2dbe6; border-radius: .35rem; }
        .comparison-page .plan-course-summary strong,
        .comparison-page .plan-course-summary span { display: block; }
        .comparison-page .plan-course-summary span { margin-top: .15rem; color: #53627a; font-size: 12px; }
        .comparison-page .plan-course-summary .plan-course-availability { font-weight: 700; }
        .comparison-page .plan-course-availability.is-open,
        .comparison-page .schedule-availability .is-open { color: #167c32; font-weight: 700; }
        .comparison-page .plan-course-availability.is-full,
        .comparison-page .schedule-availability .is-full { color: #b42318; font-weight: 700; }
        .comparison-page .plan-course-availability.is-unavailable,
        .comparison-page .plan-course-availability.is-unverified,
        .comparison-page .schedule-availability .is-unverified,
        .comparison-page .schedule-availability .is-unavailable { color: #53627a; }
        .major-checklist { margin: 1rem 0; padding: 0; border: 0; background: transparent; }
        .major-checklist h2,.upfront-conditions h2 { margin: 0 0 .6rem; font-size: 19px; }
        .major-checklist table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        .major-checklist th,.major-checklist td { padding: .65rem .5rem; text-align: left; vertical-align: top; border-bottom: 1px solid #dde3eb; font-size: 14px; overflow-wrap: anywhere; }
        .major-checklist thead { background: #eef3f8; }
        .major-checklist th:first-child { width: 31%; }
        .major-checklist th:nth-child(2) { width: 45%; }
        .major-checklist th:last-child { width: 24%; }
        .checklist-status { display: inline-block; padding: .2rem .35rem; border-radius: 5px; font-weight: 700; }
        .checklist-symbol { font-size: 20px; line-height: 1; vertical-align: middle; }
        .checklist-legend { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: .7rem; font-size: 12px; }
        .incomplete-candidate { padding: .6rem; border-left: 3px solid #a16d13; margin-top: .7rem; }
        .checklist-status.is-completed { background: #e9f6ed; color: #176333; }
        .checklist-status.is-in_progress { background: #e4f2ff; color: #174d7a; }
        .checklist-status.is-planned { background: #eef0f3; color: #485365; }
        .checklist-status.is-still_needed,.checklist-marker { background: #fff2d5; color: #76510b; }
        .checklist-marker,.checklist-alternatives,.seat-evidence-detail { display: block; margin-top: .3rem; font-size: 12px; }
        .checklist-note { margin-bottom: 0; font-size: 13px; color: #53627a; }
        @media (max-width: 520px) {
          .comparison-disclosure-content { padding: .7rem; }
          .major-checklist th,.major-checklist td { padding: .5rem .25rem; font-size: 12px; }
          .checklist-marker,.checklist-alternatives { font-size: 11px; }
        }
        .comparison-page .plan-course-summary .plan-course-approval { color: #8a4c00; font-weight: 700; }
        .comparison-page .plan-course-actions { display: grid; gap: .35rem; margin-top: .5rem; }
        .comparison-page .plan-course-actions select,
        .comparison-page .plan-course-actions button { width: 100%; min-height: 44px; font-size: 14px; }
        .comparison-page .plan-course-actions button { border: 1px solid #b8b8c0; border-radius: .7rem; background: #fff; color: #253753; cursor: pointer; }
        .comparison-page .plan-course-edit-feedback.is-error { padding: .45rem .55rem; border: 1px solid #c85a4c; border-radius: .25rem; background: #fff2ef; color: #6f2119; font-weight: 600; }
        .comparison-page .plan-course-edit-feedback { padding: .65rem; margin: .25rem 0; background: #edf7f0; color: #195e36; border: 1px solid #a5c9b1; border-radius: .7rem; }
        .comparison-page .course-change-panel { padding: .75rem; border: 1px solid #d9dce2; border-radius: .85rem; background: #f7f7fa; display: grid; gap: .6rem; }
        .comparison-page .course-change-panel[hidden] { display: none; }
        .comparison-page .course-change-panel button, .comparison-page .course-change-panel details,
        .comparison-page .course-change-panel label, .comparison-page .course-change-panel select { margin: 0; }
        .comparison-page .course-change-panel .course-choice-details ul { gap: .3rem; }
        .comparison-page .course-change-panel .course-choice-details li { margin: 0; padding: .35rem 0; }
        .comparison-page .course-change-panel p { margin: .25rem 0; font-size: 13px; line-height: 1.45; }
        .comparison-page .course-change-panel select { width: 100%; max-width: 100%; min-height: 44px; }
        .comparison-page .course-change-panel label { min-width: 0; font-size: 13px; }
        .comparison-page .course-choice-details { font-size: 13px; line-height: 1.45; }
        .comparison-page .course-choice-details ul { padding-left: 1rem; }
        .comparison-page .course-choice-details li { border: 0; padding: .5rem 0; list-style: none; }
        .comparison-page .course-choice-details ul { padding-left: 0; }
        .comparison-page .course-reason-details, .comparison-page .course-offering-details { font-size: 12px; line-height: 1.4; }
        .comparison-page .course-source-details { font-size: 12px; overflow-wrap: anywhere; color: #52627a; }
        .comparison-page .course-source-details p { font-size: 12px; }
        .comparison-page .offering-pattern { display: block; color: #52627a; font-size: 12px; margin-top: .3rem; }
        .comparison-page .comparison-heading-row h1 { font-size: clamp(1.6rem, 4vw, 2.2rem); line-height: 1.2; word-break: normal; }
        .comparison-page .comparison-topbar { flex-wrap: wrap; gap: .75rem; }
        .comparison-page .comparison-brand { flex: 0 0 auto; white-space: nowrap; font-size: 21px; }
        .comparison-page .comparison-brand-logo { width: 110px; }
        .comparison-page .comparison-actions { flex-wrap: wrap; margin-left: auto; gap: .5rem; }
        .comparison-page .comparison-actions > button { flex: 0 0 auto; white-space: nowrap; min-height: 40px; }
        .comparison-page .result-progress { flex-shrink: 0; }
        .comparison-page .comparison-student { flex-shrink: 0; }
        .comparison-page summary { cursor: pointer; }
        .comparison-page button:focus-visible, .comparison-page select:focus-visible, .comparison-page summary:focus-visible { outline: 3px solid #365fba; outline-offset: 3px; }
        .comparison-page .plan-course-summary > strong { white-space: normal; word-break: normal; font-size: 15px; }
        .comparison-page .plan-course-summary > span { font-size: 13px; line-height: 1.35; }
        .comparison-page .plan-validation-errors { margin-top: 1rem; padding: .8rem; border: 1px solid #c85a4c; background: #fff2ef; color: #6f2119; }
        .comparison-page .plan-validation-errors ul { margin: .45rem 0 0; padding-left: 1.2rem; }
        .plan-edit-status { margin: .75rem 0; color: #33425d; }
        .candidate-outcomes { margin: .75rem 0 0; }
        .candidate-outcomes h2 { margin: 0 0 .5rem; font-size: 1rem; }
        .candidate-outcomes ul { margin: 0; padding-left: 1.2rem; }
        .candidate-outcomes p { margin: .55rem 0 0; }
        .schedule-availability { margin: 1rem 0; padding: .8rem 1rem; border: 1px solid #cfd8e6; border-radius: 12px; background: rgba(255,255,255,.8); }
        .schedule-availability summary { cursor: pointer; font-weight: 700; }
        .schedule-availability h3 { margin: .75rem 0 .25rem; font-size: .95rem; }
        .schedule-availability ul { margin: 0; padding-left: 1.2rem; }
        .comparison-page .schedule-availability, .comparison-page .result-diagnostics { font-size: 14px; line-height: 1.5; }
        .comparison-page .schedule-availability > summary, .comparison-page .result-diagnostics > summary { font-size: 15px; }
        .comparison-page .schedule-availability p { margin: .6rem 0; font-size: 14px; }
        .seat-term-list, .plan-choice-explanations { margin: .65rem 0 0; }
        .seat-term-list > div { display: flex; gap: .6rem; margin: .35rem 0; }
        .seat-term-list dt, .plan-choice-explanations dt { font-weight: 650; }
        .seat-term-list dt { flex: 0 0 4rem; }
        .seat-term-list dd, .plan-choice-explanations dd { margin: 0; min-width: 0; }
        .plan-choice-explanations > div { margin: .6rem 0; }
        .recorded-seat-information { margin-top: .65rem; color: #53627a; }
        .recorded-seat-information > summary { font-weight: 500; }
        .comparison-page .recorded-seat-information li { font-size: 14px; }
        .comparison-page .result-diagnostics .candidate-outcomes li { font-size: 14px; }
        .choose-plan-button {
          width: calc(100% - 2rem);
          min-height: 0;
          margin: 0 1rem 1rem;
          padding: .72rem 1rem;
          border: 1px solid #6d5a86;
          border-radius: .42rem;
          background: #fff;
          color: #2f1c57;
          font-size: 16px;
          font-weight: 700;
          cursor: pointer;
        }
        .choose-plan-button:hover { background: #f2eef7; }
        .comparison-plan-card.is-selected .choose-plan-button {
          border-color: transparent;
          background: #4b2e83;
          color: #fff;
        }
        .comparison-plan-card.is-selected .choose-plan-button:hover {
          background: #2f1c57;
        }
        .comparison-empty {
          padding: 1.25rem;
          border: 1px solid #bdc9da;
          border-radius: .7rem;
          background: #fff;
          color: #41506a;
        }
        .result-progress ol { display: flex; gap: .65rem; margin: 0; padding: 0; list-style: none; }
        .result-progress li { color: #667085; font-size: 14.4px; }
        .result-progress li::before { content: "✓ "; color: #4b2e83; }
        .result-progress li.is-current { color: #18202b; font-weight: 700; }
        .result-progress li.is-current::before { content: "● "; }
        .result-progress button {
          margin: 0;
          padding: 0;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
        }
        .no-plan-state {
          padding: 1.25rem;
          border: 1px solid #bdc9da;
          border-radius: .7rem;
          background: #fff;
        }
        .no-plan-state h2 { margin: 0; color: #18202b; font-size: 22px; line-height: 1.3; }
        .no-plan-state > p { color: #53627a; line-height: 1.5; }
        .no-plan-question-list, .no-plan-action-list { margin: .8rem 0; padding-left: 1.25rem; }
        .no-plan-primary {
          width: auto;
          min-height: 42px;
          padding: .65rem .9rem;
          border: 1px solid #172a40;
          border-radius: 7px;
          background: #2f1c57;
          color: #fff;
          font-weight: 700;
          cursor: pointer;
        }
        .result-diagnostics {
          margin-top: 1rem;
          padding: .75rem .9rem;
          border: 1px solid #cfd8e6;
          border-radius: 9px;
          background: #fff;
          color: #33425d;
        }
        .result-diagnostics > summary { cursor: pointer; color: #4b2e83; font-weight: 700; }
        .result-diagnostics .candidate-outcomes,
        .result-diagnostics .planning-gaps { margin: .75rem 0 0; }
        .comparison-actions .clear-all-results { color: #5a397d; }
        .accelerated-result {
          margin: 0 0 1rem;
          padding: 1rem 1.1rem;
          border: 1px solid #e1d8ee;
          border-left: 4px solid #4f2d7f;
          border-radius: .9rem;
          background: #f7f4fb;
        }
        .accelerated-result h2 { margin: 0; color: #302044; font-size: 1.25rem; line-height: 1.3; }
        .accelerated-result > p { margin: .75rem 0 0; color: #4c4357; font-size: .9375rem; line-height: 1.5; }
        .accelerated-result-status { display: inline-block; margin-left: .35rem; color: #4f2d7f; }
        .accelerated-target-list { display: grid; gap: .35rem; margin: .75rem 0 0; }
        .accelerated-target-list > div { display: grid; grid-template-columns: 9.5rem minmax(0, 1fr); gap: .5rem; align-items: baseline; }
        .accelerated-target-list dt { color: #514b5e; font-weight: 650; }
        .accelerated-target-list dd { min-width: 0; margin: 0; color: #302044; }
        .planning-guide-disclaimer { margin: 1.2rem 0 0; color: #626a75; font-size: 13px; text-align: center; }
        .comparison-page .advisor-attention,
        .comparison-page .plan-notes {
          margin: 1rem 0;
          padding: .8rem 1rem;
          border: 1px solid #d7a633;
          border-radius: .55rem;
          background: #fff8e3;
          color: #2b3445;
          font-size: 12px;
        }
        .comparison-page .advisor-attention h2 {
          margin: 0 0 .4rem;
          color: #8b5500;
          font-size: 14px;
        }
        .comparison-page .advisor-attention-scope {
          margin: -.15rem 0 .5rem;
          color: #6b7280;
          font-size: 11px;
          font-style: italic;
        }
        .comparison-page .advisor-attention h3 {
          margin: 0;
          color: #1d4ed8;
          font-size: 13px;
        }
        .comparison-page .advisor-attention h4 {
          margin: 0 0 .3rem;
          color: #714600;
          font-size: 12px;
        }
        .comparison-page .advisor-attention-item + .advisor-attention-item {
          margin-top: .5rem;
          padding-top: .5rem;
          border-top: 1px solid #e4c679;
        }
        .comparison-page .advisor-attention-item p { margin: .25rem 0 0; }
        .comparison-page .advisor-attention-groups {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: .65rem 1rem;
          margin-top: .5rem;
        }
        .comparison-page .advisor-attention-groups ul {
          margin: .3rem 0 0;
          padding-left: 1rem;
        }
        .comparison-page .projected-placement-list { margin: .35rem 0 0; padding-left: 1rem; }
        .comparison-page .projected-placement-list li + li { margin-top: .15rem; }
        .comparison-page .offering-pattern-note {
          padding-left: .55rem;
          border-left: 3px solid #8fb2ee;
        }
        .comparison-page .planning-gaps {
          margin-top: 1rem;
          border-color: #d17a65;
          background: #fff2ed;
        }
        .comparison-page .plan-notes ul {
          margin: .45rem 0 0;
          padding-left: 1.1rem;
        }
        .comparison-page .comparison-disclosure {
          margin: 1rem 0;
          padding: 0;
          overflow: hidden;
          border: 1px solid #d9d9df;
          border-radius: 1rem;
          background: #fff;
          color: #30343b;
          font-size: .9375rem;
          line-height: 1.5;
        }
        .comparison-page .comparison-disclosure > summary {
          display: flex;
          min-height: 64px;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: .85rem 1.1rem;
          color: #2f1c57;
          font-size: 1rem;
          font-weight: 600;
          line-height: 1.35;
          list-style: none;
          cursor: pointer;
        }
        .comparison-page .comparison-disclosure > summary::-webkit-details-marker { display: none; }
        .comparison-page .comparison-disclosure > summary::after {
          width: .55rem;
          height: .55rem;
          flex: 0 0 auto;
          border-right: 2px solid #7a8497;
          border-bottom: 2px solid #7a8497;
          content: "";
          transform: rotate(-45deg);
          transition: transform .15s ease;
        }
        .comparison-page .comparison-disclosure > summary:hover { background: #fafafd; }
        .comparison-page .comparison-disclosure[open] > summary { border-bottom: 1px solid #e7e8ed; }
        .comparison-page .comparison-disclosure[open] > summary::after { transform: rotate(45deg); }
        .comparison-page .comparison-disclosure-content { padding: 1rem; }
        .comparison-page .comparison-disclosure-content > :first-child { margin-top: 0; }
        .comparison-page .comparison-disclosure-content > :last-child { margin-bottom: 0; }
        .comparison-page .schedule-availability > .comparison-disclosure-content > p { margin: .1rem 0 .75rem; }
        .comparison-page .schedule-availability > .comparison-disclosure-content > .seat-term-list { margin: .5rem 0; }
        .comparison-page .student-evidence-group + .student-evidence-group { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #e7e8ed; }
        .comparison-page .student-evidence-title { margin: 0 0 .45rem; color: #2f1c57; font-size: 1rem; font-weight: 650; line-height: 1.35; }
        .comparison-page .student-evidence-content { font-size: .875rem; line-height: 1.5; }
        .comparison-page .student-evidence-group,
        .comparison-page .student-evidence-content,
        .comparison-page .upcoming-course-entry { min-width: 0; }
        .comparison-page .student-evidence-content p { margin: .25rem 0 .5rem; }
        .comparison-page .student-evidence-content ul { margin: .4rem 0; padding-left: 1.15rem; }
        .comparison-page .student-evidence-content li + li { margin-top: .45rem; }
        .comparison-page .upcoming-course-heading { overflow-wrap: anywhere; }
        .comparison-page .upcoming-course-title { text-decoration: underline; text-decoration-color: #b8a5d2; text-decoration-thickness: .06em; text-underline-offset: .15em; }
        .comparison-page .upcoming-course-times { margin-left: .85rem; color: #505b6b; overflow-wrap: anywhere; }
        .comparison-page .upfront-conditions {
          padding: 1rem 1.1rem;
          border-color: #e7d9b4;
          border-left: 4px solid #d1a148;
          border-radius: .9rem;
          background: #fffdf7;
          color: #30343b;
          font-size: .9375rem;
          line-height: 1.5;
        }
        .comparison-page .upfront-conditions h2 {
          margin: 0 0 .75rem;
          color: #2f1c57;
          font-size: 1.25rem;
          font-weight: 700;
          line-height: 1.25;
          letter-spacing: -.02em;
        }
        .comparison-page .upfront-conditions h3 {
          margin: 0 0 .3rem;
          color: #46516a;
          font-size: 1rem;
          font-weight: 650;
          line-height: 1.35;
        }
        .comparison-page .upfront-conditions > div + div { margin-top: .9rem; }
        .comparison-page .upfront-conditions ul {
          display: grid;
          gap: .45rem;
          margin: .25rem 0 0;
          padding-left: 1.15rem;
          list-style: disc;
        }
        .comparison-page .upfront-conditions li { padding-left: .1rem; }
        @media (max-width: 760px) {
          .comparison-grid { grid-template-columns: 1fr; }
          .comparison-course-status { grid-template-columns: 1fr 1fr; }
          .comparison-plan-summary { min-height: 0; }
          .comparison-page .plan-grid { grid-template-columns: 1fr; }
          .comparison-page .advisor-attention-groups { grid-template-columns: 1fr; }
        }
        @media (max-width: 700px) {
          .comparison-topbar {
            align-items: flex-start;
            flex-wrap: wrap;
            padding: .8rem 1rem;
          }
          .comparison-brand { flex-basis: 100%; }
          .comparison-student {
            width: 100%;
            min-width: 0;
            order: 3;
            margin: 0;
          }
          .comparison-actions {
            width: 100%;
            min-width: 0;
            margin: 0;
            flex-wrap: wrap;
          }
          .comparison-actions > button {
            min-width: 0;
            flex: 1 1 9rem;
            white-space: normal;
          }
          .comparison-content { width: min(100% - 1.25rem, 1460px); }
          .comparison-heading-row {
            align-items: flex-start;
            flex-direction: column;
          }
          .comparison-grid,
          .comparison-plan-card { max-width: 100%; min-width: 0; }
          .compact-schedule { font-size: 13px; }
          .compact-schedule th,
          .compact-schedule td {
            white-space: normal !important;
            overflow-wrap: anywhere;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .comparison-page,
          .comparison-page.is-exiting { animation: none; }
        }
      `}</style>

      <header className="comparison-topbar">
        <div className="comparison-brand">
          <Image
            className="comparison-brand-logo"
            src="/urveska-midnight-gold-underlined.png"
            alt="Urveska"
            width={1868}
            height={294}
            priority
          />
          <span>EconPlanner</span>
        </div>
        {!isPlanView && <nav className="result-progress" aria-label="Planner progress">
          <ol>
            <li><button type="button" onClick={onReviewTimeline}>About you</button></li>
            <li><button type="button" onClick={onEditCourses}>Your courses</button></li>
            <li className="is-current" aria-current="step"><span>Your plans</span></li>
          </ol>
        </nav>}
        {!isPlanView && <div className="comparison-student">
          <strong>{standing}</strong>
          <span aria-hidden="true">·</span>
          <span>Graduation target: {graduationTarget}</span>
        </div>}
        <div className="comparison-actions">
          {isPlanView && (
            <>
              <button
                type="button"
                className="download-pdf-button"
                ref={downloadButtonRef}
                disabled={isDownloadingPdf || Boolean(editingPlanCourseKey)}
                onClick={() => onDownloadPdf()}
              >
                {isDownloadingPdf ? "Creating PDF..." : "Download PDF"}
              </button>
              <button type="button" className="compare-plans-button" onClick={onBackToCompare}>
                Compare plans
              </button>
            </>
          )}
          <button
            type="button"
            className="regenerate-plans-button"
            disabled={isGenerating || Boolean(editingPlanCourseKey)}
            onClick={onRegenerate}
          >
            {isGenerating ? "Regenerating..." : "Regenerate plans"}
          </button>
          <button type="button" className="edit-courses-button" onClick={onEditCourses}>
            Edit answers
          </button>
          <button type="button" className="edit-courses-button clear-all-results" onClick={onClearAll}>
            Clear all
          </button>
        </div>
      </header>

      <div className="comparison-content">
        {pdfStatus && <p className="pdf-download-status" role="status" aria-live="polite">{pdfStatus}</p>}
        {!isPlanView && <button
          type="button"
          className="comparison-back"
          onClick={isPlanView ? onBackToCompare : onEditCourses}
        >
          {isPlanView ? "← Back to plan comparison" : "← Back to course selection"}
        </button>}
        <section className="comparison-course-status" aria-label="Selected course status">
          <p><strong>Graduation target</strong><span>{graduationTarget}</span></p>
          <p><strong>Completed</strong><span>{completedCodes.join(" · ") || "None"}</span></p>
          <p><strong>Taking now</strong><span>{inProgressCodes.join(" · ") || "None"}</span></p>
          <p><strong>Overall status</strong><span className="result-status-value">{displayedOverallStatus}</span>
            {displayedOverallStatus === "Needs advisor attention" && statusReason && <span className="result-status-reason">Why: {statusReason}</span>}
          </p>
        </section>
        <div className="comparison-heading-row">
          <div>
            <h1 ref={resultHeadingRef} tabIndex={-1}>{isPlanView
              ? `Review ${selectedPlan?.label || "your plan"}`
              : plans.length > 1
                ? "Compare your course plans"
                : plans.length === 1
                  ? "Your feasible plan"
                  : "Your planning result"}</h1>
            <p>{isPlanView
              ? "Choose Change beside a course to see valid options."
              : plans.length > 1
                ? "See when you’d take each class and when each plan could get you to graduation."
                : plans.length === 1
                  ? "The planner returned one validated schedule for this graduation target."
                  : "Review this result and the next step below."}</p>
          </div>
          {!isPlanView && plans.length > 1 && (
            <label className="difference-toggle">
              <span>Highlight differences</span>
              <input
                type="checkbox"
                checked={highlightDifferences}
                onChange={event => setHighlightDifferences(event.target.checked)}
              />
            </label>
          )}
        </div>

        {!isPlanView && highlightDifferences && (
          <p className="comparison-difference-key">
            <strong>Blue courses are shared by every plan in the same term.</strong> They remain visible so you can compare the complete timeline; the darker courses are the schedule differences to review.
          </p>
        )}

        {planEditStatus && <p className="plan-edit-status" role="status">{planEditStatus}</p>}
        {isPlanView ? (
          <PlanTimeline
            plans={plans}
            planningGaps={planningGaps}
            activePlanId={selectedPlan?.id}
            schedule={result?.annualSchedule}
            onSelectPlan={onSelectPlan}
            onEditPlanCourse={onEditPlanCourse}
            editingPlanCourseKey={editingPlanCourseKey || (isGenerating ? "generation-in-progress" : "")}
            planEditFeedback={planEditFeedback}
            onUndoPlanEdit={onUndoPlanEdit}
            undoCourseId={canUndoPlanEdit}
          />
        ) : plans.length > 0 ? (
          <div className="comparison-grid">
            {plans.map(plan => {
              const rows = rowsByPlan.get(plan.id) || [];
              const selected = selectedPlanId === plan.id;
              const invalid = plan.validation?.valid === false;
              const showEarlyGraduationDetails = mergePossibleEarlyResult && plan.id === "one-year-early";
              return (
                <article
                  className={`comparison-plan-card${selected ? " is-selected" : ""}`}
                  data-plan-id={plan.id}
                  key={plan.id}
                >
                  <div className="comparison-plan-summary">
                    <div className="plan-title-row">
                      <h2>{plan.label}</h2>
                      {planBadge(plan) && <span className="plan-strategy-badge">{planBadge(plan)}</span>}
                      {showEarlyGraduationDetails && <span className="early-plan-status">Possible</span>}
                    </div>
                    {!showEarlyGraduationDetails && <p>{planDescription(plan)}</p>}
                    {showEarlyGraduationDetails && (
                      <dl className="accelerated-target-list early-plan-graduation-dates" aria-label="Graduation dates">
                        <div><dt>Standard plan</dt><dd>{acceleratedResult.standardTarget}</dd></div>
                        <div><dt>This plan</dt><dd>{acceleratedResult.acceleratedTarget || "To be confirmed"}</dd></div>
                      </dl>
                    )}
                  </div>

                  {rows.length > 0 ? (
                    <table className="compact-schedule">
                      <thead>
                        <tr>
                          <th>Year</th>
                          <th>Term</th>
                          <th>Courses</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(row => (
                          <tr key={`${plan.id}-${row.key}`}>
                            {row.yearRowSpan && <td rowSpan={row.yearRowSpan}>{row.academicYear}</td>}
                            <td>{row.term}</td>
                            <td>
                              {row.courses.length > 0
                                ? row.courses.map((course, index) => (
                                    <span
                                      className={highlightDifferences && sharedCoursesByRow.get(row.key)?.has(course)
                                        ? "comparison-shared-course"
                                        : undefined}
                                      key={`${row.key}-${course}-${index}`}
                                    >
                                      {index > 0 ? ", " : ""}{course}
                                    </span>
                                  ))
                                : <span className="comparison-empty-term">No major course assigned</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}

                  <p className={`plan-validation${plan.validation?.valid === false ? " is-invalid" : ""}`}>
                    {planReadinessLabel(plan)}
                  </p>
                  <button
                    type="button"
                    className="choose-plan-button"
                    aria-pressed={selected}
                    aria-label={invalid ? `Review plan issues: ${plan.label}` : `Review this plan: ${plan.label}`}
                    onClick={() => onChoosePlan(plan.id)}
                  >
                    {invalid ? "Review plan issues" : "Review this plan"}
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <section className="no-plan-state">
            <h2 role="status">{noPlan.title}</h2>
            <p>{noPlan.message}</p>
            {canonicalPlanResult?.questions?.length > 0 && (
              <ul className="no-plan-question-list">
                {canonicalPlanResult.questions.map((question, index) => (
                  <li key={question.id || `${question.code || "question"}-${index}`}>
                    {structuredItemText(question, "Provide the requested planning detail.")}
                  </li>
                ))}
              </ul>
            )}
            {canonicalPlanResult?.actions?.length > 0 && (
              <ul className="no-plan-action-list">
                {canonicalPlanResult.actions.map((action, index) => (
                  <li key={action.id || `${action.code || "action"}-${index}`}>
                    {structuredItemText(action, "Review this planning item with your advisor.")}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="no-plan-primary"
              onClick={noPlan.actionTarget === "timeline" ? onReviewTimeline : onEditCourses}
            >
              {noPlan.action}
            </button>
          </section>
        )}

        {!isPlanView && acceleratedResult && !mergePossibleEarlyResult && (
          <section className="accelerated-result" aria-labelledby="accelerated-result-heading">
            <h2 id="accelerated-result-heading">
              {acceleratedResult.label}:
              <span className="accelerated-result-status">{({
                POSSIBLE: "Possible",
                NOT_POSSIBLE: "Not possible",
                MORE_INFORMATION_NEEDED: "More information needed"
              })[acceleratedResult.status] || "More information needed"}</span>
            </h2>
            <dl className="accelerated-target-list">
              <div><dt>Standard target</dt><dd>{acceleratedResult.standardTarget}</dd></div>
              <div><dt>Accelerated target</dt><dd>{acceleratedResult.acceleratedTarget || "To be confirmed"}</dd></div>
            </dl>
            {acceleratedResult.status !== "POSSIBLE" && acceleratedResult.message && <p>{acceleratedResult.message}</p>}
          </section>
        )}
        {selectedPlan?.majorRequirementsChecklist?.unmetRequirements?.length > 0 && <section className="incomplete-candidate">
          <strong>Unmet requirements</strong><ul>{selectedPlan.majorRequirementsChecklist.unmetRequirements.map(row => <li key={row.id}>{row.label}: {row.courseTerm}{row.markers?.length > 0 && `; ${row.markers.join("; ")}`}</li>)}</ul>
        </section>}
        {selectedPlan && <PlanConditions plan={selectedPlan} catalog={report?.catalog} />}

        {selectedPlan && (
          <>
            <MajorRequirementsChecklist plan={selectedPlan} />
            <details className="comparison-disclosure"><summary>More about this plan</summary><div className="comparison-disclosure-content"><AdvisorAttention plan={selectedPlan} /></div></details>
            <ScheduleAvailability schedule={result?.annualSchedule} plan={selectedPlan} />
          </>
        )}

        <ResultDiagnostics
          outcomes={candidateOutcomes}
          convergences={convergences}
          planningGaps={planningGaps}
          planResult={canonicalPlanResult}
          plans={plans}
        />
        <p className="planning-guide-disclaimer">EconPlanner is a planning guide, not an official degree audit.</p>
      </div>
    </main>
  );
}

function SummaryCourseCodes({ courses = [] }) {
  if (!courses.length) return <span className="summary-none">None selected</span>;
  const visible = courses.slice(0, 5);
  if (courses.length <= visible.length) return <span>{visible.join(" · ")}</span>;
  return (
    <>
      <span>{visible.join(" · ")}</span>
      <details className="summary-show-all">
        <summary>Show all {courses.length}</summary>
        <span>{courses.join(" · ")}</span>
      </details>
    </>
  );
}

function planReadinessLabel(plan) {
  const readiness = plan?.readinessStatus || plan?.validation?.readinessStatus || "";
  const disposition = plan?.planDisposition || plan?.validation?.planDisposition || "";
  if (readiness === "ADVISOR_ACTION_REQUIRED" || disposition.includes("ADVISOR_ACTION_REQUIRED")) {
    return "Needs advisor attention";
  }
  if (readiness === "READY_WITH_CONDITIONS" || disposition.includes("READY_WITH_CONDITIONS")) {
    return "Ready with conditions";
  }
  if (readiness === "STUDENT_READY" || disposition.includes("STUDENT_READY")) return "Ready to plan";
  return "Needs advisor attention";
}

function overallPlanReadiness(plans = []) {
  const labels = plans.map(planReadinessLabel);
  if (labels.includes("Needs advisor attention")) return "Needs advisor attention";
  if (labels.includes("Ready with conditions")) return "Ready with conditions";
  return plans.length ? "Ready to plan" : "Not available";
}

function noPlanPresentation(category, reason) {
  if (category === "INPUT_BLOCKED") {
    return {
      title: "We need one more detail before we can build your plan.",
      message: "Review the question below. Your previous answers are still saved.",
      action: "Review my answers"
    };
  }
  if (category === "INFEASIBLE_PROVEN") {
    return {
      title: "No complete plan fits this graduation target under the current requirements and course timing.",
      message: "Review your graduation timeline and bring this result to your academic advisor.",
      action: "Review graduation timeline",
      actionTarget: "timeline"
    };
  }
  if (category === "SEARCH_INCOMPLETE") {
    return {
      title: "We could not finish checking every possible plan.",
      message: "This does not mean a plan is impossible. Review your answers or ask an advisor to help check the remaining possibilities.",
      action: "Review my answers"
    };
  }
  if (reason === "MISSING_OFFERING") {
    return {
      title: "More information needed to decide whether this major can be completed by your target.",
      message: "Course offering evidence is incomplete for this graduation target. This result does not establish that major completion is impossible.",
      action: "Review my answers"
    };
  }
  if (reason === "TERM_OVERLOAD_EVIDENCE_REQUIRED") {
    return {
      title: "More information needed to assess an advisor-approved overload.",
      message: "The normal-load search found no complete plan. Record existing advisor approval and absence of academic probation before using additional capacity.",
      action: "Review my answers"
    };
  }
  return {
    title: "This planning result needs advisor attention before we can show a complete schedule.",
    message: "Your answers are saved. Review the details below with your academic advisor.",
    action: "Review my answers"
  };
}

function ResultDiagnostics({ outcomes, convergences, planningGaps, planResult, plans = [] }) {
  const planCount = plans.length;
  const blockingReasons = !planCount && planResult?.category === "INFEASIBLE_PROVEN"
    ? planResult.evidence?.blockingReasons || [] : [];
  const otherOutcomes = planCount ? outcomes.filter(outcome => !outcome.displayed) : outcomes;
  const hasDiagnostics = blockingReasons.length || otherOutcomes.length || convergences.length || planningGaps.length;
  if (!hasDiagnostics) return null;
  return (
    <details className="result-diagnostics">
      <summary>{planCount ? "More planning details" : "Why am I seeing this result?"}</summary>
      {blockingReasons.length ? <ul>{blockingReasons.map(reason => <li key={reason.code}>{reason.message}</li>)}</ul> : <>
        <CandidateOutcomes outcomes={otherOutcomes} convergences={convergences} />
        <PlanningGaps items={planningGaps} />
      </>}
    </details>
  );
}

function ClearAllDialog({ open, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      className="clear-all-dialog"
      aria-labelledby="clear-all-title"
      onCancel={event => {
        event.preventDefault();
        onCancel();
      }}
    >
      <style jsx global>{`
        .clear-all-dialog { display: block; width: min(calc(100% - 2rem), 28rem); padding: 1.25rem; border: 1px solid #cfc8dc; border-radius: 12px; box-shadow: 0 18px 50px rgba(29,20,48,.25); color: #201b2b; }
        .clear-all-dialog::backdrop { background: rgba(22,16,33,.45); }
        .clear-all-dialog h2 { margin: 0; font-size: 21px; }
        .clear-all-dialog p { margin: .65rem 0 1rem; line-height: 1.45; }
        .clear-all-dialog-actions { display: flex; justify-content: flex-end; gap: .65rem; }
        .clear-all-dialog button { min-height: 42px; padding: .55rem .9rem; border: 1px solid #7c708f; border-radius: 7px; background: #fff; color: #2f1c57; font-weight: 700; cursor: pointer; }
        .clear-all-dialog .confirm-clear-all { border-color: #2f1c57; background: #2f1c57; color: #fff; }
        @media (max-width: 520px) {
          .clear-all-dialog { width: calc(100% - 1.5rem); padding: 1rem; }
          .clear-all-dialog-actions { display: grid; grid-template-columns: 1fr 1fr; }
        }
      `}</style>
      <h2 id="clear-all-title">Clear all answers and generated plans?</h2>
      <p>This returns EconPlanner to a blank first page on this browser.</p>
      <div className="clear-all-dialog-actions">
        <button type="button" ref={cancelRef} onClick={onCancel}>Cancel</button>
        <button type="button" className="confirm-clear-all" onClick={onConfirm}>Clear all</button>
      </div>
    </dialog>
  );
}

function PlannerSummary({
  courses,
  pendingDependentCourseCodes = [],
  formData,
  planningContext,
  planningStart,
  attentionItems = [],
  intakeStep,
  isGenerating,
  status,
  onRetryRestoration,
  isRetryingRestoration,
  migrationNotice,
  generateButtonRef,
  onContinue,
  onFocusAttention,
  onClearAll
}) {
  const pendingCodes = new Set(pendingDependentCourseCodes);
  const completedCodes = courses.filter(course => isTaken(course) && !pendingCodes.has(course.code)).map(course => course.code);
  const inProgressCodes = courses.filter(course => course.status === "in_progress" && !pendingCodes.has(course.code)).map(course => course.code);
  const earlyContext = planningContext?.earlyComparisonRequested
    ? buildEarlyGraduationContext(planningContext)
    : null;
  const hasStanding = Boolean(formData.academicStanding);
  const standardPlanningContext = hasStanding
    ? resolvePlanningContext({
        ...formData,
        isTransferStudent: false,
        customGraduationEnabled: false,
        planningPace: PLANNING_PACES.STANDARD
      })
    : null;

  return (
    <aside className="summary-card cp7-summary" aria-labelledby="plan-setup-heading">
      <h2 id="plan-setup-heading">Your plan setup</h2>
      <dl className="summary-details">
        <div>
          <dt>Class standing</dt>
          <dd>{hasStanding ? STANDING_LABELS[formData.academicStanding] : "Choose your standing"}</dd>
        </div>
        <div>
          <dt>Standard graduation target</dt>
          <dd>{standardPlanningContext?.expectedGraduationTerm || "To be confirmed"}</dd>
        </div>
        {earlyContext?.expectedGraduationTerm && (
          <div>
            <dt>One-year-early target</dt>
            <dd>{earlyContext.expectedGraduationTerm}</dd>
          </div>
        )}
        {planningContext.customGraduationEnabled && (
          <div>
            <dt>Custom graduation target</dt>
            <dd>{planningContext.customGraduationValidation.valid ? planningContext.expectedGraduationTerm : "Needs more information"}</dd>
          </div>
        )}
        <div>
          <dt>Planning starts</dt>
          <dd>{hasStanding ? planningStart : "To be confirmed"}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd><SummaryCourseCodes courses={completedCodes} /></dd>
        </div>
        <div>
          <dt>Taking now</dt>
          <dd><SummaryCourseCodes courses={inProgressCodes} /></dd>
        </div>
        {formData.studyAbroadTerm && (
          <div>
            <dt>Study abroad</dt>
            <dd>No Economics courses in {planningSlotsLabel(formData.studyAbroadTerm, planningContext)}</dd>
          </div>
        )}
        {Object.entries(formData.reservedCourseUnits || {}).some(([, value]) => Number(value) > 0) && (
          <div>
            <dt>Room for other courses</dt>
            <dd>{Object.entries(formData.reservedCourseUnits)
              .filter(([slotId, value]) => Number(value) > 0 && slotId !== formData.studyAbroadTerm)
              .map(([slotId, value]) => `${planningSlotsLabel(slotId, planningContext)}: ${value}`)
              .join(" · ") || "Study-abroad term only"}</dd>
          </div>
        )}
      </dl>

      {(migrationNotice || attentionItems.length > 0) && (
        <div className="summary-attention">
          <strong role="status">Needs attention</strong>
          {migrationNotice && <p>{migrationNotice}</p>}
          {attentionItems.length > 0 && (
            <ul>
              {attentionItems.map(item => (
                <li key={`${item.target}-${item.message}`}>
                  <button type="button" onClick={() => onFocusAttention(item)}>{item.message}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {status && <p className="summary-status" role="status" aria-live="polite">{status}</p>}
      {onRetryRestoration && <button type="button" className="clear-all-button" onClick={onRetryRestoration} disabled={isRetryingRestoration}>
        {isRetryingRestoration ? "Checking saved plans…" : "Retry saved plans"}
      </button>}
      <button type="button" className="clear-all-button" onClick={onClearAll}>Clear all</button>
      {intakeStep === 1 ? (
        <button key="continue" type="button" className="primary-action" onClick={onContinue}>
          Continue to your courses
        </button>
      ) : (
        <button
          key="generate"
          type="submit"
          className="primary-action generate-button"
          ref={generateButtonRef}
          disabled={isGenerating || pendingDependentCourseCodes.length > 0}
        >
          {isGenerating ? "Generating plans…" : "Generate my plans"}
        </button>
      )}
    </aside>
  );
}

export default function Page() {
  const [formData, setFormData] = useState(initialForm);
  const courseAccordionRefs = useRef({});
  const generatedInputSignatureRef = useRef("");
  const generationInFlightRef = useRef(false);
  const generationRequestRef = useRef(0);
  const generationAbortRef = useRef(null);
  const planEditInFlightRef = useRef(false);
  const planEditRequestRef = useRef(0);
  const planEditAbortRef = useRef(null);
  const reportContextIdRef = useRef(null);
  const latestReportRef = useRef(null);
  const pdfDownloadInFlightRef = useRef(false);
  const pdfDownloadAbortRef = useRef(null);
  const pdfOperationRef = useRef(null);
  const generateButtonRef = useRef(null);
  const planEditTriggerRef = useRef(null);
  const downloadButtonRef = useRef(null);
  const [failureFocusTarget, setFailureFocusTarget] = useState("");
  const latestFormRef = useRef(initialForm);
  const restorationAbortRef = useRef(null);
  const recoverableSessionRef = useRef(null);
  const [restorationAttempt, setRestorationAttempt] = useState(0);
  const [canRetryRestoration, setCanRetryRestoration] = useState(false);
  const [isRetryingRestoration, setIsRetryingRestoration] = useState(false);
  const [restorationProgress, setRestorationProgress] = useState("");
  const [courseSearch, setCourseSearch] = useState("");
  const [completionSourceCourseCode, setCompletionSourceCourseCode] = useState("");
  const [intakeStep, setIntakeStep] = useState(1);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [migrationNotice, setMigrationNotice] = useState("");
  const [inputBlock, setInputBlock] = useState(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState(null);
  const [plannerView, setPlannerView] = useState(PLANNER_VIEWS.INPUT);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [pdfStatus, setPdfStatus] = useState("");
  const [editingPlanCourseKey, setEditingPlanCourseKey] = useState("");
  const [planEditStatus, setPlanEditStatus] = useState("");
  const [planEditFeedback, setPlanEditFeedback] = useState(null);
  const [planEditUndo, setPlanEditUndo] = useState(null);
  const [isComparisonExiting, setIsComparisonExiting] = useState(false);
  const planningContext = resolvePlanningContext(formData);
  const planningSlots = buildPlanningSlots(planningContext);
  const juniorStudyAbroadSlots = planningSlots.filter(slot => !slot.isSummer && slot.absoluteStandingIndex === 2);
  const planningSlotIdSignature = planningSlots.map(slot => slot.id).join("|");
  const planningStart = planningSlots[0]?.label || "To be confirmed";
  const inputPrerequisiteValidation = validateStudentPrerequisites(formData.courses, COURSE_PREREQUISITES);
  const unansweredDependentQuestions = formData.courses
    .filter(course => ["ECO 213", "ECO 214"].includes(course.code)
      && ["completed", "transfer", "in_progress"].includes(course.status))
    .flatMap(course => {
      const followUp = buildPrerequisiteFollowUp({
        course: course.code,
        targetStatus: course.status,
        courses: formData.courses,
        prerequisites: COURSE_PREREQUISITES
      });
      return unansweredPrerequisiteQuestions(followUp).map(question => ({
        course: course.code,
        id: question.id,
        options: [...question.options]
      }));
    });
  const pendingDependentCourseCodes = [...new Set(unansweredDependentQuestions.map(item => item.course))];
  const transferOptions = transferPlanningOptions(planningContext);
  const standingQuestion = planningContext.isSummer
    ? "What year will you be in this fall?"
    : "What year are you in this academic year?";
  const standingHelp = planningContext.isSummer
    ? `Choose the year you'll start in Fall ${planningContext.startYear}.`
    : `Choose your year for the ${formatAcademicYearCompact(planningContext.startYear)} academic year.`;
  latestFormRef.current = formData;
  latestReportRef.current = report;

  function updatePlanCreationDate(current, planCreationDate) {
    const next = {
      ...current,
      planCreationDate,
      planCreationDateEdited: true
    };
    if (!current.isTransferStudent) return next;

    const nextContext = resolvePlanningContext(next);
    const nextOptions = transferPlanningOptions(nextContext);
    const selectedGraduationYear = Number(current.transferExpectedGraduationYear);
    const graduationYearStillValid = selectedGraduationYear >= nextContext.startYear + 1
      && selectedGraduationYear <= nextContext.startYear + 5;
    return {
      ...next,
      transferExpectedGraduationYear: graduationYearStillValid
        ? current.transferExpectedGraduationYear
        : "",
      transferEntryAcademicYear: nextOptions.entryAcademicYears.includes(current.transferEntryAcademicYear)
        ? current.transferEntryAcademicYear
        : ""
    };
  }

  function plannerUrl(view, planId = "") {
    const url = new URL(window.location.href);
    if (view === PLANNER_VIEWS.INPUT) {
      url.searchParams.delete("view");
      url.searchParams.delete("plan");
    } else {
      url.searchParams.set("view", view);
      if (view === PLANNER_VIEWS.PLAN && planId) url.searchParams.set("plan", planId);
      else url.searchParams.delete("plan");
    }
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function navigatePlanner(nextView, nextPlanId = selectedPlanId, { replace = false } = {}) {
    if (planEditInFlightRef.current) {
      planEditRequestRef.current += 1;
      planEditAbortRef.current?.abort();
      planEditAbortRef.current = null;
      planEditInFlightRef.current = false;
      setEditingPlanCourseKey("");
      setPlanEditFeedback(null);
    }
    const plans = economicsResult(report)?.economicsPlans || [];
    const safePlanId = plans.some(plan => plan.id === nextPlanId)
      ? nextPlanId
      : plans[0]?.id || "";
    const safeView = nextView === PLANNER_VIEWS.INPUT || report
      ? nextView
      : PLANNER_VIEWS.INPUT;
    const historyState = {
      econPlanner: true,
      view: safeView,
      planId: safePlanId,
      previousView: plannerView
    };
    if (!replace && plannerView === PLANNER_VIEWS.COMPARE && nextView === PLANNER_VIEWS.PLAN) {
      window.history.replaceState(
        { ...window.history.state, econPlanner: true, view: plannerView, planId: safePlanId },
        "",
        plannerUrl(plannerView, safePlanId)
      );
    }
    window.history[replace ? "replaceState" : "pushState"](
      historyState,
      "",
      plannerUrl(safeView, safePlanId)
    );
    setSelectedPlanId(safePlanId);
    setPlannerView(safeView);
    setPlanEditStatus("");
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    restorationAbortRef.current = controller;
    async function restoreSession() {
      let restoredForm = restorationAttempt ? latestFormRef.current : { ...initialForm, planCreationDate: localToday() };
      let restoredCourseSearch = "";
      let restoredIntakeStep = 1;

      try {
        const saved = restorationAttempt ? null : window.localStorage.getItem(PLANNER_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.formData && Array.isArray(parsed.formData.courses)) {
            const {
              entryCatalogYear: _entryCatalogYear,
              summerStandingConfirmed: _summerStandingConfirmed,
              ...savedFormData
            } = parsed.formData;
            const migrated = migratePlannerInputState(savedFormData);
            const savedPlanCreationDateEdited = savedFormData.planCreationDateEdited === true;
            restoredForm = {
              ...restoredForm,
              ...migrated.formData,
              courses: migrateSavedCourses(migrated.formData.courses),
              planCreationDate: savedPlanCreationDateEdited && migrated.formData.planCreationDate
                ? migrated.formData.planCreationDate
                : localToday(),
              planCreationDateEdited: savedPlanCreationDateEdited
            };
            const savedMigrationNotice = migrated.notices[0]?.message;
            if (savedMigrationNotice) setMigrationNotice(savedMigrationNotice);
          }
          if (typeof parsed.courseSearch === "string") restoredCourseSearch = parsed.courseSearch;
          if (parsed.intakeStep === 2) restoredIntakeStep = 2;
        }
      } catch {
        try { window.localStorage.removeItem(PLANNER_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
      }

      if (!restorationAttempt) {
        setFormData(restoredForm);
        setCourseSearch(restoredCourseSearch);
        setIntakeStep(restoredIntakeStep);
      }

      const requestedView = plannerViewFromSearch(window.location.search);
      let savedSession = recoverableSessionRef.current;
      try {
        savedSession ||= window.sessionStorage.getItem(GENERATED_PLANNER_SESSION_KEY);
      } catch { /* Storage may be disabled. */ }
      const inputSignature = plannerInputSignature(restoredForm);
      const generationRequest = generationRequestRef.current;
      const result = await validateSavedPlannerSession({
        rawSession: savedSession, inputSignature,
        student: { ...restoredForm, courses: selectedCourses(restoredForm.courses) },
        signal: controller.signal,
        onProgress: message => {
          if (cancelled || controller.signal.aborted || generationRequest !== generationRequestRef.current) return;
          setRestorationProgress(message);
          if (restorationAttempt) setStatus(message);
        }
      });
      if (cancelled || controller.signal.aborted
        || generationRequest !== generationRequestRef.current
        || (restorationAttempt && inputSignature !== plannerInputSignature(latestFormRef.current))) return;
      setIsRetryingRestoration(false);
      const restoredSession = result.kind === "restored" ? result.session : null;
      if (result.kind === "unavailable") {
        recoverableSessionRef.current = savedSession;
        setCanRetryRestoration(true);
        setStatus("Saved plans could not be checked right now. Your saved plans and edits are kept. Retry to validate and restore them.");
        setIsHydrated(true);
        return;
      }
      recoverableSessionRef.current = null;
      setCanRetryRestoration(false);
      let initialView = PLANNER_VIEWS.INPUT;
      let initialPlanId = "";
      if (restoredSession) {
        setStatus("");
        reportContextIdRef.current = restoredSession.reportContextId || crypto.randomUUID();
        setReport(restoredSession.report);
        setInputBlock(restoredSession.inputBlock);
        generatedInputSignatureRef.current = restoredSession.inputSignature;
        initialPlanId = new URLSearchParams(window.location.search).get("plan") || restoredSession.selectedPlanId;
        const plans = economicsResult(restoredSession.report)?.economicsPlans || [];
        if (!plans.some(plan => plan.id === initialPlanId)) initialPlanId = plans[0]?.id || "";
        const restoredView = requestedView === PLANNER_VIEWS.INPUT ? restoredSession.view : requestedView;
        initialView = restoredView === PLANNER_VIEWS.PLAN && !plans.length
          ? PLANNER_VIEWS.COMPARE
          : restoredView;
        setSelectedPlanId(initialPlanId);
        setPlannerView(initialView);
        setPlanEditUndo(restoredSession.planEditUndo);
      } else {
        try { window.sessionStorage.removeItem(GENERATED_PLANNER_SESSION_KEY); } catch { /* Storage may be disabled. */ }
        if (savedSession || requestedView !== PLANNER_VIEWS.INPUT) {
          setStatus(result.kind === "invalid"
            ? "The saved plan does not pass current academic checks. Your saved answers are kept; generate new plans."
            : "Your saved answers are kept. Generate new plans to check them against the current policy and schedule.");
        }
      }

      window.history.replaceState(
        { econPlanner: true, view: initialView, planId: initialPlanId, previousView: null },
        "",
        plannerUrl(initialView, initialPlanId)
      );
      window.history.scrollRestoration = "manual";
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      setIsHydrated(true);
    }
    void restoreSession();
    return () => { cancelled = true; controller.abort(); };
  }, [restorationAttempt]);

  useEffect(() => {
    if (!isHydrated) return;

    try {
      window.localStorage.setItem(PLANNER_STORAGE_KEY, JSON.stringify({
        schemaVersion: PLANNER_STORAGE_VERSION,
        formData,
        courseSearch,
        intakeStep
      }));
    } catch {
      // Local storage may be unavailable in restricted browser sessions.
    }
  }, [courseSearch, formData, intakeStep, isHydrated]);

  useEffect(() => {
    if (!isHydrated || !formData.studyAbroadTerm) return;
    const valid = planningSlots.some(slot => slot.id === formData.studyAbroadTerm);
    if (valid) return;
    setFormData(current => {
      const restoredUnits = Number(current.reservationMemory?.[current.studyAbroadTerm] || 0);
      const reservedCourseUnits = { ...(current.reservedCourseUnits || {}) };
      if (current.studyAbroadTerm) reservedCourseUnits[current.studyAbroadTerm] = restoredUnits;
      return {
        ...current,
        studyAbroadTerm: "",
        reservedCourseUnits,
        reservationMemory: {}
      };
    });
  }, [formData.studyAbroadTerm, isHydrated, planningSlotIdSignature]);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      if ((report || inputBlock) && generatedInputSignatureRef.current) {
        recoverableSessionRef.current = null;
        window.sessionStorage.setItem(GENERATED_PLANNER_SESSION_KEY, JSON.stringify(
          createGeneratedPlannerSession({
            report,
            inputBlock,
            inputSignature: generatedInputSignatureRef.current,
            selectedPlanId,
            view: plannerView,
            planEditUndo,
            reportContextId: reportContextIdRef.current
          })
        ));
      } else if (!recoverableSessionRef.current) {
        window.sessionStorage.removeItem(GENERATED_PLANNER_SESSION_KEY);
      }
    } catch {
      // Session storage may be unavailable in restricted browser sessions.
    }
  }, [inputBlock, isHydrated, planEditUndo, plannerView, report, selectedPlanId]);

  useEffect(() => {
    if (!isHydrated) return undefined;

    function handlePlannerHistory(event) {
      const requestedView = event.state?.econPlanner
        ? event.state.view
        : plannerViewFromSearch(window.location.search);
      const plans = economicsResult(report)?.economicsPlans || [];
      const requestedPlanId = event.state?.planId || new URLSearchParams(window.location.search).get("plan");
      if (requestedView === PLANNER_VIEWS.PLAN && !plans.length) {
        setPlannerView(PLANNER_VIEWS.COMPARE);
        setSelectedPlanId("");
        setStatus("");
        window.history.replaceState(
          { econPlanner: true, view: PLANNER_VIEWS.COMPARE, planId: "", previousView: PLANNER_VIEWS.INPUT },
          "",
          plannerUrl(PLANNER_VIEWS.COMPARE)
        );
        return;
      }

      const safePlanId = plans.some(plan => plan.id === requestedPlanId)
        ? requestedPlanId
        : plans[0]?.id || "";
      setSelectedPlanId(safePlanId);
      setPlannerView(requestedView);
      setPlanEditStatus("");
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }

    window.addEventListener("popstate", handlePlannerHistory);
    return () => window.removeEventListener("popstate", handlePlannerHistory);
  }, [isHydrated, report]);

  useEffect(() => () => {
    generationAbortRef.current?.abort();
    planEditAbortRef.current?.abort();
    pdfDownloadAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    pdfDownloadAbortRef.current?.abort();
    pdfDownloadAbortRef.current = null;
    pdfDownloadInFlightRef.current = false;
    pdfOperationRef.current = null;
    setIsDownloadingPdf(false);
    setPdfStatus("");
  }, [selectedPlanId, report, formData]);

  function restoreFocusAfterFailure(target) {
    setFailureFocusTarget(target);
  }

  useEffect(() => {
    const control = failureFocusTarget === "generate"
      ? generateButtonRef.current
      : failureFocusTarget === "download"
        ? downloadButtonRef.current
        : failureFocusTarget === "plan-edit"
          ? planEditTriggerRef.current
          : null;
    if (!control || isGenerating || isDownloadingPdf || editingPlanCourseKey) return;
    setFailureFocusTarget("");
    window.requestAnimationFrame(() => control.focus());
  }, [editingPlanCourseKey, failureFocusTarget, isDownloadingPdf, isGenerating, pdfStatus, planEditStatus, status]);

  useEffect(() => {
    if (editingPlanCourseKey || !planEditFeedback?.controlKey) return;
    const control = document.querySelector(`[data-course-edit-id="${CSS.escape(planEditFeedback.controlKey)}"]`);
    const frame = window.requestAnimationFrame(() => control?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [editingPlanCourseKey, planEditFeedback]);

  function invalidatePlanEdits() {
    planEditRequestRef.current += 1;
    planEditAbortRef.current?.abort();
    planEditAbortRef.current = null;
    planEditInFlightRef.current = false;
    reportContextIdRef.current = null;
    setEditingPlanCourseKey("");
    setPlanEditUndo(null);
    setPlanEditFeedback(null);
    setPlanEditStatus("");
    setFailureFocusTarget("");
  }

  useEffect(() => {
    if ((!report && !inputBlock) || !generatedInputSignatureRef.current) return;
    if (plannerInputSignature(formData) === generatedInputSignatureRef.current) return;
    invalidatePlanEdits();
    generationAbortRef.current?.abort();
    generationInFlightRef.current = false;
    generatedInputSignatureRef.current = "";
    setReport(null);
    setInputBlock(null);
    setSelectedPlanId("");
    setPlannerView(PLANNER_VIEWS.INPUT);
    setPlanEditUndo(null);
    setPlanEditStatus("");
    setIsGenerating(false);
    setStatus("");
    window.history.replaceState(
      { econPlanner: true, view: PLANNER_VIEWS.INPUT, planId: "", previousView: null },
      "",
      plannerUrl(PLANNER_VIEWS.INPUT)
    );
  }, [formData, inputBlock, report]);

  function cancelRestoration() {
    restorationAbortRef.current?.abort();
    setIsRetryingRestoration(false);
    setCanRetryRestoration(false);
  }

  function retryRestoration() {
    setIsRetryingRestoration(true);
    setStatus("Checking saved plans…");
    setRestorationAttempt(attempt => attempt + 1);
  }

  useEffect(() => {
    if (!isHydrated || !recoverableSessionRef.current) return;
    try {
      const saved = JSON.parse(recoverableSessionRef.current);
      if (saved.inputSignature !== plannerInputSignature(formData)) cancelRestoration();
    } catch { cancelRestoration(); }
  }, [formData, isHydrated]);

  function clearInputFeedback() {
    cancelRestoration();
    setStatus("");
    setInputBlock(null);
    setMigrationNotice("");
  }

  function clearAllPlanner() {
    cancelRestoration();
    recoverableSessionRef.current = null;
    invalidatePlanEdits();
    generationAbortRef.current?.abort();
    pdfDownloadAbortRef.current?.abort();
    generationInFlightRef.current = false;
    generatedInputSignatureRef.current = "";
    const blankForm = {
      ...initialForm,
      planCreationDate: localToday(),
      courses: SELECTABLE_COURSE_CATALOG.map(blankCourse)
    };
    try {
      window.localStorage.removeItem(PLANNER_STORAGE_KEY);
      window.sessionStorage.removeItem(GENERATED_PLANNER_SESSION_KEY);
    } catch {
      // Browser storage may be unavailable in restricted sessions.
    }
    setFormData(blankForm);
    setCourseSearch("");
    setCompletionSourceCourseCode("");
    setIntakeStep(1);
    setMigrationNotice("");
    setInputBlock(null);
    setStatus("");
    setReport(null);
    setPlannerView(PLANNER_VIEWS.INPUT);
    setSelectedPlanId("");
    setPlanEditUndo(null);
    setPlanEditStatus("");
    setPdfStatus("");
    setIsGenerating(false);
    setIsDownloadingPdf(false);
    setClearDialogOpen(false);
    window.history.replaceState(
      { econPlanner: true, view: PLANNER_VIEWS.INPUT, planId: "", previousView: null },
      "",
      plannerUrl(PLANNER_VIEWS.INPUT)
    );
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  function changeStudyAbroadTerm(nextTermId) {
    setFormData(current => {
      const reservedCourseUnits = { ...(current.reservedCourseUnits || {}) };
      const reservationMemory = { ...(current.reservationMemory || {}) };
      if (current.studyAbroadTerm) {
        reservedCourseUnits[current.studyAbroadTerm] = Number(reservationMemory[current.studyAbroadTerm] || 0);
        delete reservationMemory[current.studyAbroadTerm];
      }
      if (nextTermId) {
        const nextSlot = planningSlots.find(slot => slot.id === nextTermId);
        reservationMemory[nextTermId] = Number(reservedCourseUnits[nextTermId] || 0);
        reservedCourseUnits[nextTermId] = termReservationLimit(nextSlot);
      }
      return {
        ...current,
        studyAbroadTerm: nextTermId,
        reservedCourseUnits,
        reservationMemory
      };
    });
    clearInputFeedback();
  }

  function setCourseStatus(code, nextStatus) {
    setFormData(current => ({
      ...current,
      courses: current.courses.map(course => {
        if (course.code !== code) return course;
        const currentVisibleStatus = visibleCourseStatus(course);
        const status = currentVisibleStatus === nextStatus ? "not_started" : nextStatus;
        return {
          ...course,
          status,
          source: "manual_code"
        };
      })
    }));
    setCompletionSourceCourseCode(current => current === code ? "" : current);
    clearInputFeedback();
  }

  function setCompletionSource(code, source) {
    setFormData(current => ({
      ...current,
      courses: current.courses.map(course => course.code === code
        ? {
            ...course,
            status: source === "transfer_equivalency_unapproved" ? "transfer" : "completed",
            source
          }
        : course)
    }));
    clearInputFeedback();
  }

  function chooseStanding(academicStanding) {
    setFormData(current => {
      const candidate = {
        ...current,
        academicStanding,
        isTransferStudent: false,
        transferExpectedGraduationYear: "",
        transferEntryAcademicYear: ""
      };
      const candidateContext = resolvePlanningContext(candidate);
      return {
        ...candidate,
        planningPace: candidateContext.oneYearEarlyEligible
          ? current.planningPace
          : PLANNING_PACES.STANDARD
      };
    });
    clearInputFeedback();
  }

  function focusAttention(item) {
    if (item.step) setIntakeStep(item.step);
    window.requestAnimationFrame(() => {
      const target = document.getElementById(item.target);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus();
    });
  }

  function continueToCourses() {
    if (!formData.academicStanding) {
      setStatus("Choose your class standing to continue.");
      focusAttention({ step: 1, target: "standing-freshman", message: "Choose your class standing." });
      return;
    }
    if (formData.isTransferStudent && !planningContext.transferValidation.valid) {
      setStatus(planningContext.transferValidation.errors[0]);
      focusAttention({
        step: 1,
        target: !formData.transferExpectedGraduationYear ? "custom-graduation-year" : "custom-entry-year",
        message: planningContext.transferValidation.errors[0]
      });
      return;
    }
    if (formData.customGraduationEnabled && !planningContext.customGraduationValidation.valid) {
      setStatus(planningContext.customGraduationValidation.errors[0]);
      focusAttention({
        step: 1,
        target: "custom-graduation-year",
        message: planningContext.customGraduationValidation.errors[0]
      });
      return;
    }
    setStatus("");
    setIntakeStep(2);
    window.requestAnimationFrame(() => document.getElementById("course-search")?.focus());
  }

  async function mapMajors(event) {
    event?.preventDefault();

    if (generationInFlightRef.current) return;

    if (!formData.academicStanding) {
      setStatus("Choose your class standing before generating your plans.");
      focusAttention({ step: 1, target: "standing-freshman", message: "Choose your class standing." });
      return;
    }

    if (!formData.planCreationDate) {
      setStatus("Enter the plan creation date before generating a plan.");
      focusAttention({ step: 1, target: "plan-creation-date", message: "Enter the plan creation date." });
      return;
    }

    if (formData.isTransferStudent && !planningContext.transferValidation.valid) {
      setStatus(planningContext.transferValidation.errors[0]);
      focusAttention({
        step: 1,
        target: !formData.transferExpectedGraduationYear ? "custom-graduation-year" : "custom-entry-year",
        message: planningContext.transferValidation.errors[0]
      });
      return;
    }
    if (formData.customGraduationEnabled && !planningContext.customGraduationValidation.valid) {
      setStatus(planningContext.customGraduationValidation.errors[0]);
      focusAttention({
        step: 1,
        target: "custom-graduation-year",
        message: planningContext.customGraduationValidation.errors[0]
      });
      return;
    }

    if (!planningContext.planningValidation.valid) {
      setStatus(planningContext.planningValidation.errors[0]);
      return;
    }

    if (unansweredDependentQuestions.length > 0) {
      setStatus("Answer the highlighted prerequisite questions before generating plans.");
      focusAttention({
        step: 2,
        target: unansweredDependentQuestions[0].id,
        message: `Answer the ${unansweredDependentQuestions[0].course} prerequisite question about ${unansweredDependentQuestions[0].options.join(" or ")}.`
      });
      return;
    }

    if (!inputPrerequisiteValidation.valid) {
      setStatus("Correct the highlighted prerequisite issues before generating a plan.");
      focusAttention({
        step: 2,
        target: `course-${domId(inputPrerequisiteValidation.issues[0]?.course)}`,
        message: inputPrerequisiteValidation.issues[0]?.message || "Review the prerequisite information."
      });
      return;
    }

    cancelRestoration();
    invalidatePlanEdits();
    reportContextIdRef.current = crypto.randomUUID();
    generationInFlightRef.current = true;
    setIsGenerating(true);
    setStatus("Building your economics plan...");
    setPlanEditStatus("");

    const student = {
      ...formData,
      courses: selectedCourses(formData.courses)
    };
    const requestSignature = plannerInputSignature(formData);
    const requestId = generationRequestRef.current + 1;
    generationRequestRef.current = requestId;
    generationAbortRef.current?.abort();
    const controller = new AbortController();
    generationAbortRef.current = controller;

    try {
      const response = await fetch("/api/majors/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ student }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => {
        throw new Error("The planner returned an invalid response. Please try again.");
      });
      if (requestId !== generationRequestRef.current || controller.signal.aborted) return;
      if (!response.ok && data.economicsPlanResult?.category === "INPUT_BLOCKED") {
        generatedInputSignatureRef.current = requestSignature;
        setInputBlock(data);
        setReport(null);
        setSelectedPlanId("");
        setPlannerView(PLANNER_VIEWS.COMPARE);
        window.history.pushState(
          { econPlanner: true, view: PLANNER_VIEWS.COMPARE, planId: "", previousView: plannerView },
          "",
          plannerUrl(PLANNER_VIEWS.COMPARE)
        );
        setStatus("");
        window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
        return;
      }
      if (!response.ok) throw new Error(data.error || "The planner could not complete.");
      if (plannerInputSignature(latestFormRef.current) !== requestSignature) {
        setStatus("Your answers changed while plans were being generated. Generate again with the current answers.");
        return;
      }

      if (!isValidGeneratedPlannerReport(data)) {
        throw new Error("The planner returned an invalid response. Please try again.");
      }
      const plans = economicsResult(data).economicsPlans;
      const firstPlanId = plans[0]?.id || "";
      generatedInputSignatureRef.current = requestSignature;
      setIsComparisonExiting(false);
      setInputBlock(null);
      setReport(data);
      setSelectedPlanId(firstPlanId);
      setPlanEditStatus(plans.length ? "Plans generated." : "Plan review ready.");
      setPlannerView(PLANNER_VIEWS.COMPARE);
      setPlanEditUndo(null);
      window.history.pushState(
        {
          econPlanner: true,
          view: PLANNER_VIEWS.COMPARE,
          planId: firstPlanId,
          previousView: plannerView
        },
        "",
        plannerUrl(PLANNER_VIEWS.COMPARE, firstPlanId)
      );
      setStatus("");
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      });
    } catch (error) {
      if (requestId === generationRequestRef.current) {
        setStatus(studentFacingRequestError(error, "The planner could not complete. Please try again."));
        restoreFocusAfterFailure("generate");
      }
    } finally {
      if (requestId === generationRequestRef.current) {
        generationInFlightRef.current = false;
        generationAbortRef.current = null;
        setIsGenerating(false);
      }
    }
  }

  async function downloadSelectedPlanPdf() {
    if (pdfDownloadInFlightRef.current) return;
    const selectedPlan = (economicsResult(report)?.economicsPlans || [])
      .find(plan => plan.id === selectedPlanId);
    if (!selectedPlan) {
      setPdfStatus("Choose a plan before downloading its PDF.");
      return;
    }

    pdfDownloadInFlightRef.current = true;
    const controller = new AbortController();
    pdfDownloadAbortRef.current = controller;
    setIsDownloadingPdf(true);
    setPdfStatus("Creating your PDF...");
    if (!pdfOperationRef.current) {
      pdfOperationRef.current = {
        student: { ...formData, courses: selectedCourses(formData.courses) },
        preparedDate: formData.planCreationDate,
        selectedPlan,
        plans: economicsResult(report)?.economicsPlans || [],
        format: "pdf",
        downloadOperationId: crypto.randomUUID()
      };
    }
    try {
      const response = await fetch("/api/reports/economics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pdfOperationRef.current),
        signal: controller.signal
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (result.code === "PDF_REPORT_CHANGED") pdfOperationRef.current = null;
        throw new Error(result.error || "The PDF could not be created.");
      }
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf")) {
        throw new Error("The PDF service returned an invalid response.");
      }

      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = "EconPlanner-Economics-Plan.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setPdfStatus("PDF ready. Download started.");
      pdfOperationRef.current = null;
    } catch (error) {
      if (controller.signal.aborted) return;
      setPdfStatus(studentFacingRequestError(error, "The PDF could not be created.", "The PDF service could not connect. Please try again.", "PDF creation"));
      restoreFocusAfterFailure("download");
    } finally {
      if (pdfDownloadAbortRef.current === controller) {
        pdfDownloadAbortRef.current = null;
        pdfDownloadInFlightRef.current = false;
        setIsDownloadingPdf(false);
      }
    }
  }

  const query = courseSearch.trim().toLowerCase();
  const visibleGroups = COURSE_DISPLAY_GROUPS.filter(group =>
    !query || `${group.code} ${group.title} ${(group.options || []).map(option => `${option.code} ${option.title}`).join(" ")}`.toLowerCase().includes(query)
  );
  const declarationCourseGroups = visibleGroups.filter(group => DECLARATION_COURSE_IDS.includes(group.id));
  const declarationRequirementGroups = visibleGroups.filter(group => DECLARATION_REQUIREMENT_IDS.includes(group.id));
  const sortCourseGroups = groups => [...groups].sort((a, b) => courseLevel(a.code) - courseLevel(b.code) || a.code.localeCompare(b.code));
  const financeGroups = visibleGroups.filter(group => group.id === "finance-requirement");
  const secondaryCourseGroups = sortCourseGroups(visibleGroups.filter(group => !new Set([
    ...DECLARATION_COURSE_IDS,
    ...DECLARATION_REQUIREMENT_IDS,
    "finance-requirement"
  ]).has(group.id)));
  const attentionItems = [];
  if (!formData.academicStanding) {
    attentionItems.push({ step: 1, target: "standing-freshman", message: "Choose your class standing." });
  }
  if (formData.isTransferStudent && !formData.transferExpectedGraduationYear) {
    attentionItems.push({ step: 1, target: "custom-graduation-year", message: "Choose your expected graduation year." });
  }
  if (formData.isTransferStudent && !formData.transferEntryAcademicYear) {
    attentionItems.push({ step: 1, target: "custom-entry-year", message: "Choose when you first enrolled at Hanover." });
  }
  if (formData.customGraduationEnabled && !formData.customExpectedGraduationYear) {
    attentionItems.push({ step: 1, target: "custom-graduation-year", message: "Choose your expected graduation year." });
  }
  for (const issue of inputPrerequisiteValidation.issues) {
    attentionItems.push({
      step: 2,
      target: `course-${domId(issue.course)}`,
      message: issue.message
    });
  }
  for (const question of unansweredDependentQuestions) {
    attentionItems.push({
      step: 2,
      target: question.id,
      message: `Answer the ${question.course} prerequisite question about ${question.options.join(" or ")}.`
    });
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      Object.values(courseAccordionRefs.current).forEach(node => {
        if (node) node.open = Boolean(query);
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [query]);

  function renderCourseAccordion(id, label, groups) {
    if (!groups.length) return null;
    return (
      <details
        className="course-accordion"
        key={`${id}-${query}`}
        ref={node => {
          courseAccordionRefs.current[id] = node;
        }}
      >
        <summary>
          <span className="course-accordion-title">{label}</span>
          <span className="course-accordion-count">{groups.length} courses</span>
        </summary>
        {renderCourseColumns(groups)}
      </details>
    );
  }

  function renderStatusControls(code, labelPrefix = code, compact = false, includeUncertain = false) {
    const course = formData.courses.find(item => item.code === code) || blankCourse({ code, title: courseTitle(code), units: 1 });
    const activeStatus = visibleCourseStatus(course);
    const statusChoices = [
      ["completed", "Completed"],
      ["in_progress", "Taking now"],
      ...(includeUncertain ? [["uncertain", "Not taken / not sure"]] : [])
    ];
    return (
      <div className={`course-toggles${compact ? " is-compact" : ""}${includeUncertain ? " has-three" : ""}`} role="group" aria-label={`Status for ${labelPrefix}`}>
        {statusChoices.map(([value, label]) => {
          const selected = activeStatus === value;
          return (
            <button
              type="button"
              className={`course-toggle is-${value}${selected ? " is-selected" : ""}`}
              aria-pressed={selected}
              key={value}
              onClick={() => setCourseStatus(code, value)}
            >
              <span className="selection-check" aria-hidden="true">{selected ? "✓" : ""}</span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  function renderPrerequisiteFollowUp(course) {
    const targetStatus = course.status;
    if (!["completed", "transfer", "in_progress"].includes(targetStatus)) return null;
    const followUp = buildPrerequisiteFollowUp({
      course: course.code,
      targetStatus,
      courses: formData.courses,
      prerequisites: COURSE_PREREQUISITES
    });
    if (!followUp.required && !followUp.conditionalApprovals.length) return null;
    const hasExplicitConflict = followUp.questions.some(hasExplicitPrerequisiteConflict);

    return (
      <div className={`inline-prerequisite${hasExplicitConflict ? " has-conflict" : ""}`}>
        {followUp.questions.length > 0 && (
          <p role="status"><strong>Before we can use {course.code}, tell us about {followUp.questions.length === 1 ? "this prerequisite" : "these prerequisites"}.</strong></p>
        )}
        {followUp.questions.map(question => (
          <section
            className="prerequisite-question"
            id={question.id}
            tabIndex={-1}
            key={question.id}
            aria-labelledby={`${question.id}-label`}
          >
            <div id={`${question.id}-label`} className="prerequisite-question-heading">
              <strong>{question.kind === "one_of" ? "Choose a prerequisite option" : "Required course"}</strong>
            </div>
            {question.options.map(option => (
              <div className="prerequisite-option" key={option}>
                <div className="prerequisite-name">
                  <strong>{option}</strong>
                  <small>{courseTitle(option)}</small>
                </div>
                {renderStatusControls(option, `prerequisite ${option}`, true, true)}
              </div>
            ))}
            {hasExplicitPrerequisiteConflict(question) && (
              <div className="prerequisite-conflict">
                <p role="alert">{question.issueMessage}</p>
                <p>You marked {course.code} as {prerequisiteStatusLabel(targetStatus)}, but {explicitPrerequisiteStatusText(question)}.</p>
                <p>Update one of these course statuses before generating your plan.</p>
              </div>
            )}
          </section>
        ))}
        {followUp.conditionalApprovals.map(approval => (
          <p className="prerequisite-approval" key={`${approval.course}-${approval.prerequisite}`}>{approval.message}</p>
        ))}
      </div>
    );
  }

  function renderCourseRow(code, title) {
    const course = formData.courses.find(item => item.code === code);
    const isHanoverOnly = NON_SELECTABLE_COURSE_CODES.has(code);
    if (!course && !isHanoverOnly) return null;
    const completed = course ? visibleCourseStatus(course) === "completed" : false;
    const source = course ? completionSourceLabel(course) : "Hanover College";
    const sourceChoicesOpen = completionSourceCourseCode === code;
    const sourcePanelId = `completion-source-${domId(code)}`;
    return (
      <div className="course-row" id={`course-${domId(code)}`} key={code} tabIndex={-1}>
        <div className="course-row-main">
          <div className="course-name">
            <strong>{code}</strong>
            <span>{title}</span>
          </div>
          {isHanoverOnly ? (
            <span className="course-status-note">Must be taken at Hanover College</span>
          ) : renderStatusControls(code)}
        </div>
        {completed && (
          <div className="completion-source">
            <button
              type="button"
              className="completion-source-trigger"
              aria-expanded={sourceChoicesOpen}
              aria-controls={sourcePanelId}
              onClick={() => setCompletionSourceCourseCode(current => current === code ? "" : code)}
            >
              Transfer or AP credit?
            </button>
            {source !== "Hanover College" && <span className="completion-source-current">Selected: {source}</span>}
            {sourceChoicesOpen && (
              <div className="completion-source-panel" id={sourcePanelId}>
                <div className="completion-source-options" role="group" aria-label={`Completion source for ${code}`}>
                  {[
                    ["manual_code", "Hanover College"],
                    ["transfer_equivalency_unapproved", "Another college / transfer credit"],
                    ...(AP_CREDIT_ALLOWED_COURSE_CODES.has(code) ? [["ap_credit", "AP or exam credit"]] : [])
                  ].map(([value, label]) => {
                    const selected = value === "transfer_equivalency_unapproved"
                      ? course.status === "transfer"
                      : value === "manual_code"
                        ? course.status === "completed" && completionSourceLabel(course) === "Hanover College"
                        : course.status === "completed" && course.source === value;
                    return (
                      <button
                        type="button"
                        className={selected ? "is-selected" : ""}
                        aria-pressed={selected}
                        key={value}
                        onClick={() => setCompletionSource(code, value)}
                      >
                        <span className="selection-check" aria-hidden="true">{selected ? "✓" : ""}</span>
                        {label}
                      </button>
                    );
                  })}
                </div>
                {source !== "Hanover College" && (
                  <p>This credit will stay review-required until its supporting evidence is approved.</p>
                )}
              </div>
            )}
          </div>
        )}
        {course && renderPrerequisiteFollowUp(course)}
      </div>
    );
  }

  function renderCourseGroup(group) {
    if (group.options) {
      return (
        <section className="course-requirement-group" key={group.id} aria-labelledby={`${domId(group.id)}-heading`}>
          <div className="course-requirement-heading" id={`${domId(group.id)}-heading`}>
            <strong>{group.title}</strong>
            <span>Choose the course that applies to you.</span>
          </div>
          {group.options.map(option => renderCourseRow(option.code, option.title))}
        </section>
      );
    }
    return renderCourseRow(group.courseCodes[0], group.title);
  }

  function renderCourseColumns(groups, stackInFirstColumn = false) {
    const midpoint = stackInFirstColumn ? groups.length : Math.ceil(groups.length / 2);
    const leftGroups = groups.slice(0, midpoint);
    const rightGroups = groups.slice(midpoint);
    return (
      <div className="course-columns" style={COURSE_COLUMNS_STYLE}>
        <div className="course-column">{leftGroups.map(renderCourseGroup)}</div>
        <div className="course-column">{rightGroups.map(renderCourseGroup)}</div>
      </div>
    );
  }

  function navigateBackTo(targetView) {
    // Keep in-app navigation in React. A native history traversal can remount
    // Next before the saved view updates and restore the comparison instead.
    navigatePlanner(targetView, selectedPlanId, { replace: true });
  }

  async function editPlanCourse(edit, trigger) {
    if (planEditInFlightRef.current || generationInFlightRef.current) return;
    planEditInFlightRef.current = true;
    planEditTriggerRef.current = trigger;
    const requestId = ++planEditRequestRef.current;
    const controller = new AbortController();
    planEditAbortRef.current = controller;
    const inputSignature = plannerInputSignature(formData);
    const reportContextId = reportContextIdRef.current;
    const sourceReport = report;
    const isCurrent = () => requestId === planEditRequestRef.current
      && !controller.signal.aborted
      && reportContextId === reportContextIdRef.current
      && sourceReport === latestReportRef.current
      && inputSignature === plannerInputSignature(latestFormRef.current);

    try {
      const result = economicsResult(report);
      const plans = result?.economicsPlans || [];
      const sourcePlan = plans.find(plan => plan.id === edit.planId);
      if (!sourcePlan || (edit.type === "move" && edit.fromTermId === edit.toTermId)) return;

      const sourceTerm = sourcePlan.terms.find(term => (term.slotId || term.term) === edit.fromTermId);
      const selectedCourse = sourceTerm?.courses.find(course => planCourseIdentity(course) === edit.courseId);
      if (!selectedCourse) {
        setPlanEditStatus("That course could not be found in the selected plan.");
        return;
      }

      const editKey = `${sourcePlan.id}:${edit.fromTermId}:${edit.courseId}`;

      setEditingPlanCourseKey(editKey);
      setPlanEditFeedback(null);
      setPlanEditStatus("Checking change…");
      try {
        const response = await fetch("/api/majors/map", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "validate-plan",
            student: {
              ...formData,
              courses: selectedCourses(formData.courses)
            },
            plan: compactEconomicsPlanForValidation(sourcePlan),
            plans: plans.map(compactEconomicsPlanForValidation),
            edit
          }),
          signal: controller.signal
        });
        const data = await response.json().catch(() => ({}));
        if (!isCurrent()) return;
        if (!response.ok) throw new Error(data.error || "The plan edit could not be validated.");
        if (!data.plan?.validation?.valid) {
          throw new Error(data.plan?.validation?.errors?.[0] || "That plan change violates the Economics planning rules.");
        }
        if (data.planSetValidation?.valid !== true) {
          throw new Error(data.planSetValidation?.errors?.[0] || "That plan change would make the comparison invalid.");
        }

        setPlanEditUndo({
          inputSignature, reportContextId,
          planId: sourcePlan.id,
          courseId: edit.courseId,
          plan: sourcePlan,
          planSetValidation: result.economicsPlanValidation
        });
        const nextReport = replaceEconomicsPlan(sourceReport, sourcePlan.id, data.plan, data.planSetValidation);
        latestReportRef.current = nextReport;
        setReport(nextReport);
        const targetTerm = data.plan.terms.find(term => (term.slotId || term.term) === (edit.toTermId || edit.fromTermId));
        const changedCourse = targetTerm?.courses.find(course => planCourseIdentity(course) === edit.courseId);
        const resultMessage = `${edit.type === "move" ? `Moved to ${targetTerm?.term || "selected term"}` : "Course updated"}.${changedCourse?.publicationStatus === "PLANNING_PROJECTION" ? "" : " Plan checks pass."}`;
        setPlanEditStatus("");
        setPlanEditFeedback({ planId: sourcePlan.id, fromTermId: edit.toTermId || edit.fromTermId, courseId: edit.courseId, message: resultMessage, controlKey: `${sourcePlan.id}:${edit.courseId}:change` });
        return true;
      } catch (error) {
        if (!isCurrent()) return;
        const message = studentFacingRequestError(
          error,
          "The plan edit could not be validated.",
          "The plan edit could not be validated. Please try again."
        );
        setPlanEditStatus("Change could not be saved.");
        setPlanEditFeedback({ planId: sourcePlan.id, fromTermId: edit.fromTermId, courseId: edit.courseId, message, failed: true });
        restoreFocusAfterFailure("plan-edit");
      } finally {
        if (requestId === planEditRequestRef.current) setEditingPlanCourseKey("");
      }
    } finally {
      if (requestId === planEditRequestRef.current) {
        planEditInFlightRef.current = false;
        planEditAbortRef.current = null;
      }
    }
  }

  function undoPlanEdit() {
    if (!planEditUndo || planEditInFlightRef.current || generationInFlightRef.current) return;
    if (planEditUndo.reportContextId !== reportContextIdRef.current
      || planEditUndo.inputSignature !== plannerInputSignature(formData)) return;
    const restoredPlan = planEditUndo.plan;
    setReport(current => replaceEconomicsPlan(
      current,
      planEditUndo.planId,
      restoredPlan,
      planEditUndo.planSetValidation
    ));
    const restoredTerm = restoredPlan.terms.find(term => term.courses.some(course => planCourseIdentity(course) === planEditUndo.courseId));
    setPlanEditFeedback(restoredTerm ? { planId: restoredPlan.id, fromTermId: restoredTerm.slotId || restoredTerm.term,
      courseId: planEditUndo.courseId, message: "Change undone.", controlKey: `${restoredPlan.id}:${planEditUndo.courseId}:change` } : null);
    setPlanEditUndo(null);
    setPlanEditStatus(restoredTerm ? "" : `${restoredPlan.label} was restored.`);
  }

  function returnToInputStep(step) {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const finish = () => {
      setStatus("");
      setInputBlock(null);
      setIntakeStep(step);
      setPlanEditStatus("");
      setIsComparisonExiting(false);
      navigateBackTo(PLANNER_VIEWS.INPUT);
    };

    if (reducedMotion) {
      finish();
      return;
    }
    setIsComparisonExiting(true);
    window.setTimeout(finish, 240);
  }

  function returnToCourseSelection() {
    returnToInputStep(2);
  }

  if (!isHydrated) {
    return (
      <main className="planner-loading" aria-busy="true" aria-label="Loading EconPlanner">
        <p role="status" aria-live="polite">{restorationProgress || "Loading EconPlanner…"}</p>
        <style jsx global>{`
          body { margin: 0; background: #f7f8fa; }
          .planner-loading { min-height: 100vh; padding: 2rem; box-sizing: border-box; color: #344054; }
        `}</style>
      </main>
    );
  }

  if (isHydrated && (report || inputBlock) && plannerView !== PLANNER_VIEWS.INPUT) {
    return (
      <>
        <PlanComparisonScreen
          report={report}
          planResult={inputBlock?.economicsPlanResult}
          fallbackPlanningContext={planningContext}
          courses={formData.courses}
          displayName={formData.displayName}
          view={plannerView}
          selectedPlanId={selectedPlanId}
          isExiting={isComparisonExiting}
          isGenerating={isGenerating}
          editingPlanCourseKey={editingPlanCourseKey}
          planEditStatus={planEditStatus}
          planEditFeedback={planEditFeedback}
          canUndoPlanEdit={planEditUndo?.planId === selectedPlanId ? (planEditUndo.courseId || "__plan__") : null}
          onEditCourses={returnToCourseSelection}
          onReviewTimeline={() => returnToInputStep(1)}
          onClearAll={() => setClearDialogOpen(true)}
          onBackToCompare={() => navigateBackTo(PLANNER_VIEWS.COMPARE)}
          onChoosePlan={planId => navigatePlanner(PLANNER_VIEWS.PLAN, planId)}
          onSelectPlan={planId => navigatePlanner(PLANNER_VIEWS.PLAN, planId)}
          onRegenerate={() => mapMajors()}
          onDownloadPdf={downloadSelectedPlanPdf}
          downloadButtonRef={downloadButtonRef}
          isDownloadingPdf={isDownloadingPdf}
          pdfStatus={pdfStatus}
          onEditPlanCourse={editPlanCourse}
          onUndoPlanEdit={undoPlanEdit}
        />
        <ClearAllDialog open={clearDialogOpen} onCancel={() => setClearDialogOpen(false)} onConfirm={clearAllPlanner} />
      </>
    );
  }

  return (
    <>
    <main className="container cp7-container">
      <style jsx global>{`
        :root {
          --cp7-ink: #18202b;
          --cp7-muted: #5b6470;
          --cp7-border: #ddd8e4;
          --cp7-border-strong: #8a8096;
          --cp7-surface: #ffffff;
          --cp7-soft: #f7f5f9;
          --cp7-selected: #f0edf7;
          --cp7-accent: #4b2e83;
          --cp7-accent-dark: #2f1c57;
          --cp7-aqua: #2a8f9e;
          --cp7-gold: #b77912;
          --cp7-warning: #fff8e8;
          --cp7-warning-border: #c18b2d;
          --cp7-danger: #8a2c25;
        }
        body {
          margin: 0;
          background: #f1f3f5 !important;
          color: var(--cp7-ink) !important;
          font-family: Arial, sans-serif;
        }
        main.cp7-container {
          box-sizing: border-box;
          width: min(1180px, calc(100% - 2rem));
          max-width: none;
          margin: 0 auto;
          padding: 0 0 4rem;
          color: var(--cp7-ink);
          font-size: 15px;
        }
        main.cp7-container *, main.cp7-container *::before, main.cp7-container *::after { box-sizing: border-box; }
        main.cp7-container button,
        main.cp7-container input,
        main.cp7-container select { font-size: inherit; }
        main.cp7-container button:focus-visible,
        main.cp7-container input:focus-visible,
        main.cp7-container select:focus-visible,
        main.cp7-container summary:focus-visible,
        main.cp7-container [tabindex]:focus-visible {
          outline: 3px solid var(--cp7-aqua);
          outline-offset: 3px;
        }
        .cp7-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 2rem;
          padding: 1rem 0;
          border-bottom: 1px solid var(--cp7-border);
        }
        .cp7-brand-block { display: flex; align-items: flex-start; flex: 0 0 auto; flex-direction: column; gap: .35rem; }
        .cp7-brand-logo { display: block; width: 168px; height: auto; }
        .cp7-brand { margin: 0; color: var(--cp7-accent); font-size: 21px; letter-spacing: -.02em; }
        .cp7-progress ol { display: flex; gap: .4rem; margin: 0; padding: 0; list-style: none; }
        .cp7-progress li {
          display: flex;
          align-items: center;
          gap: .4rem;
          padding: .35rem .55rem;
          color: var(--cp7-muted);
          font-size: 15.6px;
        }
        .cp7-progress li::before {
          width: .52rem;
          height: .52rem;
          border: 1px solid #98a1ab;
          border-radius: 50%;
          background: #fff;
          content: "";
        }
        .cp7-progress li.is-current { color: var(--cp7-ink); font-weight: 700; }
        .cp7-progress li.is-current::before,
        .cp7-progress li.is-complete::before { border-color: var(--cp7-accent); background: var(--cp7-accent); }
        .cp7-progress button {
          margin: 0;
          padding: 0;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
        }
        .cp7-page-heading { padding: 2rem 0 1.25rem; }
        .cp7-page-heading h1 {
          margin: 0;
          color: var(--cp7-ink);
          font-size: clamp(28px, 4vw, 40px);
          letter-spacing: -.035em;
          line-height: 1.08;
        }
        .cp7-page-heading p { max-width: 46rem; margin: .55rem 0 0; color: var(--cp7-muted); font-size: 16px; line-height: 1.5; }
        .cp7-intake-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 1.25rem;
          align-items: start;
        }
        .cp7-left { min-width: 0; }
        main.cp7-container .cp7-task-card,
        main.cp7-container .cp7-summary {
          padding: 1.35rem;
          border: 1px solid var(--cp7-border);
          border-radius: 10px;
          background: var(--cp7-surface);
          box-shadow: 0 3px 12px rgba(27, 39, 51, .045);
        }
        .cp7-task-card h2,
        main.cp7-container .cp7-summary h2 { margin: 0; color: var(--cp7-ink); font-size: 23px; line-height: 1.2; }
        .cp7-task-intro { margin: .45rem 0 1.35rem; color: var(--cp7-muted); line-height: 1.5; }
        .cp7-question-label { display: block; margin-bottom: .65rem; font-weight: 700; }
        .standing-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .55rem; }
        main.cp7-container .standing-option,
        main.cp7-container .early-toggle,
        main.cp7-container .custom-timeline-trigger,
        main.cp7-container .standard-timeline-trigger,
        main.cp7-container .secondary-action {
          width: auto;
          min-height: 44px;
          margin: 0;
          padding: .65rem .8rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 7px;
          background: #fff;
          color: var(--cp7-ink);
          cursor: pointer;
        }
        main.cp7-container .standing-option.is-selected,
        main.cp7-container .early-toggle.is-selected {
          border-color: transparent;
          background: var(--cp7-selected);
          font-weight: 700;
        }
        .standing-feedback { margin: .75rem 0 0; padding: .7rem .8rem; border-left: 3px solid var(--cp7-aqua); background: var(--cp7-soft); color: #344151; }
        .early-option, .custom-timeline-disclosure { margin-top: 1.25rem; padding-top: 1.1rem; border-top: 1px solid var(--cp7-border); }
        .current-term-option { margin-top: 1rem; padding: .75rem .85rem; border: 1px solid var(--cp7-border); border-radius: 7px; background: var(--cp7-soft); }
        .current-term-option label { display: flex; align-items: flex-start; gap: .65rem; min-width: 0; line-height: 1.45; }
        .current-term-option input { flex: 0 0 auto; width: 18px; height: 18px; margin-top: .12rem; accent-color: var(--cp7-accent); }
        .current-term-option input:focus-visible { outline: 3px solid var(--cp7-aqua); outline-offset: 3px; }
        .current-term-option span { min-width: 0; overflow-wrap: anywhere; }
        main.cp7-container .early-toggle { display: inline-flex; align-items: center; gap: .55rem; text-align: left; }
        .early-option p, .custom-timeline-copy { margin: .4rem 0 0; color: var(--cp7-muted); font-size: 14px; line-height: 1.45; }
        main.cp7-container .custom-timeline-trigger,
        main.cp7-container .standard-timeline-trigger { border-color: transparent; padding-left: 0; color: var(--cp7-accent); font-weight: 700; }
        .catalog-planning-note { margin-top: 1.1rem; padding: .8rem .9rem; border-left: 3px solid var(--cp7-gold); background: #fffaf0; color: #473c2d; line-height: 1.45; }
        .catalog-planning-note p { margin: .3rem 0 0; font-size: 13px; }
        .custom-timeline-panel {
          display: grid;
          gap: 1rem;
          margin-top: .65rem;
          padding: 1rem;
          border: 1px solid var(--cp7-border);
          border-radius: 8px;
          background: var(--cp7-soft);
        }
        .custom-fields, .advanced-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .85rem; }
        .custom-fields label, .advanced-fields label {
          display: grid;
          gap: .4rem;
          color: #303a46;
          font-weight: 700;
        }
        .custom-fields select, .advanced-fields input, .advanced-fields select {
          width: 100%;
          min-height: 42px;
          padding: .55rem .65rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 6px;
          background: #fff;
          color: var(--cp7-ink);
          font-weight: 400;
        }
        .custom-target { margin: 0; color: #344151; }
        .custom-errors { margin: 0; padding-left: 1.2rem; color: var(--cp7-danger); }
        .more-details { margin-top: 1.25rem; border-top: 1px solid var(--cp7-border); padding-top: 1rem; }
        .more-details > summary { color: var(--cp7-accent); cursor: pointer; font-weight: 700; }
        .advanced-fields { margin-top: 1rem; }
        .advanced-fields .wide-field { grid-column: 1 / -1; }
        .non-major-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; margin-top: .75rem; }
        .non-major-fields label, .study-abroad-fields label { display: grid; gap: .3rem; font-size: 13px; font-weight: 700; }
        .non-major-fields select, .study-abroad-fields select { min-height: 40px; padding: .45rem .55rem; border: 1px solid var(--cp7-border-strong); border-radius: 6px; background: #fff; }
        .study-abroad-fields { display: grid; gap: .65rem; margin: .9rem 0; padding: .8rem; border: 1px solid #cae0e4; border-radius: 8px; background: #f2fafb; }
        .study-abroad-fields p { margin: 0; color: #285b63; }
        main.cp7-container .study-abroad-toggle { display: inline-flex; width: fit-content; min-height: 42px; align-items: center; gap: .4rem; padding: .55rem .7rem; border: 1px solid #8ab7bf; border-radius: 7px; background: #fff; color: #24434a; font-weight: 700; cursor: pointer; }
        main.cp7-container .study-abroad-toggle.is-selected { border-color: transparent; background: #e2f2f4; }
        .step-two-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
        main.cp7-container .secondary-action { flex: 0 0 auto; color: #244f85; }
        .course-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; align-items: end; margin: 1rem 0 1.25rem; }
        .course-toolbar label { display: grid; gap: .35rem; font-weight: 700; }
        .course-toolbar input {
          width: 100%;
          min-height: 42px;
          padding: .55rem .65rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 6px;
        }
        main.cp7-container .clear-courses {
          width: auto;
          min-height: 42px;
          margin: 0;
          padding: .55rem .8rem;
          border: 1px solid var(--cp7-border-strong);
          border-radius: 6px;
          background: #fff;
          color: var(--cp7-ink);
          cursor: pointer;
        }
        .course-priority-section + .course-priority-section { margin-top: 1.35rem; }
        .course-priority-section > h3 { margin: 0 0 .45rem; color: var(--cp7-ink); font-size: 16px; }
        main.cp7-container .course-columns { display: grid; grid-template-columns: 1fr; gap: 0; }
        main.cp7-container .course-row {
          position: static;
          display: block;
          min-width: 0;
          padding: .8rem 0;
          border: 0;
          border-bottom: 1px solid #e4e7eb;
          background: transparent;
        }
        main.cp7-container .course-row-main {
          display: grid;
          grid-template-columns: minmax(175px, 1fr) minmax(370px, auto);
          gap: 1rem;
          align-items: center;
        }
        main.cp7-container .course-name { display: grid; gap: .18rem; min-width: 0; }
        main.cp7-container .course-name strong { color: var(--cp7-ink); font-size: 15px; }
        main.cp7-container .course-name span { color: var(--cp7-muted); font-size: 13px; line-height: 1.3; }
        main.cp7-container .course-toggles {
          display: grid;
          grid-template-columns: repeat(2, minmax(105px, 1fr));
          gap: .35rem;
          justify-content: stretch;
          outline: 0;
          box-shadow: none;
        }
        main.cp7-container .course-toggles.has-three { grid-template-columns: repeat(3, minmax(105px, 1fr)); }
        main.cp7-container .course-toggles:focus,
        main.cp7-container .course-toggles:focus-visible,
        main.cp7-container .course-toggles:focus-within { outline: 0; box-shadow: none; }
        main.cp7-container button.course-toggle,
        main.cp7-container .completion-source-options button {
          display: inline-flex;
          width: auto;
          min-width: 0;
          min-height: 38px;
          align-items: center;
          justify-content: center;
          gap: .35rem;
          margin: 0;
          padding: .48rem .55rem;
          border: 1px solid #aeb6bf;
          border-radius: 6px;
          background: #fff;
          color: #303a46;
          font-size: 13px;
          font-weight: 600;
          line-height: 1.2;
          cursor: pointer;
        }
        main.cp7-container button.course-toggle.is-selected,
        main.cp7-container .completion-source-options button.is-selected {
          border-color: transparent;
          background: var(--cp7-selected);
          color: var(--cp7-ink);
        }
        main.cp7-container button.course-toggle:focus-visible {
          position: relative;
          z-index: 1;
          outline: 3px solid var(--cp7-aqua);
          outline-offset: 2px;
          box-shadow: none;
        }
        .selection-check { display: inline-block; width: 1em; color: var(--cp7-accent); font-weight: 800; }
        .course-status-note { color: var(--cp7-muted); font-size: 13px; }
        .course-requirement-group { margin: .55rem 0; padding: .7rem .85rem; border: 1px solid var(--cp7-border); border-radius: 8px; background: #fafbfc; }
        .course-requirement-heading { display: flex; justify-content: space-between; gap: 1rem; color: var(--cp7-muted); font-size: 13px; }
        .course-requirement-heading strong { color: var(--cp7-ink); font-size: 14px; }
        .completion-source { display: flex; align-items: center; flex-wrap: wrap; gap: .25rem .55rem; margin: .35rem 0 0; }
        main.cp7-container .completion-source-trigger { width: auto; margin: 0; padding: .15rem 0; border: 0; background: transparent; color: #4b617a; cursor: pointer; font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }
        .completion-source-current { color: var(--cp7-muted); font-size: 12px; }
        .completion-source-panel { flex: 0 0 100%; }
        .completion-source-options { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .25rem; }
        main.cp7-container .completion-source-options button { min-height: 32px; padding: .35rem .5rem; font-size: 12px; }
        .completion-source p { margin: .4rem 0 0; color: var(--cp7-muted); font-size: 12px; }
        .inline-prerequisite { margin: .7rem 0 0; padding: .8rem; border: 1px solid #b9c3ce; border-radius: 7px; background: #f6f8fa; }
        .inline-prerequisite.has-conflict { border-color: #b76458; background: #fff6f3; }
        .inline-prerequisite > p { margin: 0 0 .65rem; }
        .prerequisite-question + .prerequisite-question { margin-top: .75rem; padding-top: .75rem; border-top: 1px solid var(--cp7-border); }
        .prerequisite-question-heading { display: grid; grid-template-columns: minmax(165px, 1fr) minmax(370px, 2fr); gap: 1rem; margin-bottom: .25rem; color: var(--cp7-muted); font-size: 13px; }
        .prerequisite-question-heading strong { grid-column: 2; color: var(--cp7-ink); text-align: center; }
        .prerequisite-option { display: grid; grid-template-columns: minmax(165px, 1fr) minmax(370px, 2fr); gap: 1rem; align-items: center; padding: .45rem 0; }
        .prerequisite-name { display: grid; gap: .1rem; }
        .prerequisite-name small { color: var(--cp7-muted); }
        .prerequisite-conflict { margin-top: .55rem; padding: .65rem .75rem; border-left: 3px solid var(--cp7-danger); background: #fff; color: #64251f; }
        .prerequisite-conflict p { margin: .2rem 0; }
        .prerequisite-approval { margin: .55rem 0 0 !important; color: #704c08; }
        main.cp7-container .course-accordion { margin-top: 1.35rem; border: 1px solid var(--cp7-border); border-radius: 8px; background: #fafbfc; }
        main.cp7-container .course-accordion > summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .8rem .9rem; color: var(--cp7-ink); cursor: pointer; font-weight: 700; }
        main.cp7-container .course-accordion-title { min-width: 0; }
        main.cp7-container .course-accordion-count { flex: 0 0 auto; }
        main.cp7-container .course-accordion .course-columns { padding: 0 .9rem .55rem; }
        main.cp7-container .cp7-summary { position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow: auto; }
        .summary-details { display: grid; gap: 0; margin: .8rem 0 0; }
        .summary-details > div { padding: .62rem 0; border-bottom: 1px solid #e5e8eb; }
        .summary-details dt { color: var(--cp7-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .035em; }
        .summary-details dd { margin: .24rem 0 0; color: var(--cp7-ink); line-height: 1.4; }
        .summary-none { color: var(--cp7-muted); }
        .summary-show-all { margin-top: .35rem; }
        .summary-show-all summary { color: #244f85; cursor: pointer; font-size: 13px; font-weight: 700; }
        .summary-show-all span { display: block; margin-top: .35rem; }
        .summary-attention { margin-top: .8rem; padding: .7rem; border: 1px solid var(--cp7-warning-border); border-radius: 7px; background: var(--cp7-warning); font-size: 13px; }
        .summary-attention p { margin: .4rem 0 0; }
        .summary-attention ul { display: grid; gap: .3rem; margin: .45rem 0 0; padding: 0; list-style: none; }
        .summary-attention button { padding: 0; border: 0; background: transparent; color: #704c08; text-align: left; text-decoration: underline; cursor: pointer; }
        .summary-status { margin: .8rem 0 0; color: #6c2c25; font-size: 13px; line-height: 1.4; }
        main.cp7-container .clear-all-button { width: 100%; min-height: 43px; margin: .85rem 0 0; padding: .6rem .8rem; border: 1px solid var(--cp7-accent); border-radius: 7px; background: #fff; color: var(--cp7-accent); font-weight: 700; cursor: pointer; }
        main.cp7-container .primary-action {
          width: 100%;
          min-height: 45px;
          margin: 1rem 0 0;
          padding: .7rem 1rem;
          border: 1px solid var(--cp7-accent-dark);
          border-radius: 7px;
          background: var(--cp7-accent-dark);
          color: #fff;
          font-size: 15px;
          font-weight: 700;
          cursor: pointer;
        }
        main.cp7-container .primary-action:hover { background: #21123f; }
        main.cp7-container .primary-action:disabled { cursor: wait; opacity: .68; }
        @media (min-width: 861px) {
          main.cp7-container .cp7-intake-layout {
            grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
          }
        }
        @media (max-width: 860px) {
          main.cp7-container { width: min(100% - 1rem, 720px); }
          .cp7-header { align-items: flex-start; flex-direction: column; gap: .55rem; }
          .cp7-progress { width: 100%; overflow-x: auto; }
          .cp7-progress ol { justify-content: space-between; min-width: 330px; }
          main.cp7-container .cp7-intake-layout { grid-template-columns: minmax(0, 1fr) !important; }
          main.cp7-container .cp7-summary {
            position: static;
            grid-column: 1 !important;
            grid-row: auto !important;
            max-height: none;
            overflow: visible;
          }
        }
        @media (max-width: 620px) {
          main.cp7-container { width: 100%; padding: 0 .65rem 2rem; }
          .cp7-page-heading { padding: 1.35rem .25rem 1rem; }
          .cp7-page-heading h1 { font-size: 28px; }
          main.cp7-container .cp7-task-card,
          main.cp7-container .cp7-summary { padding: 1rem; border-radius: 8px; }
          .standing-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .custom-fields, .advanced-fields, .non-major-fields { grid-template-columns: 1fr; }
          .advanced-fields .wide-field { grid-column: auto; }
          .step-two-heading { display: block; }
          main.cp7-container .secondary-action { margin-top: .7rem; }
          .course-toolbar { grid-template-columns: 1fr; }
          main.cp7-container .clear-courses { justify-self: start; }
          main.cp7-container .course-row-main,
          .prerequisite-option { grid-template-columns: 1fr; gap: .55rem; }
          .prerequisite-question-heading { grid-template-columns: 1fr; }
          .prerequisite-question-heading strong { grid-column: 1; }
          main.cp7-container .course-toggles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          main.cp7-container .course-toggles.has-three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
          main.cp7-container button.course-toggle { min-height: 44px; }
          .course-requirement-heading,
          .prerequisite-question-heading { display: grid; gap: .25rem; }
        }
        @media (max-width: 360px) {
          main.cp7-container .course-toggles { grid-template-columns: 1fr; }
          main.cp7-container button.course-toggle { justify-content: flex-start; }
        }
      `}</style>

      <header className="cp7-header">
        <div className="cp7-brand-block">
          <Image
            className="cp7-brand-logo"
            src="/urveska-midnight-gold-underlined.png"
            alt="Urveska"
            width={1868}
            height={294}
            priority
          />
          <p className="cp7-brand"><strong>EconPlanner</strong></p>
        </div>
        <nav className="cp7-progress" aria-label="Planner progress">
          <ol>
            <li className={intakeStep === 1 ? "is-current" : "is-complete"} aria-current={intakeStep === 1 ? "step" : undefined}>
              <button type="button" onClick={() => setIntakeStep(1)}>About you</button>
            </li>
            <li className={intakeStep === 2 ? "is-current" : ""} aria-current={intakeStep === 2 ? "step" : undefined}>
              <button type="button" onClick={continueToCourses}>Your courses</button>
            </li>
            <li><span aria-disabled="true">Your plans</span></li>
          </ol>
        </nav>
      </header>

      <div className="cp7-page-heading">
        <h1>{intakeStep === 1 ? "Where are you in your degree?" : "Which courses have you finished or are taking now?"}</h1>
        <p>{intakeStep === 1
          ? "We’ll use your class standing to estimate your graduation timeline."
          : "Choose Completed or Taking now only when it applies. Leave both off for courses you have not taken or are not sure about. Click a selected status again to clear it."}</p>
      </div>

      <form onSubmit={mapMajors}>
        <div className="cp7-intake-layout">
          <div className="cp7-left">
            {intakeStep === 1 ? (
              <section className="cp7-task-card" aria-labelledby="about-you-heading">
                <h2 id="about-you-heading">Tell us about your timeline</h2>
                <p className="cp7-task-intro">Choose your current class standing. You can adjust the graduation year if your expected timeline is different.</p>
                <fieldset>
                  <legend className="cp7-question-label">{standingQuestion}</legend>
                  <div className="standing-options" role="group" aria-label="Class standing">
                    {[
                      ["freshman", "Freshman"],
                      ["sophomore", "Sophomore"],
                      ["junior", "Junior"],
                      ["senior", "Senior"]
                    ].map(([value, label]) => (
                      <button
                        type="button"
                        id={`standing-${value}`}
                        className={`standing-option${formData.academicStanding === value ? " is-selected" : ""}`}
                        aria-pressed={formData.academicStanding === value}
                        key={value}
                        onClick={() => chooseStanding(value)}
                      >
                        <span className="selection-check" aria-hidden="true">{formData.academicStanding === value ? "✓" : ""}</span>
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="custom-timeline-copy">{standingHelp}</p>
                </fieldset>
                {formData.academicStanding && !formData.isTransferStudent && !formData.customGraduationEnabled && (
                  <p className="standing-feedback">
                    Based on {planningContext.standingLabel.toLowerCase()} standing, we’ll plan through <strong>{planningContext.expectedGraduationTerm}</strong>.
                  </p>
                )}
                {planningContext.currentTermPlanningWindow && (
                  <div className="current-term-option">
                    <label htmlFor="current-term-schedule-set">
                      <input
                        id="current-term-schedule-set"
                        type="checkbox"
                        checked={formData.scheduleSetByTerm?.[planningContext.currentTermPlanningWindow.slotId] === true}
                        onChange={event => {
                          const slotId = planningContext.currentTermPlanningWindow.slotId;
                          setFormData(current => ({
                            ...current,
                            scheduleSetByTerm: {
                              ...(current.scheduleSetByTerm || {}),
                              [slotId]: event.target.checked
                            }
                          }));
                          clearInputFeedback();
                        }}
                      />
                      <span>My schedule for {planningContext.currentTermPlanningWindow.displayTerm} is already set — don&apos;t add courses to this term.</span>
                    </label>
                  </div>
                )}
                {formData.academicStanding && !formData.isTransferStudent && planningContext.oneYearEarlyEligible && (
                  <div className="early-option">
                    <button
                      type="button"
                      className={`early-toggle${planningContext.earlyComparisonRequested ? " is-selected" : ""}`}
                      aria-pressed={planningContext.earlyComparisonRequested}
                      onClick={() => {
                        setFormData(current => ({
                          ...current,
                          planningPace: current.planningPace === PLANNING_PACES.EARLY ? PLANNING_PACES.STANDARD : PLANNING_PACES.EARLY
                        }));
                        clearInputFeedback();
                      }}
                    >
                      <span className="selection-check" aria-hidden="true">{planningContext.earlyComparisonRequested ? "✓" : ""}</span>
                      {formData.academicStanding === "junior"
                        ? "I’d like to graduate next year"
                        : "I’d like to graduate one year early"}
                    </button>
                    <p>Standard target: {planningContext.expectedGraduationTerm}. Accelerated target: {buildEarlyGraduationContext(planningContext)?.expectedGraduationTerm}.</p>
                  </div>
                )}
                <div className="custom-timeline-disclosure">
                  <button
                    type="button"
                    className="custom-timeline-trigger"
                    aria-expanded={formData.customGraduationEnabled}
                    aria-controls="custom-timeline-panel"
                    onClick={() => {
                      const turningOn = !formData.customGraduationEnabled;
                      const earlyWasSelected = formData.planningPace === PLANNING_PACES.EARLY;
                      setFormData(current => ({
                        ...current,
                        customGraduationEnabled: !current.customGraduationEnabled,
                        planningPace: PLANNING_PACES.STANDARD
                      }));
                      clearInputFeedback();
                      if (turningOn && earlyWasSelected) {
                        setStatus("The accelerated comparison was turned off because a custom graduation year uses its own timeline.");
                      }
                    }}
                  >
                    My expected graduation year is different
                  </button>
                  {!formData.customGraduationEnabled && <p className="custom-timeline-copy">Use this only when the standard target shown above does not fit your situation.</p>}
                  {formData.customGraduationEnabled && (
                    <div className="custom-timeline-panel" id="custom-timeline-panel">
                      <p className="custom-timeline-copy">This changes only the planning horizon. It does not claim transfer credit or change academic requirements.</p>
                      <div className="custom-fields">
                        <label htmlFor="custom-graduation-year">
                          <span>When do you expect to graduate?</span>
                          <select
                            id="custom-graduation-year"
                            value={formData.customExpectedGraduationYear}
                            onChange={event => {
                              setFormData(current => ({ ...current, customExpectedGraduationYear: event.target.value }));
                              clearInputFeedback();
                            }}
                          >
                            <option value="">Choose a graduation year</option>
                            {[...transferOptions.graduationYears, transferOptions.otherGraduationYear].map(year => (
                              <option value={year} key={year}>Spring/May {year}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <p className="custom-target"><strong>Custom target:</strong> {planningContext.customGraduationValidation.valid ? planningContext.expectedGraduationTerm : "Choose a graduation year above."}</p>
                      {!planningContext.customGraduationValidation.valid && (
                        <ul className="custom-errors">
                          {planningContext.customGraduationValidation.errors.map(error => <li key={error}>{error}</li>)}
                        </ul>
                      )}
                      <button
                        type="button"
                        className="standard-timeline-trigger"
                        onClick={() => {
                          setFormData(current => ({ ...current, customGraduationEnabled: false, planningPace: PLANNING_PACES.STANDARD }));
                          clearInputFeedback();
                        }}
                      >
                        Use my standard class-year timeline
                      </button>
                    </div>
                  )}
                </div>
                <div className="catalog-planning-note">
                  <strong>Planning requirements: 2025–2026 Economics catalog and confirmed department policies.</strong>
                  <p>Your official degree audit may differ. If an older declaration catalog applies, your advisor can confirm whether routine SAC paperwork is needed.</p>
                </div>
                <details className="more-details">
                  <summary>More details</summary>
                  <div className="advanced-fields">
                    <label>
                      <span>Student name (optional)</span>
                      <input type="text" autoComplete="name" value={formData.displayName} onChange={event => setFormData(current => ({ ...current, displayName: event.target.value }))} />
                    </label>
                    <label htmlFor="plan-creation-date">
                      <span>Plan creation date</span>
                      <input id="plan-creation-date" type="date" value={formData.planCreationDate} onChange={event => setFormData(current => updatePlanCreationDate(current, event.target.value))} />
                    </label>
                  </div>
                  {planningSlots.length > 0 && (
                    <details className="more-details">
                      <summary>Adjust your schedule (optional)</summary>
                      <p className="custom-timeline-copy">Tell EconPlanner about a future study-abroad term or space you want to leave for other courses.</p>
                      {juniorStudyAbroadSlots.length > 0 && (
                        <div className="study-abroad-fields">
                          <button
                            type="button"
                            className={`study-abroad-toggle${formData.studyAbroadTerm ? " is-selected" : ""}`}
                            aria-pressed={Boolean(formData.studyAbroadTerm)}
                            onClick={() => changeStudyAbroadTerm(formData.studyAbroadTerm ? "" : juniorStudyAbroadSlots[0].id)}
                          >
                            <span className="selection-check" aria-hidden="true">{formData.studyAbroadTerm ? "✓" : ""}</span>
                            I plan to study abroad during my junior year
                          </button>
                          {formData.studyAbroadTerm && (
                            <label htmlFor="study-abroad-term">
                              <span>Study-abroad term</span>
                              <select id="study-abroad-term" value={formData.studyAbroadTerm} onChange={event => changeStudyAbroadTerm(event.target.value)}>
                                {juniorStudyAbroadSlots.map(slot => <option value={slot.id} key={slot.id}>{slot.label}</option>)}
                              </select>
                            </label>
                          )}
                          {formData.studyAbroadTerm && <p>No Economics courses will be scheduled in {planningSlotsLabel(formData.studyAbroadTerm, planningContext)}.</p>}
                        </div>
                      )}
                      <h3>Recorded overload approval</h3>
                      <p>Record existing advisor approval and academic probation status for each term. EconPlanner does not grant approval. An overload may add tuition; major courses do not establish your full enrollment or charge.</p>
                      <div className="non-major-fields">
                        {planningSlots.filter(slot => !slot.isSummer).map(slot => (
                          <div key={slot.id}>
                            <strong>{slot.label}</strong>
                            {[
                              ["advisorApproval", "Advisor overload approval", [["NOT_SUPPLIED", "Not supplied"], ["APPROVED", "Already approved"], ["NOT_APPROVED", "Not approved"]]],
                              ["academicProbationStatus", "Academic probation status", [["NOT_SUPPLIED", "Not supplied"], ["NOT_ON_ACADEMIC_PROBATION", "Not on academic probation"], ["ON_ACADEMIC_PROBATION", "On academic probation"]]]
                            ].map(([field, label, options]) => (
                              <label key={field}>
                                <span>{label}</span>
                                <select aria-label={`${label} in ${slot.label}`} value={formData.termLoadOverrides?.[slot.id]?.[field] || "NOT_SUPPLIED"} onChange={event => {
                                  const value = event.target.value;
                                  setFormData(current => ({...current, termLoadOverrides: {...current.termLoadOverrides, [slot.id]: {...current.termLoadOverrides?.[slot.id], [field]: value}}}));
                                  clearInputFeedback();
                                }}>
                                  {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                                </select>
                              </label>
                            ))}
                          </div>
                        ))}
                      </div>
                      <h3>Leave room for other courses</h3>
                      <p className="custom-timeline-copy">Choose 0, 1, or 2 course units, within the normal capacity for each term.</p>
                      <div className="non-major-fields">
                        {planningSlots.filter(slot => !slot.isSummer).map(slot => (
                          <label key={slot.id}>
                            <span>{slot.label}</span>
                            <select
                              value={formData.studyAbroadTerm === slot.id
                                ? termReservationLimit(slot)
                                : Number(formData.reservedCourseUnits?.[slot.id] || 0)}
                              disabled={formData.studyAbroadTerm === slot.id}
                              aria-label={`Course units reserved in ${slot.label}`}
                              onChange={event => {
                                setFormData(current => ({
                                  ...current,
                                  reservedCourseUnits: {
                                    ...(current.reservedCourseUnits || {}),
                                    [slot.id]: Number(event.target.value)
                                  }
                                }));
                                clearInputFeedback();
                              }}
                            >
                              {Array.from({ length: Math.min(2, termReservationLimit(slot)) + 1 }, (_, value) => (
                                <option value={value} key={value}>{value}</option>
                              ))}
                              {formData.studyAbroadTerm === slot.id && termReservationLimit(slot) > 2 && (
                                <option value={termReservationLimit(slot)}>{termReservationLimit(slot)}</option>
                              )}
                            </select>
                          </label>
                        ))}
                      </div>
                    </details>
                  )}
                </details>
              </section>
            ) : (
              <section className="cp7-task-card" aria-labelledby="your-courses-heading">
                <div className="step-two-heading">
                  <div>
                    <h2 id="your-courses-heading">Your course history</h2>
                    <p className="cp7-task-intro">Only choose courses that apply to you.</p>
                  </div>
                  <button type="button" className="secondary-action" onClick={() => setIntakeStep(1)}>Back to about you</button>
                </div>
                <div className="course-toolbar">
                  <label htmlFor="course-search">
                    <span>Search courses</span>
                    <input
                      id="course-search"
                      type="search"
                      value={courseSearch}
                      onChange={event => setCourseSearch(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === "Enter") event.preventDefault();
                      }}
                      placeholder="Search by course code or title"
                    />
                  </label>
                  <button
                    type="button"
                    className="clear-courses"
                    onClick={() => {
                      setFormData(current => ({
                        ...current,
                        courses: current.courses.map(course => ({ ...course, status: "not_started", source: "manual_code" }))
                      }));
                      clearInputFeedback();
                    }}
                  >
                    Clear course choices
                  </button>
                </div>
                {declarationCourseGroups.length > 0 && (
                  <section className="course-priority-section" aria-labelledby="foundations-heading">
                    <h3 id="foundations-heading">Required Economics foundations</h3>
                    {renderCourseColumns(declarationCourseGroups, true)}
                  </section>
                )}
                {declarationRequirementGroups.length > 0 && (
                  <section className="course-priority-section" aria-labelledby="cognates-heading">
                    <h3 id="cognates-heading">Mathematics and statistics</h3>
                    {renderCourseColumns(declarationRequirementGroups, true)}
                  </section>
                )}
                {financeGroups.length > 0 && (
                  <section className="course-priority-section" aria-labelledby="finance-heading">
                    <h3 id="finance-heading">Finance</h3>
                    {renderCourseColumns(financeGroups, true)}
                  </section>
                )}
                {renderCourseAccordion("other-economics", "Other Economics courses", secondaryCourseGroups)}
                {visibleGroups.length === 0 && <p role="status">No courses match your search.</p>}
              </section>
            )}
          </div>
          <PlannerSummary
            courses={formData.courses}
            pendingDependentCourseCodes={pendingDependentCourseCodes}
            formData={formData}
            planningContext={planningContext}
            planningStart={planningStart}
            attentionItems={attentionItems}
            intakeStep={intakeStep}
            isGenerating={isGenerating}
            status={status}
            onRetryRestoration={canRetryRestoration ? retryRestoration : null}
            isRetryingRestoration={isRetryingRestoration}
            migrationNotice={migrationNotice}
            generateButtonRef={generateButtonRef}
            onContinue={continueToCourses}
            onFocusAttention={focusAttention}
            onClearAll={() => setClearDialogOpen(true)}
          />
        </div>
      </form>


    </main>
    <ClearAllDialog open={clearDialogOpen} onCancel={() => setClearDialogOpen(false)} onConfirm={clearAllPlanner} />
    </>
  );
}
