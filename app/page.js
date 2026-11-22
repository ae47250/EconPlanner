"use client";

import Image from "next/image";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  buildEarlyGraduationContext,
  buildPlanningSlots,
  PLANNING_PACES,
  resolvePlanningContext,
  transferPlanningOptions
} from "../lib/planning/horizon.js";
import {
  buildPrerequisiteFollowUp,
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
import { followingMayId, joinStudyAbroadTerms, studyAbroadAdvisorContext, studyAbroadTermIds, termReservationLimit, updateStudyAbroadReservation } from "../lib/planning/study-abroad.js";
import { seatStatusPresentation } from "../lib/planning/seat-status.js";
import prerequisitePolicy from "../policy/rules/prerequisites.json";
import { historicalPrerequisiteGaps, historicalPrerequisiteMessage } from "../lib/planning/historical-prerequisites.js";
import { noPlanPresentation } from "../lib/planning/no-plan-presentation.js";
import { planningRequirementsNote, replacesLegacyCatalogNotice } from "../lib/catalog/planning-requirements-note.js";
import { feasibilityMeaning, planTermsWithCurrentCourses } from "../lib/planning/plan-display.js";
import { studentFriendlyCourseMarker, studentFriendlyUnavailableReason, studentFriendlyMoveCondition, studentFriendlyMoveDetails, studentFriendlyMoveNextStep, studentStandingSummary, studentTermLabel } from "../lib/planning/student-language.js";

const PLANNER_STORAGE_KEY = "econ-planner-ui-state";
const GENERATED_PLANNER_SESSION_KEY = "econ-planner-generated-session";
const PLANNER_STORAGE_VERSION = PLANNER_INPUT_STATE_VERSION;
const STUDENT_READINESS_EXPLANATIONS = Object.freeze({
  "Ready to plan": "These plans meet the major rules. Seats are not confirmed, so check the registration system before you register.",
  "Needs confirmation": "These plans work only if the conditions shown on them are met, such as an instructor's permission or confirmed senior standing. Check each plan's conditions.",
  "Needs advisor attention": "Something in your answers needs your advisor to check it before you rely on these plans."
});
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
    studyAbroadMayOverlap: formData.studyAbroadMayOverlap,
    studyAbroadDestination: formData.studyAbroadDestination,
    studyAbroadAdvisingNote: formData.studyAbroadAdvisingNote,
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
  studyAbroadMayOverlap: false,
  studyAbroadDestination: "",
  studyAbroadAdvisingNote: "",
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
  const notes = (plan?.planNotes || []).filter(note => note.id !== "history");
  if (!notes.length) return null;
  const presentation = {
    "ccr-ace": { title: "Other graduation requirements" },
    history: { title: "When these classes ran before" },
    future: { title: "Courses in future years" }
  };
  return (
    <div className="student-evidence-groups" data-plan-id={plan?.id || ""} data-plan-notes>
      {notes.map(note => {
        const display = note.id === "upcoming" ? { title: note.title } : presentation[note.id] || { title: note.title };
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

function PlanConditions({ plan, catalog, showPlanName = false, hideHeading = false }) {
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
  const catalogNote = plan && planningRequirementsNote(plan.planningContext, plan);
  const visibleNotices = notices.filter(item => !replacesLegacyCatalogNotice(plan?.planningContext)
    || !["FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE", "FLEXIBLE_MAJOR_REQUIREMENTS_INCOMING_YEAR_UNKNOWN"].includes(item.code));
  if (!conditions.length && !visibleNotices.length && !catalogNote) return null;
  return <section className="plan-notes upfront-conditions" data-plan-conditions>
    {!hideHeading && <h2>Things to keep in mind{showPlanName && ` — ${plan.label}`}</h2>}
    {prerequisiteConditions.length > 0 && <div><h3>Classes to finish first</h3><ul>{prerequisiteConditions.map(item => <li key={item.id}>{item.message}</li>)}</ul></div>}
    {seatConditions.length > 0 && <div><h3>Before you register</h3><ul>{seatConditions.map(item => <li key={item.id}>{item.message}</li>)}</ul></div>}
    {(otherConditions.length > 0 || visibleNotices.length > 0 || catalogNote) && <div><h3>Check with your advisor</h3><ul>
      {otherConditions.map(item => <li key={item.id}>{item.message}</li>)}
      {catalogNote && <li><strong>{catalogNote.heading}</strong> {catalogNote.details.join(" ")}</li>}
      {visibleNotices.map((item, index) => <li key={item.noticeId || `${item.code}-${index}`}>{item.code === "FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE"
        ? <><strong>Ask your advisor whether a catalog petition is needed.</strong><details><summary>Catalog details</summary><p>{item.message}</p></details></>
        : item.message}</li>)}
    </ul></div>}
  </section>;
}

function MajorRequirementsChecklist({ plan, showPlanName = false }) {
  const checklist = plan?.majorRequirementsChecklist;
  if (!checklist?.rows?.length) return null;
  return <section className="major-checklist" data-major-requirements-checklist>
    <details className="comparison-disclosure"><summary>{checklist.title}{showPlanName && ` — ${plan.label}`}</summary>
    <div className="comparison-disclosure-content">
    <table>
      <thead><tr><th scope="col">Requirement</th><th scope="col">Course / term</th><th scope="col">Status</th></tr></thead>
      <tbody>{checklist.rows.filter(row => row.status !== "still_needed").map(row => <tr key={row.id} data-requirement-checklist-id={row.id}>
        <th scope="row">{row.label}</th>
        <td>{row.course ? <><strong>{row.course}</strong>{row.term && ` — ${studentTermLabel(row.term)}`}</> : studentTermLabel(row.courseTerm)}{row.alternatives.length > 1 && <span className="checklist-alternatives">Requirement options: {row.alternatives.join(" / ")}</span>}</td>
        <td><span className={`checklist-status is-${row.status}`}><span className="checklist-symbol" aria-hidden="true">{row.symbol}</span> {row.statusLabel}</span>
          {row.markers.map(marker => <span className="checklist-marker" key={marker}>{marker}</span>)}</td>
      </tr>)}</tbody>
    </table>
    <div className="checklist-legend" aria-label="Checklist status legend">{checklist.legend?.map(state => <span key={state.status} className={`checklist-status is-${state.status}`}><span aria-hidden="true">{state.symbol}</span> {state.label}</span>)}</div>
    <p className="checklist-note">{checklist.note}</p>
    {checklist.unmetRequirements?.length > 0 && <div className="incomplete-candidate" data-incomplete-candidate>
      <h3>Requirements without a planned class</h3>
      <ul>{checklist.unmetRequirements.map(row => <li key={row.id}>{row.label}</li>)}</ul>
    </div>}
    </div>
    </details>
  </section>;
}

const CourseMenuContext = createContext(null);

function useEditorPosition(open, anchorRef, placement = "left") {
  const [position, setPosition] = useState({});
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const place = () => {
      const rect = anchorRef.current.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 24);
      const left = placement === "button"
        ? Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
        : rect.left >= width + 20
          ? rect.left - width - 8
          : Math.max(12, Math.min(rect.right + 8, window.innerWidth - width - 12));
      const top = Math.max(12, Math.min(rect.top, window.innerHeight - 280));
      setPosition({ position: "fixed", left, top, width,
        maxHeight: Math.min(320, window.innerHeight - top - 12), overflowY: "auto", margin: 0, zIndex: 20 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, anchorRef, placement]);
  return position;
}

function ExtraCoursePicker({ plan, onEdit, busy }) {
  const planId = plan.id;
  const [termId, setTermId] = useState("");
  const term = plan.terms.find(item => item.slotId === termId);
  const menu = useContext(CourseMenuContext);
  const menuId = `${planId}:add`;
  const open = menu.openId === menuId;
  const trigger = useRef(null);
  const editorPosition = useEditorPosition(open, trigger, "button");
  const panel = useRef(null);
  const container = useRef(null);
  const [selected, setSelected] = useState(null);
  const close = () => { menu.setOpenId(current => current === menuId ? null : current); setSelected(null); setTermId(""); };
  useEffect(() => {
    if (!open) { setSelected(null); return; }
    const dismiss = event => { if (!event.composedPath().includes(container.current)) close(); };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [open]);
  const add = async (item, control) => {
    if (await onEdit({type:"add-extra",planId,toTermId:term.slotId,course:item.course},control)) close();
  };
  const usable = (term?.extraCourseOptions || []).filter(item => ["ALLOWED", "CONDITIONAL"].includes(item.status));
  const blocked = (term?.extraCourseOptions || []).find(item => !["ALLOWED", "CONDITIONAL"].includes(item.status));
  return <div className="plan-course-actions extra-course-picker" ref={container} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); close(); trigger.current?.focus(); }
  }}>
    <button type="button" ref={trigger} aria-expanded={open} aria-label={`Add Econ course: ${plan.label}`} disabled={busy}
      onClick={() => menu.setOpenId(open ? null : menuId)}>Add Econ course</button>
    <div hidden={!open} ref={panel} style={editorPosition} className="course-change-panel" role="region" aria-label={`Add Econ course options: ${plan.label}`}>
      <button type="button" className="close-course-options" onClick={close}>Close ×</button>
      <strong className="change-menu-heading">{selected ? "Add Extra course" : "Add Economics course"}</strong>
      {!term ? <>
        <span>Which term?</span>
        {plan.terms.map(item => <button type="button" className="change-menu-option" key={item.slotId} onClick={() => setTermId(item.slotId)}>{studentTermLabel(item.term)}</button>)}
      </> : <>
      <button type="button" className="change-menu-option" onClick={() => { setTermId(""); setSelected(null); }}>← {studentTermLabel(term.term)}</button>
      {selected ? <>
        <strong>{selected.course === "ECO elective" ? "200+ Economics elective" : selected.course}</strong>
        <p className="change-confirm-warning">{studentFriendlyMoveCondition(selected, selected.course)}</p>
        <div className="change-confirm-actions"><button type="button" disabled={busy} onClick={event => add(selected,event.currentTarget)}>Add course</button><button type="button" onClick={close}>Cancel</button></div>
      </> : <>
        {usable.length ? <section aria-label={usable[0].evidence === "published" ? "Published for this term" : "Future elective"}>
          <strong className="change-menu-heading">{usable[0].evidence === "published" ? "Published for this term" : "Schedule not yet published"}</strong>
          {usable.map(item => <button type="button" className="change-menu-option" key={item.course} disabled={busy} onClick={event => item.status === "CONDITIONAL" ? setSelected(item) : add(item,event.currentTarget)}>
            <span>{item.course === "ECO elective" ? "Add a 200+ elective" : item.course}</span><small>{item.title}</small>
          </button>)}
        </section> : <p>{blocked ? studentFriendlyUnavailableReason(blocked) : "No eligible extra course is available in this term."} {blocked && studentFriendlyMoveNextStep(blocked)}</p>}
        {term.extraCourseHistory?.length > 0 && <details><summary>Previously scheduled — not confirmed</summary>
          <ul>{term.extraCourseHistory.map(item => <li key={item.course}>{item.course} · {item.title}</li>)}</ul>
        </details>}
      </>}
      </>}
    </div>
  </div>;
}

function courseHasMoveControl(course) {
  return course.course !== "ECO 461" || (course.moveDestinationOptions || [])
    .some(option => ["ALLOWED", "CONDITIONAL"].includes(option.status));
}

function CourseChange({ course, termId, planId, onEdit, busy, feedback, onUndo, canUndo, compact = false }) {
  const menu = useContext(CourseMenuContext);
  const menuId = `${planId}:${planCourseIdentity(course)}`;
  const open = menu.openId === menuId;
  const setOpen = value => menu.setOpenId(current => value ? menuId : current === menuId ? null : current);
  const [choice, setChoice] = useState("");
  const trigger = useRef(null);
  const editorPosition = useEditorPosition(open, trigger);
  const container = useRef(null);
  const panel = useRef(null);
  const dismissTimer = useRef(null);
  useEffect(() => () => clearTimeout(dismissTimer.current), []);
  useEffect(() => {
    if (!open) return;
    const dismiss = event => {
      if (!event.composedPath().includes(container.current)) { setOpen(false); setChoice(""); }
    };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [open]);
  useEffect(() => { if (!open) setChoice(""); }, [open]);
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
  const guidance = [...new Set(all.filter(item => !["ALLOWED", "CONDITIONAL"].includes(item.status))
    .map(item => studentFriendlyUnavailableReason({ ...item, movingCourse: course.course }))
    .filter(reason => /Move .* (?:out|later|first)|needs .* first/i.test(reason)))].slice(0, 2);
  const optionGroups = usable.reduce((groups, item) => {
    const label = item.edit.type === "move" ? "Move to"
      : item.edit.replacementCourse === "ECO elective" ? "Move as a 200+ elective"
        : studentTermLabel(item.label).replace(/^(\d{4})\/(\d{4}) (.*)$/, (_, start, end, season) => `${season} ${season === "Fall" ? start : end}`);
    const group = groups.find(group => group.label === label);
    if (group) group.items.push(item);
    else groups.push({ label, items: [item] });
    return groups;
  }, []);
  const selected = usable.find(item => item.key === choice);
  useEffect(() => {
    menu.setConfirmingId(current => open && selected ? menuId : current === menuId ? null : current);
  }, [open, selected, menuId]);
  useLayoutEffect(() => {
    if (open && selected) {
      clearTimeout(dismissTimer.current);
      panel.current?.querySelector(".change-confirm-actions button")?.focus({ preventScroll: true });
    }
  }, [open, choice]);
  const close = () => { setOpen(false); setChoice(""); trigger.current?.focus(); };
  const apply = async (item, control) => {
    const saved = await onEdit({ ...item.edit, planId, fromTermId: termId, courseId: planCourseIdentity(course) }, control);
    if (saved) close();
  };
  return <div className="plan-course-actions" ref={container}
    data-current-term={`move:${termId}`} aria-label={`Changes for ${compactPlanCourse(course)}`}
    onPointerEnter={() => clearTimeout(dismissTimer.current)}
    onPointerLeave={event => {
      if (event.pointerType !== "mouse" || busy || selected) return;
      dismissTimer.current = setTimeout(() => { setOpen(false); setChoice(""); }, 350);
    }}
    onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); close(); }
      if (event.key === "ArrowDown" && event.target === trigger.current) {
        event.preventDefault(); setOpen(true);
        requestAnimationFrame(() => container.current?.querySelector("[data-change-choice]")?.focus());
      }
    }}>
    <button type="button" ref={trigger} data-course-edit-id={`${planId}:${planCourseIdentity(course)}:change`}
      aria-label={`Change ${compactPlanCourse(course)}`} aria-expanded={open}
      disabled={busy} onClick={() => { setOpen(true); setChoice(""); }}>{compact ? compactPlanCourse(course) : "Change"} ▾</button>
    <div hidden={!open} ref={panel} style={editorPosition} className="course-change-panel" role="region" aria-label={`Change ${compactPlanCourse(course)} options`}>
      <div className="course-editor-title"><strong>{compactPlanCourse(course)}</strong><button type="button" className="close-course-options" onClick={close} aria-label="Close course options">Close ×</button></div>
      {!selected && (course.course !== "ECO 461" || optionGroups.length > 0) && (optionGroups.length ? optionGroups.map((group, groupIndex) => <section className="change-option-group" aria-label={group.label} key={group.label}>
        {group.items[0].edit.type === "replace-move" && group.items[0].edit.replacementCourse !== "ECO elective" && !optionGroups.slice(0, groupIndex).some(item => item.items[0].edit.type === "replace-move" && item.items[0].edit.replacementCourse !== "ECO elective") && <strong className="change-menu-heading">Take a different course</strong>}
        <strong className="change-menu-heading">{group.label}</strong>
        {group.items.map(item => <button type="button" className="change-menu-option"
          data-change-choice={item.key} data-change-status={item.status} key={item.key} disabled={busy}
          onClick={event => {
            if (item.status === "CONDITIONAL" || item.edit.type === "replace-move") { clearTimeout(dismissTimer.current); setChoice(item.key); }
            else apply(item, event.currentTarget);
          }}>
          <span>{item.edit.type === "replace-move" && item.edit.replacementCourse !== "ECO elective" ? item.edit.replacementCourse : studentTermLabel(item.label)}</span>
          {item.status === "CONDITIONAL" && studentFriendlyMoveCondition(item, course.course) !== "Schedule not yet published." && <small>{studentFriendlyMoveCondition(item, course.course)}</small>}
        </button>)}
        {group.items.some(item => item.status === "CONDITIONAL" && studentFriendlyMoveCondition(item, course.course) === "Schedule not yet published.") && <small className="change-confirm-warning">Schedule not yet published.</small>}
      </section>) : <p>{all.length ? studentFriendlyUnavailableReason({ ...all[0], movingCourse: course.course }) : "No other move is available right now."}</p>)}
      {selected && <>
        <strong className="change-confirm-title">{selected.edit.type === "move" ? `Move ${compactPlanCourse(course)}` : `Replace with ${selected.edit.replacementCourse === "ECO elective" ? "a 200+ elective" : selected.edit.replacementCourse}`}</strong>
        <span className="change-confirm-term">{studentTermLabel(selected.label)}</span>
        {selected.edit.replacementCourse === "ECO elective" && <p>Choose the exact course later.</p>}
        <p className="change-confirm-warning">{studentFriendlyMoveCondition(selected, course.course)}</p>
        <details className="course-reason-details"><summary>Full check details</summary><p>{studentFriendlyMoveDetails(selected)}</p>
        </details>
        <div className="change-confirm-actions">
          <button type="button" aria-label="Apply change" disabled={busy} onClick={event => apply(selected, event.currentTarget)}>{busy ? "Checking…" : selected.edit.type === "move" ? "Move" : "Replace"}</button>
          <button type="button" disabled={busy} onClick={close}>Cancel</button>
        </div>
      </>}
      {!selected && usable.length === 0 && course.course !== "ECO 461" && guidance.slice(0, 1).map(reason => <p className="change-menu-guidance" key={reason}>{reason}</p>)}
      {!selected && course.extra === true && <button type="button" disabled={busy} onClick={async event => {
        if (await onEdit({type:"remove-extra",planId,fromTermId:termId,courseId:planCourseIdentity(course)},event.currentTarget)) close();
      }}>Remove Extra course</button>}

    </div>
    {feedback && <p className={`plan-course-edit-feedback${feedback.failed ? " is-error" : ""}`} role={feedback.failed ? "alert" : "status"}>{feedback.message}</p>}
    {canUndo && <button type="button" disabled={busy} onClick={onUndo}>Undo last plan edit</button>}
  </div>;
}

