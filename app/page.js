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
import { isUnpublishedScheduleCondition, preliminaryScheduleExplanation, studentFriendlyCourseMarker, studentFriendlyUnavailableReason, studentFriendlyMoveCondition, studentFriendlyMoveDetails, studentFriendlyMoveNextStep, studentStandingSummary, studentTermLabel } from "../lib/planning/student-language.js";
import { comparisonStyles } from "./styles/comparisonStyles";
import { plannerStyles } from "./styles/plannerStyles";

const PLANNER_STORAGE_KEY = "econ-planner-ui-state";
const GENERATED_PLANNER_SESSION_KEY = "econ-planner-generated-session";
const PLANNER_STORAGE_VERSION = PLANNER_INPUT_STATE_VERSION;
const STUDENT_READINESS_EXPLANATIONS = Object.freeze({
  "Ready to plan": "The plan meets the major rules. Check seats and future schedules before you register.",
  "Needs confirmation": "Check the approval and standing notes on each plan before registering.",
  "Needs advisor attention": "Ask your advisor to review the reason below before relying on this plan."
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
  const visibleItems = items.filter(item => item.studentVisible !== false);
  if (!visibleItems.length) return null;
  return (
    <div className="plan-notes planning-gaps">
      <strong>What still needs attention</strong>
      <ul>
        {visibleItems.map((item, index) => (
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
  const seatConditions = conditions.filter(item => ["seat", "registration"].includes(item.kind));
  const otherConditions = conditions.filter(item => !["prerequisite", "seat", "registration"].includes(item.kind));
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
        <td>{row.course ? <><strong>{row.course}</strong>{row.term && ` — ${studentTermLabel(row.term)}`}</> : studentTermLabel(row.courseTerm)}</td>
        <td><span className={`checklist-status is-${row.status}`}><span className="checklist-symbol" aria-hidden="true">{row.symbol}</span> {row.statusLabel}</span>
          {row.markers.map(marker => <span className="checklist-marker" key={marker}>{marker}</span>)}</td>
      </tr>)}</tbody>
    </table>
    <p className="checklist-note">{checklist.rows.filter(row => ["cognate", "statistics", "finance"].includes(row.id) && row.alternatives.length > 1)
      .map(row => {
        const choices = row.alternatives;
        const label = { cognate: "Math choices", statistics: "Statistics choices", finance: "Finance choices" }[row.id];
        return `${label}: ${choices.length > 2 ? `${choices.slice(0, -1).join(", ")} or ${choices.at(-1)}` : choices.join(" or ")}.`;
      }).join(" ")}</p>
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
        <p className="change-confirm-warning">{studentFriendlyMoveCondition(selected, selected.course, menu.policyMessages)}</p>
        <div className="change-confirm-actions"><button type="button" disabled={busy} onClick={event => add(selected,event.currentTarget)}>Add course</button><button type="button" onClick={close}>Cancel</button></div>
      </> : <>
        {usable.length ? <section aria-label={usable[0].evidence === "published" ? "Published for this term" : "Future elective"}>
          <strong className="change-menu-heading">{usable[0].evidence === "published" ? "Published for this term" : "Schedule not yet published"}</strong>
          {usable.map(item => <button type="button" className="change-menu-option" key={item.course} disabled={busy} onClick={event => item.status === "CONDITIONAL" ? setSelected(item) : add(item,event.currentTarget)}>
            <span>{item.course === "ECO elective" ? "Add a 200+ elective" : item.course}</span><small>{item.title}</small>
          </button>)}
        </section> : <p>{blocked ? studentFriendlyUnavailableReason(blocked, menu.policyMessages) : "No eligible extra course is available in this term."} {blocked && studentFriendlyMoveNextStep(blocked)}</p>}
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
    .map(item => studentFriendlyUnavailableReason({ ...item, movingCourse: course.course }, menu.policyMessages))
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
          {item.status === "CONDITIONAL" && !isUnpublishedScheduleCondition(item) && <small>{studentFriendlyMoveCondition(item, course.course, menu.policyMessages)}</small>}
        </button>)}
        {group.items.some(isUnpublishedScheduleCondition) && <small className="change-confirm-warning">{studentFriendlyMoveCondition(group.items.find(isUnpublishedScheduleCondition), course.course, menu.policyMessages)}</small>}
      </section>) : <p>{all.length ? studentFriendlyUnavailableReason({ ...all[0], movingCourse: course.course }, menu.policyMessages) : "No other move is available right now."}</p>)}
      {selected && <>
        <strong className="change-confirm-title">{selected.edit.type === "move" ? `Move ${compactPlanCourse(course)}` : `Replace with ${selected.edit.replacementCourse === "ECO elective" ? "a 200+ elective" : selected.edit.replacementCourse}`}</strong>
        <span className="change-confirm-term">{studentTermLabel(selected.label)}</span>
        {selected.edit.replacementCourse === "ECO elective" && <p>Choose the exact course later.</p>}
        <p className="change-confirm-warning">{studentFriendlyMoveCondition(selected, course.course, menu.policyMessages)}</p>
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
  const { policyMessages } = useContext(CourseMenuContext);
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
                                    setDropMessage(studentFriendlyUnavailableReason(destination, policyMessages));
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
  const { policyMessages } = useContext(CourseMenuContext);
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
    <p>{studentFriendlyMoveCondition(drop.destination, drop.course.course, policyMessages)}</p>
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
  const { policyMessages } = useContext(CourseMenuContext);
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
                    {drag && <p className="drop-term-hint">{destinationFor(term)?.status === "CURRENT" ? "Current term" : destinationFor(term)?.status === "ALLOWED" ? "Drop to move here" : destinationFor(term)?.status === "CONDITIONAL" ? "Drop to review conditions" : studentFriendlyUnavailableReason(destinationFor(term), policyMessages)}</p>}
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
  if (course.course === "ECO elective" && course.minimumLevel >= 200) return "Economics elective (200 level or higher)";
  return course.section ? `${course.course}-${course.section}` : course.course;
}

function feasibilityLabel(status) {
  return ({
    VERIFIED_FEASIBLE: "Fits the current schedule",
    CONDITIONALLY_FEASIBLE: "Fits with checks",
    PRELIMINARY_ONLY: "Preliminary only",
    SEARCH_INCOMPLETE: "We could not find a complete plan yet",
    NOT_FEASIBLE: "No complete plan found"
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
  if (course?.fixedInProgress) return null;
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
              {showReasons && outcome.reasons?.some(item => item.studentVisible !== false)
                && ` — ${outcome.reasons.filter(item => item.studentVisible !== false)
                  .map(item => String(item.reason || item.message || item).replace(/[.;]\s*$/, "")).join(". ")}`}
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
  onReviewReservedRoom,
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
  const policyMessages = report?.policyMessages;
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
  const standing = studentStandingSummary({ ...studyAbroad,
    acceleratedPlanExists: acceleratedResult?.status !== "NOT_POSSIBLE" });
  const studyAbroadLabel = joinStudyAbroadTerms(studyAbroadIds.map(id => planningSlotsLabel(id, comparisonContext)));
  const graduationTarget = studentTermLabel(planningContext?.expectedGraduationTerm || "To be confirmed");
  const earlyGraduationTarget = !isPlanView && plans.find(plan => plan.id === "one-year-early")?.planningContext?.expectedGraduationTerm;
  const graduationTargetDisplay = earlyGraduationTarget && studentTermLabel(earlyGraduationTarget) !== graduationTarget
    ? `${graduationTarget} (one year early: ${studentTermLabel(earlyGraduationTarget)})`
    : graduationTarget;
  const completedCodes = courses.filter(isTaken).map(course => (
    `${course.code}${course.source === "ap_credit" ? " (AP)" : course.status === "transfer" ? " (transfer)" : ""}`
  ));
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
  const paperworkReminder = statusPlans.some(plan => planningRequirementsNote(plan.planningContext, plan)?.details.some(detail => /petition/i.test(detail)));
  const planBadge = plan => {
    if (plan.planningMode !== "graduation_priority") return null;
    const mayCourse = plan.terms
      ?.find(term => term.scheduleTerm === "May")
      ?.courses?.[0]?.course;
    return mayCourse ? `${mayCourse} in May` : "Graduation priority";
  };
  const planDescription = plan => ({
    balanced: "Spreads the required classes you still need across the years before you graduate.",
    "explore-first": "Plans fewer major classes this year than Balanced. Classes that need another class first are scheduled later.",
    "one-year-early": "Plans to finish your remaining major requirements a year earlier."
  })[plan.id] || plan.description;

  return (
    <CourseMenuContext.Provider value={{ openId: openCourseMenuId, setOpenId: setOpenCourseMenuId, confirmingId: confirmingCourseMenuId, setConfirmingId: setConfirmingCourseMenuId, policyMessages }}>
    <main className={`comparison-page${isExiting ? " is-exiting" : ""}`}>
      <style jsx global>{comparisonStyles}</style>

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
          <p><strong>Status</strong><span className="result-status-value">{displayedOverallStatus}</span>
            {isPlanView && selectedPlan && <span className="plan-feasibility-meaning">{feasibilityMeaning(selectedPlan.feasibilityStatus)}</span>}
            {plans.length > 0 && <span className="result-status-reason">{displayedOverallStatus === "Needs confirmation" && plans.length === 1
              ? "Check this plan's approval and standing notes before registering."
              : STUDENT_READINESS_EXPLANATIONS[displayedOverallStatus]}{paperworkReminder && " See the notes below for paperwork to file."}</span>}
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
                  ? "Your plan"
                  : "Your planning result"}</h1>
            {plans.length > 0 && <p className="plan-edit-instructions"><strong>Click a course to see where it can move. You can also drag it by the ⠿ handle.</strong><span>While you drag, green terms are open, amber terms need approval or a check first, and gray terms show why the course can&apos;t go there.</span></p>}
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
                    <p className="plan-feasibility-value">Status: {planReadinessLabel(plan)}</p>
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
                          <th>Academic year</th>
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
                                    {course.preliminaryScheduleEvidence && <span>{preliminaryScheduleExplanation(course.preliminaryScheduleEvidence.issuedOn, policyMessages)}</span>}
                                    {(course.planningMarkers || []).filter(marker => marker !== "Approval required" || course.approvalRequired?.length).map(marker => marker === "Approval required"
                                      ? <div className="plan-course-approval" key={marker}>
                                        <strong>Approval needed</strong>
                                      </div>
                                      : <span className="plan-course-approval" key={marker}>{studentFriendlyCourseMarker(marker)}</span>)}
                                    {course.course === "ECO 461" && <span className="course-constraint-note">Offered only in Winter. This is the last Winter before you graduate.</span>}
                                  </div>
                                </div>;
                              }) : <span className="comparison-empty-term">{studyAbroadIds.includes(row.sourceTerm.slotId) ? "Study abroad" : "No Economics course this term"}</span>}
                              {comparisonDrag?.planId === plan.id && <small className="comparison-drop-hint">{(() => {
                                const option = comparisonDrag.course.moveDestinationOptions?.find(item => item.id === (row.sourceTerm.slotId || row.sourceTerm.term));
                                return option?.status === "CURRENT" ? "Current term" : option?.status === "ALLOWED" ? "Drop here" : option?.status === "CONDITIONAL" ? "Drop to review conditions" : studentFriendlyUnavailableReason(option, policyMessages);
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
            {canonicalPlanResult?.evidence?.message && canonicalPlanResult.evidence.message !== noPlan.message
              && <p>{canonicalPlanResult.evidence.message}</p>}
            {(canonicalPlanResult?.evidence?.blockingReasons || []).filter(reason => reason.message && reason.message !== noPlan.message)
              .map(reason => <p key={reason.code}>{reason.message}</p>)}
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
              onClick={noPlan.actionTarget === "timeline" ? onReviewTimeline : noPlan.actionTarget === "other-courses-reserved" ? onReviewReservedRoom : onEditCourses}
            >
              {noPlan.action}
            </button>
          </section>
        )}

        {!isPlanView && acceleratedResult && !mergePossibleEarlyResult && (
          <section className="accelerated-result" aria-labelledby="accelerated-result-heading">
            <h2 id="accelerated-result-heading">
              {acceleratedResult.label}: {" "}
              <span className="accelerated-result-status">{({
                POSSIBLE: "Possible",
                NOT_POSSIBLE: "Not possible",
                MORE_INFORMATION_NEEDED: "More information needed"
              })[acceleratedResult.status] || "More information needed"}</span>
            </h2>
            {acceleratedResult.status === "NOT_POSSIBLE" && <p>You cannot finish by {studentTermLabel(acceleratedResult.acceleratedTarget)}. The plan below is for {studentTermLabel(acceleratedResult.standardTarget)}.</p>}
            <dl className="accelerated-target-list">
              <div><dt>Standard target</dt><dd>{studentTermLabel(acceleratedResult.standardTarget)}</dd></div>
              <div><dt>One-year-early target</dt><dd>{studentTermLabel(acceleratedResult.acceleratedTarget || "To be confirmed")}</dd></div>
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
  const visibleGaps = planningGaps.filter(item => item.studentVisible !== false);
  const hasDiagnostics = blockingReasons.length || otherOutcomes.length || convergences.length || visibleGaps.length;
  if (!hasDiagnostics) return null;
  return (
    <details className="result-diagnostics">
      <summary>{planCount ? "More planning details" : "Why am I seeing this result?"}</summary>
      {blockingReasons.length ? <ul>{blockingReasons.map(reason => <li key={reason.code}>{reason.message}</li>)}</ul> : <>
        <CandidateOutcomes outcomes={otherOutcomes} convergences={convergences} showReasons={planCount > 0 || !visibleGaps.length} />
        <PlanningGaps items={visibleGaps} />
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
      setPlanEditStatus("");
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
        {course && ["completed", "transfer", "in_progress"].includes(course.status) && historicalPrerequisiteGaps(course.code, formData.courses, prerequisitePolicy.records).map(gap => (
          <p className="prerequisite-conflict" role="status" key={gap.label}>{historicalPrerequisiteMessage(gap)}</p>
        ))}
        {course && !(course.status === "in_progress" && historicalPrerequisiteGaps(course.code, formData.courses, prerequisitePolicy.records).length)
          && renderPrerequisiteFollowUp(course)}
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

  function returnToReservedRoomSetting() {
    returnToInputStep(1);
    window.setTimeout(() => {
      const target = document.getElementById("other-courses-reserved");
      let details = target?.closest("details");
      while (details) {
        details.open = true;
        details = details.parentElement?.closest("details") || null;
      }
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 300);
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
          onReviewReservedRoom={returnToReservedRoomSetting}
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
      <style jsx global>{plannerStyles}</style>

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
                    <p>Standard target: {studentTermLabel(planningContext.expectedGraduationTerm)}. One-year-early target: {studentTermLabel(buildEarlyGraduationContext(planningContext)?.expectedGraduationTerm)}.</p>
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
                      <h3 id="other-courses-reserved">Leave room for other courses</h3>
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