function CourseDragHandle({ course, termId, planId, compact = false, busy, setPendingDrop, setDropMessage, setDraggedCourse, applyDrop }) {
  const pointerDragRef = useRef(null);
  useEffect(() => {
    const cancel = event => {
      if (event.key === "Escape" && pointerDragRef.current) {
        pointerDragRef.current = null; setDraggedCourse(null); setDropMessage("Move cancelled.");
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [setDraggedCourse, setDropMessage]);
  return <span
                                className="course-drag-handle"
                                title={`Drag ${compactPlanCourse(course)} to another term`}
                                aria-hidden="true"
                                onPointerDown={event => {
                                  if (busy || event.button !== 0) return;
                                  event.preventDefault();
                                  event.currentTarget.setPointerCapture(event.pointerId);
                                  pointerDragRef.current = { x: event.clientX, y: event.clientY, active: false,
                                    planId: planId, fromTermId: termId, course,
                                    trigger: event.currentTarget.parentElement.querySelector("[data-course-edit-id]") };
                                }}
                                onPointerMove={event => {
                                  const moving = pointerDragRef.current;
                                  if (!moving) return;
                                  if (!moving.active && Math.hypot(event.clientX - moving.x, event.clientY - moving.y) > 5) {
                                    moving.active = true;
                                    setPendingDrop(null);
                                    setDropMessage(`Moving ${compactPlanCourse(course)}. Release over a destination term.`);
                                    setDraggedCourse(moving);
                                  }
                                  if (moving.active) {
                                    if (event.clientY < 80) window.scrollBy(0, -20);
                                    else if (event.clientY > window.innerHeight - 80) window.scrollBy(0, 20);
                                  }
                                }}
                                onPointerUp={event => {
                                  const moving = pointerDragRef.current;
                                  pointerDragRef.current = null;
                                  setDraggedCourse(null);
                                  setDropMessage("");
                                  if (!moving?.active || busy || moving.planId !== planId) return;
                                  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-term-id]");
                                  const destination = moving.course.moveDestinationOptions?.find(option => option.id === target?.dataset.termId);
                                  if (!target || target.dataset.planScope !== planId || destination?.status === "CURRENT") return;
                                  if (!["ALLOWED", "CONDITIONAL"].includes(destination?.status)) {
                                    setDropMessage(studentFriendlyUnavailableReason(destination));
                                    return;
                                  }
                                  const drop = { ...moving, destination, anchorElement: target };
                                  if (destination.status === "CONDITIONAL") setPendingDrop(drop);
                                  else applyDrop(drop, moving.trigger);
                                }}
                                onPointerCancel={() => { pointerDragRef.current = null; setDraggedCourse(null); setDropMessage(""); }}
                              >{compact ? "⠿" : "⠿ Drag"}</span>;
}

function MoveConfirmation({ drop, onApply, onCancel, busy }) {
  const panel = useRef(null);
  const [position, setPosition] = useState({});
  useLayoutEffect(() => {
    const place = () => {
      const margin = 12;
      const width = Math.min(340, window.innerWidth - margin * 2);
      const height = panel.current?.getBoundingClientRect().height || 200;
      const anchor = drop.anchorElement?.getBoundingClientRect();
      const rightFits = anchor && anchor.right + width + margin <= window.innerWidth;
      const leftFits = anchor && anchor.left - width - margin >= margin;
      const left = rightFits ? anchor.right + 6 : leftFits ? anchor.left - width - 6 : anchor?.left || margin;
      const top = rightFits || leftFits ? anchor.top : anchor?.bottom || margin;
      setPosition({ width,
        left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
        top: Math.max(margin, Math.min(top, window.innerHeight - height - margin))
      });
    };
    place();
    panel.current?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [drop]);
  return <div className="drop-confirmation drop-confirmation-popover" role="region"
    aria-label="Review move conditions" ref={panel} style={position} tabIndex={-1}
    onKeyDown={event => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onCancel(); } }}>
    <strong>Move {compactPlanCourse(drop.course)} to {studentTermLabel(drop.destination.label)}?</strong>
    <p>{studentFriendlyMoveCondition(drop.destination, drop.course.course)}</p>
    <details><summary>Check details</summary><p>{drop.destination.message}</p></details>
    <div className="drop-confirmation-actions">
      <button type="button" disabled={busy} onClick={event => onApply(drop, event.currentTarget)}>Apply move</button>
      <button type="button" disabled={busy} onClick={onCancel}>Cancel move</button>
    </div>
  </div>;
}

function PlanTimeline({
  plans = [],
  studentCourses = [],
  studyAbroadIds = [],
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
  const [draggedCourse, setDraggedCourse] = useState(null);
  const [pendingDrop, setPendingDrop] = useState(null);
  const [dropMessage, setDropMessage] = useState("");
  useEffect(() => { if (editingPlanCourseKey) setPendingDrop(null); }, [editingPlanCourseKey]);
  useEffect(() => {
    setDraggedCourse(null);
    setPendingDrop(null);
    setDropMessage("");
  }, [activePlanId]);
  if (!plans.length) {
    return planningGaps.length ? (
      <section className="plan-section">
        <PlanningGaps items={planningGaps} />
      </section>
    ) : null;
  }

  const activePlan = plans.find(plan => plan.id === activePlanId) || plans[0];
  const drag = draggedCourse?.planId === activePlan.id ? draggedCourse : null;
  const destinationFor = term => drag?.course.moveDestinationOptions?.find(option => option.id === (term.slotId || term.term));
  const applyDrop = async (drop, trigger) => {
    setPendingDrop(null);
    setDropMessage("");
    await onEditPlanCourse({ type: "move", planId: drop.planId, fromTermId: drop.fromTermId,
      courseId: planCourseIdentity(drop.course), toTermId: drop.destination.id }, trigger);
  };
  const mathSequenceNotes = acceleratedMathSequenceNotes(activePlan, COURSE_PREREQUISITES);
  const academicYearGroups = planTermsWithCurrentCourses(activePlan, studentCourses, COURSE_CATALOG).reduce((groups, term) => {
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
      <p className="drag-plan-status" role="status">{dropMessage}</p>
      {pendingDrop && <MoveConfirmation drop={pendingDrop} onApply={applyDrop} onCancel={() => setPendingDrop(null)} busy={Boolean(editingPlanCourseKey)} />}
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
                    className={`term-card${term.isPlaceholder ? " is-placeholder" : ""}${pendingDrop?.destination.id === (term.slotId || term.term) ? " drop-pending" : ""}${drag ? ` drop-${(destinationFor(term)?.status || "unavailable").toLowerCase()}` : ""}`}
                    data-term-id={term.slotId || term.term}
                    data-plan-scope={activePlan.id}
                    data-academic-year={term.academicYear || ""}
                    data-placeholder={term.isPlaceholder ? "true" : "false"}
                    data-term-key={term.termKey || ""}
                    data-publication-status={term.publicationStatus || ""}
                    key={term.slotId || term.term}
                  >
                    <h4>{studentTermLabel(term.displayTerm || term.term)}</h4>
                    {drag && <p className="drop-term-hint">{destinationFor(term)?.status === "CURRENT" ? "Current term" : destinationFor(term)?.status === "ALLOWED" ? "Drop to move here" : destinationFor(term)?.status === "CONDITIONAL" ? "Drop to review conditions" : studentFriendlyUnavailableReason(destinationFor(term))}</p>}
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
                              {onEditPlanCourse && !course.fixedInProgress && courseHasMoveControl(course) && <CourseDragHandle
                                course={course} termId={termId} planId={activePlan.id} busy={Boolean(editingPlanCourseKey)}
                                setPendingDrop={setPendingDrop} setDropMessage={setDropMessage}
                                setDraggedCourse={setDraggedCourse} applyDrop={applyDrop} />}
                              <div className="plan-course-summary">
                                <strong>{compactPlanCourse(course)}</strong>
                                <span>{courseTitle(course.course)}</span>
                                {course.course === "ECO 461" && <span className="course-constraint-note">Senior-year Winter only{!course.fixedInProgress && !courseHasMoveControl(course) ? " · no other eligible term in this plan" : ""}</span>}
                                {course.fixedInProgress && <span>Taking now — fixed in this term</span>}
                                <CourseAvailabilityStatus course={course} term={term} schedule={schedule} referenceDate={new Date().toISOString()} />
                                {course.preliminaryScheduleEvidence && <span className="plan-course-availability">Preliminary schedule ({course.preliminaryScheduleEvidence.issuedOn}); course and term subject to change</span>}
                                {(course.planningMarkers || []).map(marker => <span className="plan-course-approval" key={marker}>{studentFriendlyCourseMarker(marker)}</span>)}
                              </div>
                              {course.offeringInformation && <span className="offering-pattern">{course.offeringInformation.label}</span>}
                              {onEditPlanCourse && !course.fixedInProgress && courseHasMoveControl(course) && <CourseChange
                                course={course} termId={termId} planId={activePlan.id} onEdit={onEditPlanCourse}
                                busy={Boolean(editingPlanCourseKey)} feedback={feedback}
                                onUndo={onUndoPlanEdit} canUndo={undoCourseId === courseId} />}

                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="empty-term">{studyAbroadIds.includes(term.slotId) ? "Study abroad" : "No courses placed"}</p>
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
    SEARCH_INCOMPLETE: "We could not find a complete plan yet",
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

function CandidateOutcomes({ outcomes = [], convergences = [], showReasons = true }) {
  if (!outcomes.length && !convergences.length) return null;
  return (
    <section className="candidate-outcomes" aria-label="Other planning results">
      {outcomes.length > 0 && (
        <ul>
          {outcomes.map(outcome => (
            <li key={`${outcome.id}-${outcome.label}`}>
              <strong>{outcome.label}:</strong> {feasibilityLabel(outcome.status)}
              {showReasons && outcome.reasons?.length > 0 && ` — ${outcome.reasons.map(item => item.reason || item.message || item).join("; ")}`}
            </li>
          ))}
        </ul>
      )}
      {convergences.map(item => <p key={`${item.keptPlanId}-${item.convergedPlanId}`}>{item.message}</p>)}
    </section>
  );
}

function comparisonScheduleRows(plan, studentCourses) {
  const rows = planTermsWithCurrentCourses(plan, studentCourses, COURSE_CATALOG)
    .map(term => ({
      key: `${term.academicYear || ""}-${term.isPlaceholder ? "TBC" : term.displayTerm || term.term}`,
      academicYear: formatAcademicYear(term.academicYear),
      term: term.isPlaceholder ? "Term to be confirmed" : studentTermLabel(term.displayTerm || term.term),
      sourceTerm: term,
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
  studyAbroad,
  planResult,
  fallbackPlanningContext,
  courses,
  view,
  selectedPlanId,
  isExiting,
  isGenerating,
  editingPlanCourseKey,
  planEditStatus,
  planEditFeedback,
  canUndoPlanEdit,
  undoPlanId,
  onEditCourses,
  onReviewTimeline,
  onClearAll,
  onBackToCompare,
  onSelectPlan,
  onRegenerate,
  onRegeneratePlan,
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
  const studyAbroadIds = studyAbroadTermIds(studyAbroad, buildPlanningSlots(comparisonContext));
  const advisorContext = studyAbroadAdvisorContext(studyAbroad);
  const canonicalPlanResult = result?.economicsPlanResult || planResult || null;
  const acceleratedResult = result?.economicsAcceleratedResult || null;
  const mergePossibleEarlyResult = acceleratedResult?.status === "POSSIBLE"
    && plans.some(plan => plan.id === "one-year-early");
  const [comparisonDrag, setComparisonDrag] = useState(null);
  const [comparisonDrop, setComparisonDrop] = useState(null);
  const [comparisonDropMessage, setComparisonDropMessage] = useState("");
  useEffect(() => { if (editingPlanCourseKey) setComparisonDrop(null); }, [editingPlanCourseKey]);
  const applyComparisonDrop = async (drop, trigger) => {
    setComparisonDrop(null); setComparisonDropMessage("");
    await onEditPlanCourse({ type: "move", planId: drop.planId, fromTermId: drop.fromTermId,
      courseId: planCourseIdentity(drop.course), toTermId: drop.destination.id }, trigger);
  };
  const [openCourseMenuId, setOpenCourseMenuId] = useState(null);
  const [confirmingCourseMenuId, setConfirmingCourseMenuId] = useState(null);
  useEffect(() => { setOpenCourseMenuId(null); setConfirmingCourseMenuId(null); }, [selectedPlanId, view]);
  useEffect(() => { if (openCourseMenuId) setComparisonDropMessage(""); }, [openCourseMenuId]);
  const [highlightDifferences, setHighlightDifferences] = useState(false);
  const resultHeadingRef = useRef(null);
  const isPlanView = view === PLANNER_VIEWS.PLAN;
  const selectedPlan = plans.find(plan => plan.id === selectedPlanId) || plans[0];
  const planningContext = isPlanView ? selectedPlan?.planningContext || comparisonContext : comparisonContext;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => resultHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [view]);

  const rowsByPlan = new Map(plans.map(plan => [plan.id, comparisonScheduleRows(plan, courses)]));
  const allRowKeys = new Set([...rowsByPlan.values()].flatMap(rows => rows.map(row => row.key)));
  const sharedCoursesByRow = new Map([...allRowKeys].map(key => {
    const courseSets = plans.map(plan => new Set(
      rowsByPlan.get(plan.id)?.find(item => item.key === key)?.courses || []
    ));
    const shared = [...new Set(courseSets.flatMap(set => [...set]))]
      .filter(course => courseSets.filter(set => set.has(course)).length > 1);
    return [key, new Set(shared)];
  }));
  const standing = studentStandingSummary(studyAbroad);
  const studyAbroadLabel = joinStudyAbroadTerms(studyAbroadIds.map(id => planningSlotsLabel(id, comparisonContext)));
  const graduationTarget = studentTermLabel(planningContext?.expectedGraduationTerm || "To be confirmed");
  const earlyGraduationTarget = !isPlanView && plans.find(plan => plan.id === "one-year-early")?.planningContext?.expectedGraduationTerm;
  const graduationTargetDisplay = earlyGraduationTarget && studentTermLabel(earlyGraduationTarget) !== graduationTarget
    ? `${graduationTarget} (one year early: ${studentTermLabel(earlyGraduationTarget)})`
    : graduationTarget;
  const completedCodes = courses.filter(isTaken).map(course => course.code);
  const inProgressCodes = courses.filter(course => course.status === "in_progress").map(course => course.code);
  const overallStatus = overallPlanReadiness(isPlanView && selectedPlan ? [selectedPlan] : plans);
  const noPlan = noPlanPresentation(canonicalPlanResult?.category, canonicalPlanResult?.reason, canonicalPlanResult?.evidence, COURSE_PREREQUISITES);
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
    <CourseMenuContext.Provider value={{ openId: openCourseMenuId, setOpenId: setOpenCourseMenuId, confirmingId: confirmingCourseMenuId, setConfirmingId: setConfirmingCourseMenuId }}>
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
        .course-editor-title { display: flex; justify-content: space-between; align-items: center; gap: .25rem; font-size: 13px; }
        .comparison-plan-details { margin: .6rem 0; text-align: left; }
        .comparison-plan-details .major-checklist { margin: .4rem 0; padding: 0; border: 0; box-shadow: none; }
        .comparison-plan-details .comparison-disclosure { margin: .25rem 0; }
        .comparison-plan-details .comparison-disclosure > summary { padding: .5rem; font-size: 13px; }
        .comparison-plan-details .plan-notes { margin: 0; padding: .5rem; font-size: 13px; }
        .comparison-page .plan-edit-instructions { margin: .7rem 0 0; padding: .65rem .85rem; border-left: 3px solid #8065b0; background: #eee9f6; border-radius: 0 .4rem .4rem 0; color: #30234c; }
        .comparison-page .plan-edit-instructions strong { display: block; font-size: 17px; line-height: 1.4; }
        .comparison-page .plan-edit-instructions span { display: block; margin-top: .2rem; font-size: 13px; color: #53617a; }
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
          overflow: visible;
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
        .comparison-plan-summary .plan-feasibility-value {
          margin-top: .45rem;
          font-size: 13px;
          font-weight: 650;
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
          padding: .3rem .4rem;
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
        .compact-schedule th:first-child { width: 6.4rem; }
        .compact-schedule th:nth-child(2) { width: 5.2rem; }
        .compact-schedule tbody tr[data-year-start="true"]:not(:first-child) > td { border-top: 2px solid #b7a8cf; }
        .compact-schedule td { font-size: 13px; }
        .compact-schedule td[rowspan] { white-space: nowrap; }
        .compact-schedule td.comparison-academic-year { color: #26364d; font-weight: 700; }
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
        .comparison-page .drag-plan-help { color: #475569; font-size: .9rem; }
        .comparison-page .drag-plan-status:empty { display: none; }
        .comparison-page .course-drag-handle { display: inline-block; padding: .35rem .55rem; margin-bottom: .4rem; border: 1px solid #c4b5df; border-radius: .4rem; color: #49317c; background: #f7f3ff; cursor: grab; user-select: none; touch-action: none; font-size: .8rem; }
        .comparison-page .course-drag-handle:active { cursor: grabbing; }
        .comparison-page .term-card.drop-allowed { border: 2px solid #168264; background: #effbf5; }
        .comparison-page .term-card.drop-conditional { border: 2px dashed #946200; background: #fffbeb; }
        .comparison-page .term-card.drop-unavailable, .comparison-page .term-card.drop-blocked, .comparison-page .term-card.drop-review_required { border-color: #a6a6af; background: #f3f3f5; }
        .comparison-page .drop-term-hint { font-size: .8rem; line-height: 1.4; }
        .comparison-page .drop-confirmation { padding: 1rem; margin-bottom: 1rem; border: 1px solid #946200; border-radius: .75rem; background: #fffbeb; }
        .comparison-page .drop-confirmation button { margin: .5rem .5rem 0 0; }
        .comparison-page .term-card.drop-pending, .comparison-page .compact-schedule tr.drop-pending { outline: 2px solid #946200; background: #fffbeb; }
        .comparison-page .drop-confirmation-popover { position: fixed; z-index: 50; margin: 0; padding: .75rem; max-height: calc(100vh - 24px); overflow-y: auto; box-shadow: 0 8px 28px #24174330; font-size: 14px; line-height: 1.4; }
        .comparison-page .drop-confirmation-popover p { margin: .5rem 0; font-size: 13px; overflow-wrap: anywhere; }
        .comparison-page .drop-confirmation-popover details { margin: .4rem 0; font-size: 12px; }
        .comparison-page .drop-confirmation-actions { display: flex; gap: .5rem; }
        .comparison-page .drop-confirmation-actions button { margin: .25rem 0 0; padding: .4rem .65rem; min-height: 36px; font-size: 13px; }
        .comparison-page .drop-confirmation-actions button:first-child { background: #49317c; border-color: #49317c; }
        .comparison-page .drop-confirmation-actions button:last-child { background: white; color: #49317c; border-color: #b8a7d0; }
        .comparison-page .term-card h4 { margin: 0 0 .65rem; color: #17345b; }
        .comparison-page .term-card ul { display: grid; gap: .55rem; margin: 0; padding: 0; list-style: none; }
        .comparison-page .term-card li { padding: .55rem; border: 1px solid #d2dbe6; border-radius: .35rem; }
        .comparison-page .plan-course-summary strong,
        .comparison-page .plan-course-summary span { display: block; }
        .comparison-page .plan-course-summary span { margin-top: .15rem; color: #53627a; font-size: 12px; }
        .comparison-page .plan-course-summary .plan-course-availability { font-weight: 700; }
        .comparison-page .plan-course-availability.is-open { color: #167c32; font-weight: 700; }
        .comparison-page .plan-course-availability.is-full { color: #b42318; font-weight: 700; }
        .comparison-page .plan-course-availability.is-unavailable,
        .comparison-page .plan-course-availability.is-unverified { color: #53627a; }
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
        .comparison-page .compact-schedule .comparison-editable-course { display: grid; gap: .05rem; padding: 0; font-size: 13px; }
        .comparison-page .comparison-course-controls { display: flex; flex-wrap: nowrap; align-items: flex-start; gap: .1rem; min-width: 0; }
        .comparison-page .comparison-editable-course .plan-course-actions { display: block; flex: 1; margin: 0; min-width: 0; }
        .comparison-page .comparison-editable-course .course-drag-handle { flex: 0 0 20px; padding: 2px; margin: 0; font-size: 15px; line-height: 24px; border: 0; background: transparent; text-align: center; }
        .comparison-page .comparison-editable-course .plan-course-actions > button { display: block; padding: 3px 2px; margin: 0; font-size: 16px; font-weight: 700; line-height: 1.3; min-height: 30px; width: auto; text-align: left; border: 0; border-radius: 4px; background: transparent; box-shadow: none; }
        .comparison-page .comparison-editable-course .plan-course-actions > button:hover { background: #f1ebfa; }
        .comparison-page .comparison-editable-course.comparison-different-course { background: #eee3ff; box-shadow: inset 4px 0 #6b3fa0; border-radius: 4px; }
        .comparison-page .comparison-editable-course.comparison-different-course button { color: #351b57; }
        .comparison-page .comparison-editable-course.comparison-shared-course button { color: #334155; }
        .comparison-page .comparison-fixed-course { display: grid; gap: 2px; margin-left: calc(20px + .1rem); padding: 3px 2px; line-height: 1.35; }
        .comparison-page .comparison-fixed-course strong { font-size: 16px; }
        .comparison-page .comparison-fixed-course small { font-size: 11px; font-weight: 400; color: #64748b; }
        .comparison-page .comparison-course-meta { display: grid; gap: .08rem; margin: 0 0 .25rem calc(20px + .1rem); color: #53627a; font-size: 12px; font-weight: 400; line-height: 1.35; }
        .comparison-page .comparison-course-meta .comparison-course-title { color: #3f4e64; font-size: 14px; line-height: 1.35; }
        .comparison-page .comparison-course-meta .plan-course-availability { font-size: 12px; }
        .comparison-page .comparison-course-meta .plan-course-approval strong { display: block; color: #76510b; font-weight: 700; }
        .comparison-page .comparison-course-meta .plan-course-approval span { display: block; color: #53627a; font-size: 12px; font-weight: 400; }
        .comparison-page .comparison-course-meta .course-constraint-note { color: #35445d; font-weight: 650; }
        .comparison-page .comparison-edit-status { margin: .25rem .7rem; font-size: 12px; }
        .comparison-page .comparison-undo { margin: .25rem .7rem; padding: .25rem .5rem; font-size: 12px; }
        .comparison-page .comparison-plan-card .comparison-undo,
        .comparison-page .comparison-plan-card .download-plan-button {
          display: block;
          box-sizing: border-box;
          width: calc(100% - 1.4rem);
          min-height: 44px;
          margin: .25rem .7rem;
          padding: .65rem .85rem;
          font-size: 14px;
          line-height: 1.2;
        }
        .comparison-page .comparison-plan-card .extra-course-picker { margin: .25rem .7rem; }
        .comparison-page .comparison-plan-card .extra-course-picker > button {
          box-sizing: border-box;
          width: 100%;
          min-height: 44px;
          margin: 0;
          padding: .65rem .85rem;
          font-size: 14px;
          line-height: 1.2;
        }
        .comparison-page .compact-schedule tr.drop-allowed { background: #eaf8f0; outline: 2px solid #168264; }
        .comparison-page .compact-schedule tr.drop-conditional { background: #fffbeb; outline: 2px dashed #946200; }
        .comparison-page .compact-schedule tr.drop-unavailable, .comparison-page .compact-schedule tr.drop-blocked, .comparison-page .compact-schedule tr.drop-review_required { background: #f3f3f5; outline: 2px solid #a6a6af; }
        .comparison-page .comparison-drop-hint { display: block; font-size: .7rem; font-weight: normal; }
        .comparison-page .download-plan-button { margin: .5rem 0; width: 100%; background: #49317c; border-color: #49317c; color: white; }
        .comparison-page .plan-course-actions { position: relative; }
        .comparison-page .course-change-panel { position: static; width: 100%; min-width: 0; box-sizing: border-box; margin: .25rem 0 .5rem; padding: .4rem; border: 1px solid #e4dfee; border-radius: .4rem; background: #faf8fd; display: grid; gap: .3rem; overflow-wrap: anywhere; }
        .comparison-page .course-change-panel .close-course-options { justify-self: end; width: auto; border: 0; background: transparent; padding: .2rem; font-size: 12px; min-height: 30px; }
        .comparison-page .change-option-group { margin: 0; padding: 0; }
        .comparison-page .change-option-group + .change-option-group { border-top: 1px solid #e4dfee; margin-top: .3rem; padding-top: .3rem; }
        .comparison-page .course-change-panel .change-menu-heading { display: block; padding: .3rem .5rem; font-size: 13px; color: #49317c; }
        .comparison-page .course-change-panel .change-menu-option { display: flex; align-items: center; justify-content: space-between; gap: .5rem; width: 100%; padding: .4rem .5rem; border: 0; border-radius: .35rem; background: transparent; box-shadow: none; color: #30234c; text-align: left; font-size: .85rem; min-height: 44px; }
        .comparison-page .course-change-panel .change-menu-option:hover,
        .comparison-page .course-change-panel .change-menu-option:focus-visible { background: #f1ebfa; }
        .comparison-page .change-menu-option small { display: block; flex-basis: 100%; color: #775715; font-size: 11px; font-weight: 400; }
        .comparison-page .course-change-panel .change-menu-option { flex-wrap: wrap; gap: .1rem; min-height: 36px; font-size: 13px; }
        .comparison-page .change-confirm-title { font-size: 14px; }
        .comparison-page .change-confirm-term { font-size: 13px; color: #53627a; }
        .comparison-page .change-confirm-actions { display: flex; gap: .5rem; }
        .comparison-page .course-change-panel .change-confirm-actions button { width: auto; min-height: 36px; padding: .35rem .75rem; font-size: 13px; }
        .comparison-page .change-confirm-actions button:first-child { background: #49317c; border-color: #49317c; color: white; }
        .comparison-page .course-change-panel .change-confirm-warning { color: #775715; font-size: 12px; }
        .comparison-page .course-change-panel > details { padding: .4rem .5rem; font-size: .75rem; }
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
        .comparison-page .result-progress { min-width: 0; max-width: 100%; }
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
        .comparison-page .result-diagnostics { font-size: 14px; line-height: 1.5; }
        .comparison-page .result-diagnostics > summary { font-size: 15px; }
        .plan-choice-explanations { margin: .65rem 0 0; }
        .plan-choice-explanations dt { font-weight: 650; }
        .plan-choice-explanations dd { margin: 0; min-width: 0; }
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
        .result-progress ol { display: flex; flex-wrap: wrap; gap: .65rem; margin: 0; padding: 0; list-style: none; }
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
          .compact-schedule th:first-child { width: 4.5rem; }
          .compact-schedule th:nth-child(2) { width: 3rem; }
          .compact-schedule td.comparison-academic-year { font-size: 12px; }
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
          <span>Graduation target: {graduationTargetDisplay}</span>
          {studyAbroadLabel && <><span aria-hidden="true">·</span><span>Study abroad: {studyAbroadLabel}</span></>}
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
                {isDownloadingPdf ? "Creating PDF..." : `Download PDF Report: ${selectedPlan?.label || "Your plan"}`}
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
            {isGenerating ? "Regenerating..." : "Regenerate all plans"}
          </button>
          {isPlanView && <button type="button" className="edit-courses-button" onClick={onEditCourses}>
            Edit answers
          </button>}
          <button type="button" className="edit-courses-button clear-all-results" onClick={onClearAll}>
            Clear all
          </button>
        </div>
      </header>

      <div className="comparison-content">
        {pdfStatus && <p className="pdf-download-status" role="status" aria-live="polite">{pdfStatus}</p>}
        <section className="comparison-course-status" aria-label="Selected course status">
          <p><strong>Class standing</strong><span>{standing}</span></p>
          <p><strong>Graduation target</strong><span>{graduationTargetDisplay}</span></p>
          {studyAbroadLabel && <p><strong>Study abroad</strong><span>{studyAbroadLabel}</span></p>}
          <p><strong>Completed</strong><span>{completedCodes.join(" · ") || "None"}</span></p>
          <p><strong>Taking now</strong><span>{inProgressCodes.join(" · ") || "None"}</span></p>
          <p><strong>{plans.length ? "Student readiness" : "Overall status"}</strong><span className="result-status-value">{displayedOverallStatus}</span>
            {isPlanView && selectedPlan && <><span className="result-feasibility-value">Plan feasibility: {({ VERIFIED_FEASIBLE: "Verified feasible", CONDITIONALLY_FEASIBLE: "Conditional plan", PRELIMINARY_ONLY: "Preliminary plan", SEARCH_INCOMPLETE: "More information needed", NOT_FEASIBLE: "Plan needs attention" })[selectedPlan.feasibilityStatus] || "Plan needs confirmation"}</span><span className="plan-feasibility-meaning">{feasibilityMeaning(selectedPlan.feasibilityStatus)}</span></>}
            {plans.length > 0 && <span className="result-status-reason">{STUDENT_READINESS_EXPLANATIONS[displayedOverallStatus]}</span>}
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
            <p className={plans.length ? "plan-edit-instructions" : undefined}>{plans.length
              ? <><strong>Click a course to see where it can move. You can also drag it by the ⠿ handle.</strong><span>While you drag, green terms are open, amber terms need a permission or check first, and gray terms show why the course can&apos;t go there.</span></>
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
            <strong>Purple bars show classes placed in only one plan.</strong> Classes in the same term in both plans have no bar.
          </p>
        )}

        {planEditStatus && <p className="plan-edit-status" role="status">{planEditStatus}</p>}
        {!isPlanView && <p role="status">{comparisonDropMessage}</p>}
        {!isPlanView && comparisonDrop && <MoveConfirmation drop={comparisonDrop} onApply={applyComparisonDrop}
          onCancel={() => setComparisonDrop(null)} busy={Boolean(editingPlanCourseKey)} />}
        {isPlanView ? (
          <PlanTimeline
            plans={plans}
            studentCourses={courses}
            studyAbroadIds={studyAbroadIds}
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
              const mathSequenceNotes = acceleratedMathSequenceNotes(plan, COURSE_PREREQUISITES);
              const planFeasibility = ({ VERIFIED_FEASIBLE: "Verified feasible", CONDITIONALLY_FEASIBLE: "Conditional plan", PRELIMINARY_ONLY: "Preliminary plan", SEARCH_INCOMPLETE: "More information needed", NOT_FEASIBLE: "Plan needs attention" })[plan.feasibilityStatus] || "Plan needs confirmation";
              const showEarlyGraduationDetails = mergePossibleEarlyResult && plan.id === "one-year-early";
              return (
                <article
                  className={`comparison-plan-card${selected ? " is-selected" : ""}`}
                  data-plan-id={plan.id}
                  role="region"
                  aria-labelledby={`comparison-plan-title-${plan.id}`}
                  key={plan.id}
                >
                  <div className="comparison-plan-summary">
                    <div className="plan-title-row">
                      <h2 id={`comparison-plan-title-${plan.id}`}>{plan.label}</h2>
                      {planBadge(plan) && <span className="plan-strategy-badge">{planBadge(plan)}</span>}
                      {showEarlyGraduationDetails && <span className="early-plan-status">Possible</span>}
                    </div>
                    {!showEarlyGraduationDetails && <p>{planDescription(plan)}</p>}
                    <p className="plan-feasibility-value">Plan feasibility: {planFeasibility}</p>
                    <p className="plan-feasibility-meaning">{feasibilityMeaning(plan.feasibilityStatus)}</p>
                    {showEarlyGraduationDetails && (
                      <dl className="accelerated-target-list early-plan-graduation-dates" aria-label="Graduation dates">
                        <div><dt>Standard plan</dt><dd>{studentTermLabel(acceleratedResult.standardTarget)}</dd></div>
                        <div><dt>This plan</dt><dd>{studentTermLabel(acceleratedResult.acceleratedTarget || "To be confirmed")}</dd></div>
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
                          <tr key={`${plan.id}-${row.key}`} data-year-start={row.yearRowSpan ? "true" : "false"} data-term-id={row.sourceTerm.slotId || row.sourceTerm.term} data-plan-scope={plan.id}
                            className={comparisonDrop?.planId === plan.id && comparisonDrop.destination.id === (row.sourceTerm.slotId || row.sourceTerm.term) ? "drop-pending" : comparisonDrag?.planId === plan.id ? `drop-${(comparisonDrag.course.moveDestinationOptions?.find(option => option.id === (row.sourceTerm.slotId || row.sourceTerm.term))?.status || "unavailable").toLowerCase()}` : undefined}>
                            {row.yearRowSpan && <td className="comparison-academic-year" rowSpan={row.yearRowSpan}>{row.academicYear}</td>}
                            <td>{row.term}</td>
                            <td>
                              {row.sourceTerm.courses.length > 0 ? row.sourceTerm.courses.map(course => {
                                const courseId = planCourseIdentity(course);
                                const termId = row.sourceTerm.slotId || row.sourceTerm.term;
                                return <div className={`comparison-editable-course${highlightDifferences ? sharedCoursesByRow.get(row.key)?.has(compactPlanCourse(course)) ? " comparison-shared-course" : " comparison-different-course" : ""}`} data-requirement-id={courseId} key={courseId}>
                                  {!course.fixedInProgress && courseHasMoveControl(course) ? <div className="comparison-course-controls">
                                    <CourseDragHandle compact course={course} termId={termId} planId={plan.id}
                                      busy={Boolean(editingPlanCourseKey) || isGenerating || isDownloadingPdf}
                                      setPendingDrop={setComparisonDrop} setDropMessage={setComparisonDropMessage}
                                      setDraggedCourse={setComparisonDrag} applyDrop={applyComparisonDrop} />
                                    <CourseChange compact course={course} termId={termId} planId={plan.id} onEdit={onEditPlanCourse}
                                      busy={Boolean(editingPlanCourseKey) || isGenerating || isDownloadingPdf} />
                                    {course.extra === true && <small>Extra</small>}
                                  </div> : <span className="comparison-fixed-course"><strong>{compactPlanCourse(course)}</strong>{course.fixedInProgress && <small>Taking now</small>}</span>}
                                  <div className="comparison-course-meta">
                                    {course.title && course.course !== "ECO elective" && <span className="comparison-course-title">{courseTitle(course.course)}</span>}
                                    {course.course === "ECO elective" && <span>Future offering unconfirmed</span>}
                                    <CourseAvailabilityStatus course={course} term={row.sourceTerm} schedule={result?.annualSchedule} referenceDate={new Date().toISOString()} />
                                    {course.preliminaryScheduleEvidence && <span>Preliminary schedule ({course.preliminaryScheduleEvidence.issuedOn}); course and term subject to change</span>}
                                    {(course.planningMarkers || []).filter(marker => marker !== "Approval required" || course.approvalRequired?.length).map(marker => marker === "Approval required"
                                      ? <div className="plan-course-approval" key={marker}>
                                        <strong>Approval needed</strong>
                                        {(course.approvalRequired || []).map((approval, index) => {
                                          const authority = approval.authority || (approval.type === "instructor" ? `${course.course} instructor` : "Economics Department");
                                          return <span key={`${approval.prerequisite || "prerequisite"}-${index}`}>
                                            {approval.prerequisite
                                              ? `Taking ${approval.prerequisite} and ${course.course} in the same term requires approval from the ${authority}.`
                                              : `A concurrent prerequisite requires approval from the ${authority}.`}
                                          </span>;
                                        })}
                                      </div>
                                      : <span className="plan-course-approval" key={marker}>{studentFriendlyCourseMarker(marker)}</span>)}
                                    {course.course === "ECO 461" && <span className="course-constraint-note">Senior-year Winter only{!course.fixedInProgress && !courseHasMoveControl(course) ? " · no other eligible term in this plan" : ""}</span>}
                                  </div>
                                </div>;
                              }) : <span className="comparison-empty-term">{studyAbroadIds.includes(row.sourceTerm.slotId) ? "Study abroad" : "No major course assigned"}</span>}
                              {comparisonDrag?.planId === plan.id && <small className="comparison-drop-hint">{(() => {
                                const option = comparisonDrag.course.moveDestinationOptions?.find(item => item.id === (row.sourceTerm.slotId || row.sourceTerm.term));
                                return option?.status === "CURRENT" ? "Current term" : option?.status === "ALLOWED" ? "Drop here" : option?.status === "CONDITIONAL" ? "Drop to review conditions" : studentFriendlyUnavailableReason(option);
                              })()}</small>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}

                  {advisorContext.length > 0 && <section className="plan-notes" data-student-advisor-context><h3>Ask your advisor</h3><ul>{advisorContext.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}

                  {planEditFeedback?.planId === plan.id && <p className="comparison-edit-status" role={planEditFeedback.failed ? "alert" : "status"}>{planEditFeedback.message}</p>}
                  {undoPlanId === plan.id && <button className="comparison-undo" type="button" disabled={Boolean(editingPlanCourseKey)} onClick={onUndoPlanEdit}>Undo last plan edit</button>}
                  <ExtraCoursePicker plan={plan} onEdit={onEditPlanCourse} busy={Boolean(editingPlanCourseKey) || isGenerating || isDownloadingPdf} />
                  <button type="button" className="comparison-undo" disabled={isGenerating || Boolean(editingPlanCourseKey) || isDownloadingPdf}
                    aria-label={`Regenerate this plan: ${plan.label}`} onClick={() => onRegeneratePlan(plan.id)}>Regenerate this plan</button>
                  <button type="button" className="download-plan-button" disabled={invalid || isGenerating || isDownloadingPdf || Boolean(editingPlanCourseKey)}
                    aria-label={`Download PDF Report: ${plan.label}`} onClick={event => {
                      downloadButtonRef.current = event.currentTarget;
                      onDownloadPdf(plan.id);
                    }}>{isDownloadingPdf ? "Creating PDF…" : `Download PDF Report: ${plan.label}`}</button>
                  <div className="comparison-plan-details">
                    <details className="comparison-disclosure"><summary>Things to keep in mind</summary>
                      <PlanConditions plan={plan} catalog={report?.catalog} hideHeading />
                    </details>
                    <MajorRequirementsChecklist plan={plan} />
                    <details className="comparison-disclosure"><summary>More about this plan</summary>
                      <div className="comparison-disclosure-content">
                        {mathSequenceNotes.length > 0 && <ul className="plan-notes">
                          {mathSequenceNotes.map(note => <li className="accelerated-math-sequence-note" role="note" key={note}>{note}</li>)}
                        </ul>}
                        <AdvisorAttention plan={plan} />
                      </div>
                    </details>
                  </div>
                  {planReadinessLabel(plan) !== displayedOverallStatus && <p className={`plan-validation${plan.validation?.valid === false ? " is-invalid" : ""}`}>
                    {planReadinessLabel(plan)}
                  </p>}
                </article>
              );
            })}
          </div>
        ) : (
          <section className="no-plan-state">
            <h2 role="status">{noPlan.title}</h2>
            <p>{noPlan.message}</p>
            <PlanConditions catalog={{ advisorAttention: (report?.catalog?.advisorAttention || []).filter(item => item.category === "ELECTIVE_PETITION") }} />
            {canonicalPlanResult?.questions?.length > 0 && (
              <ul className="no-plan-question-list">
                {canonicalPlanResult.questions.map((question, index) => (
                  <li key={question.id || `${question.code || "question"}-${index}`}>
                    {structuredItemText(question, "Answer this question so we can make your plan.")}
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
              <div><dt>Standard target</dt><dd>{studentTermLabel(acceleratedResult.standardTarget)}</dd></div>
              <div><dt>Accelerated target</dt><dd>{studentTermLabel(acceleratedResult.acceleratedTarget || "To be confirmed")}</dd></div>
            </dl>
            {acceleratedResult.status !== "POSSIBLE" && acceleratedResult.message && <p>{acceleratedResult.message}</p>}
          </section>
        )}
        {isPlanView && selectedPlan?.majorRequirementsChecklist?.unmetRequirements?.length > 0 && <section className="incomplete-candidate">
          <strong>Unmet requirements</strong><ul>{selectedPlan.majorRequirementsChecklist.unmetRequirements.map(row => <li key={row.id}>{row.label}: {row.courseTerm}{row.markers?.length > 0 && `; ${row.markers.join("; ")}`}</li>)}</ul>
        </section>}
        {isPlanView && selectedPlan && <PlanConditions plan={selectedPlan} catalog={report?.catalog} showPlanName={!isPlanView} />}
        {isPlanView && advisorContext.length > 0 && <section className="plan-notes" data-student-advisor-context><h2>Ask your advisor</h2><ul>{advisorContext.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}

        {isPlanView && selectedPlan && (
          <>
            <MajorRequirementsChecklist plan={selectedPlan} showPlanName={!isPlanView} />
            <details className="comparison-disclosure"><summary>More about this plan</summary><div className="comparison-disclosure-content"><AdvisorAttention plan={selectedPlan} /></div></details>
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
    </CourseMenuContext.Provider>
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
    return "Needs confirmation";
  }
  if (readiness === "STUDENT_READY" || disposition.includes("STUDENT_READY")) return "Ready to plan";
  return "Needs advisor attention";
}

function overallPlanReadiness(plans = []) {
  const labels = plans.map(planReadinessLabel);
  if (labels.includes("Needs advisor attention")) return "Needs advisor attention";
  if (labels.includes("Needs confirmation")) return "Needs confirmation";
  return plans.length ? "Ready to plan" : "Not available";
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
        <CandidateOutcomes outcomes={otherOutcomes} convergences={convergences} showReasons={planCount > 0 || !planningGaps.length} />
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
          <dd>{studentTermLabel(standardPlanningContext?.expectedGraduationTerm || "To be confirmed")}</dd>
        </div>
        {earlyContext?.expectedGraduationTerm && (
          <div>
            <dt>One-year-early target</dt>
            <dd>{studentTermLabel(earlyContext.expectedGraduationTerm)}</dd>
          </div>
        )}
        {planningContext.customGraduationEnabled && (
          <div>
            <dt>Custom graduation target</dt>
            <dd>{studentTermLabel(planningContext.customGraduationValidation.valid ? planningContext.expectedGraduationTerm : "Needs more information")}</dd>
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
            <dd>No Economics courses in {joinStudyAbroadTerms(studyAbroadTermIds(formData, buildPlanningSlots(planningContext)).map(id => planningSlotsLabel(id, planningContext)))}</dd>
          </div>
        )}
        {Object.entries(formData.reservedCourseUnits || {}).some(([, value]) => Number(value) > 0) && (
          <div>
            <dt>Room for other courses</dt>
            <dd>{Object.entries(formData.reservedCourseUnits)
              .filter(([slotId, value]) => Number(value) > 0 && !studyAbroadTermIds(formData, buildPlanningSlots(planningContext)).includes(slotId))
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
  const [linkedPlanError, setLinkedPlanError] = useState("");
  const [courseSearch, setCourseSearch] = useState("");
  const [completionSourceCourseCode, setCompletionSourceCourseCode] = useState("");
  const [intakeStep, setIntakeStep] = useState(1);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [migrationNotice, setMigrationNotice] = useState("");
  const [inputBlock, setInputBlock] = useState(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [answersSaveFailed, setAnswersSaveFailed] = useState(false);
  const [planSaveFailed, setPlanSaveFailed] = useState(false);
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
  const catalogPlanningNote = planningRequirementsNote(planningContext);
  const planningSlots = buildPlanningSlots(planningContext);
  const juniorStudyAbroadSlots = planningSlots.filter(slot => !slot.isSummer && slot.absoluteStandingIndex === 2);
  const planningSlotIdSignature = planningSlots.map(slot => slot.id).join("|");
  const planningStart = planningSlots[0]?.label || "To be confirmed";
  const inputPrerequisiteValidation = validateStudentPrerequisites(formData.courses, COURSE_PREREQUISITES);
  const pendingDependentCourseCodes = [...new Set(inputPrerequisiteValidation.issues.map(item => item.course))];
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

  function plannerUrl(view) {
    const url = new URL(window.location.href);
    if (view === PLANNER_VIEWS.INPUT) {
      url.searchParams.delete("view");
      url.searchParams.delete("plan");
    } else {
      url.searchParams.set("view", PLANNER_VIEWS.COMPARE);
      url.searchParams.delete("plan");
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
      ? nextView === PLANNER_VIEWS.PLAN ? PLANNER_VIEWS.COMPARE : nextView
      : PLANNER_VIEWS.INPUT;
    const historyState = {
      econPlanner: true,
      view: safeView,
      planId: safePlanId,
      previousView: plannerView
    };
    window.history[replace ? "replaceState" : "pushState"](
      historyState,
      "",
      plannerUrl(safeView)
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
      const linkedParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      if (linkedParams.has("openPlan")) {
        const stateToken = linkedParams.get("openPlan");
        const planId = linkedParams.get("plan");
        // Remove the encrypted bearer token from the browser URL before redeeming it.
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
        try {
          setRestorationProgress("Opening your EconPlanner plan…");
          const openedResponse = await fetch("/api/mcp/open-plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stateToken, planId }),
            signal: controller.signal
          });
          if (!openedResponse.ok) throw new Error(openedResponse.status === 503
            ? "This plan link could not be checked right now. Please try opening it again later."
            : "This plan link is invalid, expired, or no longer matches current planning rules. Ask ChatGPT for a new link.");
          const opened = await openedResponse.json();
          const openedForm = {
            ...initialForm,
            ...opened.student,
            courses: migrateSavedCourses(opened.student?.courses),
            planCreationDateEdited: true
          };
          const inputSignature = plannerInputSignature(openedForm);
          setRestorationProgress("Checking the linked plans…");
          const generatedResponse = await fetch("/api/majors/map", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ student: opened.student }),
            signal: controller.signal
          });
          const generated = await generatedResponse.json();
          if (!generatedResponse.ok || !isValidGeneratedPlannerReport(generated)
            || generated.plannerFingerprint !== opened.plannerFingerprint) {
            throw new Error("This plan link no longer passes current planning checks. Ask ChatGPT for a new link.");
          }
          const generatedPlans = economicsResult(generated).economicsPlans;
          if (!Array.isArray(opened.plans) || opened.plans.length !== generatedPlans.length
            || opened.plans.some(plan => !generatedPlans.some(candidate => candidate.id === plan.id))) {
            throw new Error("This plan link does not contain a current plan. Ask ChatGPT for a new link.");
          }
          let preparedReport = generated;
          for (const plan of opened.plans) preparedReport = replaceEconomicsPlan(preparedReport, plan.id, plan);
          const reportContextId = crypto.randomUUID();
          const checked = await validateSavedPlannerSession({
            rawSession: createGeneratedPlannerSession({
              report: preparedReport, inputSignature, selectedPlanId: opened.planId,
              view: PLANNER_VIEWS.COMPARE, reportContextId
            }),
            inputSignature, student: opened.student, signal: controller.signal,
            onProgress: message => { if (!cancelled) setRestorationProgress(message); }
          });
          if (checked.kind !== "restored" || checked.session.selectedPlanId !== opened.planId) {
            throw new Error(checked.kind === "unavailable"
              ? "This plan link could not be checked right now. Please try opening it again later."
              : "This plan link no longer passes current planning checks. Ask ChatGPT for a new link.");
          }
          if (cancelled || controller.signal.aborted) return;
          reportContextIdRef.current = reportContextId;
          generatedInputSignatureRef.current = inputSignature;
          setFormData(openedForm);
          setIntakeStep(2);
          setInputBlock(null);
          setReport(checked.session.report);
          setSelectedPlanId(opened.planId);
          setPlannerView(PLANNER_VIEWS.COMPARE);
          setStatus("");
          window.history.replaceState(
            { econPlanner: true, view: PLANNER_VIEWS.COMPARE, planId: opened.planId, previousView: null },
            "", plannerUrl(PLANNER_VIEWS.COMPARE)
          );
          window.history.scrollRestoration = "manual";
          window.scrollTo({ top: 0, left: 0, behavior: "auto" });
          setIsHydrated(true);
        } catch (error) {
          if (cancelled || controller.signal.aborted) return;
          setLinkedPlanError(error.message || "This plan link could not be opened. Ask ChatGPT for a new link.");
          setIsHydrated(true);
        }
        return;
      }
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
        plannerUrl(initialView)
      );
      window.history.scrollRestoration = "manual";
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      setIsHydrated(true);
    }
    void restoreSession();
    return () => { cancelled = true; controller.abort(); };
  }, [restorationAttempt]);

  useEffect(() => {
    if (!isHydrated || linkedPlanError) return;

    try {
      window.localStorage.setItem(PLANNER_STORAGE_KEY, JSON.stringify({
        schemaVersion: PLANNER_STORAGE_VERSION,
        formData,
        courseSearch,
        intakeStep
      }));
      setAnswersSaveFailed(false);
    } catch {
      setAnswersSaveFailed(true);
    }
  }, [courseSearch, formData, intakeStep, isHydrated, linkedPlanError]);

  useEffect(() => {
    if (!isHydrated || !formData.studyAbroadTerm) return;
    const valid = planningSlots.some(slot => slot.id === formData.studyAbroadTerm);
    if (valid) return;
    setFormData(current => updateStudyAbroadReservation(current, "", false, planningSlots));
  }, [formData.studyAbroadTerm, isHydrated, planningSlotIdSignature]);

  useEffect(() => {
    if (!isHydrated || linkedPlanError) return;
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
        setPlanSaveFailed(false);
      } else if (!recoverableSessionRef.current) {
        window.sessionStorage.removeItem(GENERATED_PLANNER_SESSION_KEY);
        setPlanSaveFailed(false);
      }
    } catch {
      setPlanSaveFailed(true);
    }
  }, [inputBlock, isHydrated, linkedPlanError, planEditUndo, plannerView, report, selectedPlanId]);

  useEffect(() => {
    if (!isHydrated) return undefined;

    function handlePlannerHistory(event) {
      const requestedView = event.state?.econPlanner
        ? event.state.view
        : plannerViewFromSearch(window.location.search);
      const plans = economicsResult(report)?.economicsPlans || [];
      const requestedPlanId = event.state?.planId || new URLSearchParams(window.location.search).get("plan");
      const safeView = requestedView === PLANNER_VIEWS.PLAN ? PLANNER_VIEWS.COMPARE : requestedView;

      const safePlanId = plans.some(plan => plan.id === requestedPlanId)
        ? requestedPlanId
        : plans[0]?.id || "";
      if (planEditInFlightRef.current) {
        planEditRequestRef.current += 1;
        planEditAbortRef.current?.abort();
        planEditAbortRef.current = null;
        planEditInFlightRef.current = false;
        setEditingPlanCourseKey("");
        setPlanEditFeedback(null);
      }
      setSelectedPlanId(safePlanId);
      setPlannerView(safeView);
      setPlanEditStatus("");
      if (safeView !== requestedView) {
        window.history.replaceState(
          { ...window.history.state, econPlanner: true, view: safeView, planId: safePlanId },
          "",
          plannerUrl(safeView)
        );
      }
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
    setFormData(current => updateStudyAbroadReservation(current, nextTermId,
      Boolean(followingMayId(nextTermId, planningSlots) && current.studyAbroadMayOverlap), planningSlots));
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

  async function mapMajors(event, regeneratePlanId = null) {
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
      if (regeneratePlanId) {
        const replacement = plans.find(plan => plan.id === regeneratePlanId);
        if (!replacement) throw new Error("This plan could not be regenerated. Your existing plan is unchanged.");
        const peers = (economicsResult(report)?.economicsPlans || []).map(plan => plan.id === regeneratePlanId ? replacement : plan);
        const checkedResponse = await fetch("/api/majors/map", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ action: "validate-plan", student, plan: compactEconomicsPlanForValidation(replacement), plans: peers.map(compactEconomicsPlanForValidation) })
        });
        const checked = await checkedResponse.json();
        if (requestId !== generationRequestRef.current || controller.signal.aborted) return;
        if (!checkedResponse.ok || !checked.plan?.validation?.valid || !checked.planSetValidation?.valid) throw new Error(checked.error || "The regenerated plan could not be validated. Your existing plans are unchanged.");
        if (plannerInputSignature(latestFormRef.current) !== requestSignature) throw new Error("Your answers changed. Generate again with your current answers.");
        const updated = replaceEconomicsPlan(report,regeneratePlanId,checked.plan,checked.planSetValidation);
        latestReportRef.current = updated;
        setReport(updated);
        setPlanEditUndo(null);
        setPlanEditFeedback({planId:regeneratePlanId,message:"This plan was regenerated."});
        setPlanEditStatus("");
        setStatus("");
        return;
      }
      const firstPlanId = plans[0]?.id || "";
      generatedInputSignatureRef.current = requestSignature;
      setIsComparisonExiting(false);
      setInputBlock(null);
      setReport(data);
      setSelectedPlanId(firstPlanId);
      setPlanEditStatus(plans.length ? "" : "Plan review ready.");
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
        plannerUrl(PLANNER_VIEWS.COMPARE)
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

  async function downloadSelectedPlanPdf(planId = selectedPlanId) {
    if (pdfDownloadInFlightRef.current || planEditInFlightRef.current || generationInFlightRef.current) return;
    const selectedPlan = (economicsResult(report)?.economicsPlans || [])
      .find(plan => plan.id === planId);
    if (!selectedPlan) {
      setPdfStatus("Choose a plan before downloading its PDF.");
      return;
    }

    pdfDownloadInFlightRef.current = true;
    const controller = new AbortController();
    pdfDownloadAbortRef.current = controller;
    setIsDownloadingPdf(true);
    setPdfStatus("Creating your PDF...");
    if (pdfOperationRef.current?.selectedPlan?.id !== selectedPlan.id) pdfOperationRef.current = null;
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

  function renderStatusControls(code, labelPrefix = code, compact = false) {
    const course = formData.courses.find(item => item.code === code) || blankCourse({ code, title: courseTitle(code), units: 1 });
    const activeStatus = visibleCourseStatus(course);
    const statusChoices = [
      ["completed", "Completed"],
      ["in_progress", "Taking now"]
    ];
    return (
      <div className={`course-toggles${compact ? " is-compact" : ""}`} role="group" aria-label={`Status for ${labelPrefix}`}>
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
          <p role="status"><strong>Prerequisites for {course.code}</strong></p>
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
                {renderStatusControls(option, `prerequisite ${option}`, true)}
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
                  <p>Your advisor needs to confirm that this credit counts toward your degree.</p>
                )}
              </div>
            )}
          </div>
        )}
        {course && ["completed", "transfer"].includes(course.status) && historicalPrerequisiteGaps(course.code, formData.courses, prerequisitePolicy.records).map(gap => (
          <p className="prerequisite-conflict" role="status" key={gap.label}>{historicalPrerequisiteMessage(gap)}</p>
        ))}
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
      if (!selectedCourse && edit.type !== "add-extra") {
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
          throw new Error(data.plan?.validation?.errors?.[0] || "This change does not meet a requirement. Ask your advisor which one.");
        }
        if (data.planSetValidation?.valid !== true) {
          throw new Error(data.planSetValidation?.errors?.[0] || "These plans can no longer be compared. Check that they use the same student answers and graduation goal.");
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
        const resultMessage = `${edit.type === "move" ? `Moved to ${targetTerm?.term || "selected term"}` : edit.type === "add-extra" ? "Extra course added" : edit.type === "remove-extra" ? "Extra course removed" : "Course updated"}.${changedCourse?.publicationStatus === "PLANNING_PROJECTION" ? "" : " Plan checks pass."}`;
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

  const saveWarning = (answersSaveFailed || planSaveFailed) ? (
    <div role="alert" style={{ margin: "1rem", padding: "1rem", border: "2px solid #946200", background: "#fff8e8", color: "#503600", lineHeight: 1.5 }}>
      Your {answersSaveFailed && planSaveFailed ? "answers and plan changes are" : answersSaveFailed ? "answers are" : "plan changes are"} unsaved.
      {" "}You can keep working here, but these changes may be lost if you reload or close this page.
    </div>
  ) : null;

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

  if (linkedPlanError) {
    return (
      <main className="planner-loading">
        <h1>Could not open this plan</h1>
        <p role="alert">{linkedPlanError}</p>
        <a href="/">Open EconPlanner without this link</a>
      </main>
    );
  }

  if (isHydrated && (report || inputBlock) && plannerView !== PLANNER_VIEWS.INPUT) {
    return (
      <>
        {saveWarning}
        <PlanComparisonScreen
          report={report}
          studyAbroad={formData}
          planResult={inputBlock?.economicsPlanResult}
          fallbackPlanningContext={planningContext}
          courses={formData.courses}
          view={plannerView}
          selectedPlanId={selectedPlanId}
          isExiting={isComparisonExiting}
          isGenerating={isGenerating}
          editingPlanCourseKey={editingPlanCourseKey}
          planEditStatus={planEditStatus}
          planEditFeedback={planEditFeedback}
          undoPlanId={planEditUndo?.planId}
          canUndoPlanEdit={planEditUndo?.planId === selectedPlanId ? (planEditUndo.courseId || "__plan__") : null}
          onEditCourses={returnToCourseSelection}
          onReviewTimeline={() => returnToInputStep(1)}
          onClearAll={() => setClearDialogOpen(true)}
          onBackToCompare={() => navigateBackTo(PLANNER_VIEWS.COMPARE)}
          onSelectPlan={planId => navigatePlanner(PLANNER_VIEWS.COMPARE, planId)}
          onRegenerate={() => mapMajors()}
          onRegeneratePlan={planId => mapMajors(null, planId)}
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
      {saveWarning}
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
        .non-major-fields select, .study-abroad-fields select, .study-abroad-fields input[type="text"], .study-abroad-fields textarea { min-height: 40px; padding: .45rem .55rem; border: 1px solid var(--cp7-border-strong); border-radius: 6px; background: #fff; font: inherit; }
        .study-abroad-fields textarea { min-height: 88px; resize: vertical; }
        .study-abroad-fields label:has(input[type="checkbox"]) { display: flex; align-items: flex-start; gap: .45rem; }
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
                    Based on {planningContext.standingLabel.toLowerCase()} standing, we’ll plan through <strong>{studentTermLabel(planningContext.expectedGraduationTerm)}</strong>.
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
                      <span>My schedule for {studentTermLabel(planningContext.currentTermPlanningWindow.displayTerm)} is already set — don&apos;t add courses to this term.</span>
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
                    <p>Standard target: {studentTermLabel(planningContext.expectedGraduationTerm)}. Accelerated target: {studentTermLabel(buildEarlyGraduationContext(planningContext)?.expectedGraduationTerm)}.</p>
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
                        setStatus("We turned off the one-year-early option because you chose a different graduation year.");
                      }
                    }}
                  >
                    My expected graduation year is different
                  </button>
                  {!formData.customGraduationEnabled && <p className="custom-timeline-copy">Use this only when the standard target shown above does not fit your situation.</p>}
                  {formData.customGraduationEnabled && (
                    <div className="custom-timeline-panel" id="custom-timeline-panel">
                      <p className="custom-timeline-copy">This changes the graduation date used to make your plan. It does not add credit or change your degree requirements.</p>
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
                              <option value={year} key={year}>May {year}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <p className="custom-target"><strong>Custom target:</strong> {studentTermLabel(planningContext.customGraduationValidation.valid ? planningContext.expectedGraduationTerm : "Choose a graduation year above.")}</p>
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
                {catalogPlanningNote && <div className="catalog-planning-note">
                  <strong>{catalogPlanningNote.heading}</strong>
                  {catalogPlanningNote.details.map(detail => <p key={detail}>{detail}</p>)}
                </div>}
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
                          {formData.studyAbroadTerm && followingMayId(formData.studyAbroadTerm, planningSlots) && (
                            <label><input type="checkbox" checked={formData.studyAbroadMayOverlap === true}
                              onChange={event => {
                                setFormData(current => updateStudyAbroadReservation(current, current.studyAbroadTerm, event.target.checked, planningSlots));
                                clearInputFeedback();
                              }} /> Also reserve the following May for a possible study-abroad overlap</label>
                          )}
                          {formData.studyAbroadTerm && <>
                            <label><span>Destination or possibility (optional)</span><input type="text" maxLength={300}
                              placeholder="Australia is one possible destination."
                              value={formData.studyAbroadDestination || ""}
                              onChange={event => { setFormData(current => ({ ...current, studyAbroadDestination: event.target.value })); clearInputFeedback(); }} /></label>
                            <label><span>Note for your advisor (optional)</span><textarea maxLength={1000}
                              placeholder="Some courses taken abroad, especially Economics electives, may count toward Hanover’s Economics major. Check with your advisor or the Economics department once your course list is available."
                              value={formData.studyAbroadAdvisingNote || ""}
                              onChange={event => { setFormData(current => ({ ...current, studyAbroadAdvisingNote: event.target.value })); clearInputFeedback(); }} /></label>
                            <p>No Economics courses will be scheduled in {joinStudyAbroadTerms(studyAbroadTermIds(formData, planningSlots).map(id => planningSlotsLabel(id, planningContext)))}. Courses abroad are not counted toward the major until confirmed.</p>
                          </>}
                        </div>
                      )}
                      <h3>Recorded overload approval</h3>
                      <p>If your advisor already approved a heavier course load, record it for that term. EconPlanner cannot grant approval. Extra courses may increase tuition. This plan does not know your full schedule or bill.</p>
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
                      <p className="custom-timeline-copy">Choose how much room to leave for classes outside the Economics major: none, one, or two course units. The choices shown stay within each term’s normal course limit.</p>
                      <div className="non-major-fields">
                        {planningSlots.filter(slot => !slot.isSummer).map(slot => (
                          <label key={slot.id}>
                            <span>{slot.label}</span>
                            <select
                              value={studyAbroadTermIds(formData, planningSlots).includes(slot.id)
                                ? termReservationLimit(slot)
                                : Number(formData.reservedCourseUnits?.[slot.id] || 0)}
                              disabled={studyAbroadTermIds(formData, planningSlots).includes(slot.id)}
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
                              {studyAbroadTermIds(formData, planningSlots).includes(slot.id) && termReservationLimit(slot) > 2 && (
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
