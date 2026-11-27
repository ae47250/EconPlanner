"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { hanoverOnlyStatusAllowed } from "../lib/planning/hanover-only-courses.js";
import { buildEarlyGraduationContext, buildPlanningSlots, PLANNING_PACES, resolvePlanningContext, transferPlanningOptions } from "../lib/planning/horizon.js";
import { buildPrerequisiteFollowUp } from "../lib/planning/prerequisiteFormValidation.js";
import { createGeneratedPlannerSession, migratePlannerInputState, PLANNER_INPUT_STATE_VERSION, PLANNER_VIEWS, plannerViewFromSearch, replaceEconomicsPlan } from "../lib/planning/uiState.js";
import { validateSavedPlannerSession } from "../lib/planning/session-restoration.js";
import { compactEconomicsPlanForValidation } from "../lib/planning/validation-payload.js";
import { requirementFormGroups } from "../lib/planning/requirementFormChoices.js";
import economicsRequirements from "../data/normalized/economics/requirements.json";
import { followingMayId, joinStudyAbroadTerms, studyAbroadTermIds, termReservationLimit, updateStudyAbroadReservation } from "../lib/planning/study-abroad.js";
import prerequisitePolicy from "../policy/rules/prerequisites.json";
import permissionPolicy from "../policy/rules/permissions-exceptions.json";
import policyMessages from "../policy/messages/en-US.json";
import { historicalPrerequisiteCourseMessage } from "../lib/planning/historical-prerequisites.js";
import { planningRequirementsNote } from "../lib/catalog/planning-requirements-note.js";
import { studentTermLabel } from "../lib/planning/student-language.js";
import { plannerStyles } from "./styles/plannerStyles";
import { COURSE_CATALOG, COURSE_PREREQUISITES, isTaken, courseTitle, economicsResult, planCourseIdentity, planningSlotsLabel } from "./plannerShared.js";
import { PlanComparisonScreen } from "./components/PlanComparisonScreen.js";
import { ClearAllDialog, PlannerSummary } from "./components/plannerSummary.js";

const HISTORY_RULES = [...prerequisitePolicy.records, ...permissionPolicy.records];

const PLANNER_STORAGE_KEY = "econ-planner-ui-state";

const GENERATED_PLANNER_SESSION_KEY = "econ-planner-generated-session";

const PLANNER_STORAGE_VERSION = PLANNER_INPUT_STATE_VERSION;

const COURSE_ALIASES = new Map(COURSE_CATALOG.flatMap(course => (
  (course.aliases || []).map(alias => [alias, course.code])
)));

const NON_SELECTABLE_COURSE_CODES = new Set(COURSE_CATALOG
  .filter(course => course.studentSelectable === false)
  .map(course => course.code));

const AP_CREDIT_ALLOWED_COURSE_CODES = new Set(COURSE_CATALOG
  .filter(course => course.apEligible)
  .map(course => course.code));

const SELECTABLE_COURSE_CATALOG = COURSE_CATALOG.filter(course => course.studentSelectable !== false);

// Owner decision (Nov 25, 2026, policy/provenance/owner-eco461-completed-2026-11-25.md):
// a Hanover-only course (ECO 461) can be marked Completed, at Hanover only, by seniors only.
// Update (Nov 25, 2026): a senior may also mark it "taking now", only during a Winter term.
// The rule itself lives in lib/planning/hanover-only-courses.js (one copy, shared with the server).
function canMarkHanoverOnly(code, form, status) {
  return NON_SELECTABLE_COURSE_CODES.has(code) && hanoverOnlyStatusAllowed(form, status);
}

function hanoverOnlyRecordedCourses(courses, form) {
  return courses.filter(course => ["completed", "in_progress"].includes(course.status) && canMarkHanoverOnly(course.code, form, course.status));
}

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

function migrateSavedCourses(savedCourses = [], form = {}) {
  const byCode = new Map();
  for (const savedCourse of savedCourses) {
    const code = canonicalSavedCode(savedCourse.code);
    if (!code || !COURSE_CATALOG.some(course => course.code === code)) continue;
    if (NON_SELECTABLE_COURSE_CODES.has(code) && !hanoverOnlyRecordedCourses([{ ...savedCourse, code }], form).length) continue;
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
  }).concat(COURSE_CATALOG.filter(course => NON_SELECTABLE_COURSE_CODES.has(course.code) && byCode.has(course.code))
    .map(course => ({ ...blankCourse(course), status: byCode.get(course.code).status, source: "manual_code" })));
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
    courses: selectedCourses(formData.courses, formData)
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

// Remove a Hanover-only course mark the current standing or date no longer allows, so the screen
// never shows a status that the planner would ignore.
function pruneHanoverOnlyCourses(form) {
  const allowed = new Set(hanoverOnlyRecordedCourses(form.courses || [], form).map(course => course.code));
  const courses = (form.courses || []).filter(course => !NON_SELECTABLE_COURSE_CODES.has(course.code) || allowed.has(course.code));
  return courses.length === (form.courses || []).length ? form : { ...form, courses };
}

function selectedCourses(courses, form) {
  return [
    ...courses.filter(course => !NON_SELECTABLE_COURSE_CODES.has(course.code) && ["completed", "transfer", "in_progress"].includes(course.status)),
    ...hanoverOnlyRecordedCourses(courses, form).map(course => ({ ...course, source: "manual_code" }))
  ];
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

function domId(value) {
  return String(value || "item").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function localToday() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatAcademicYearCompact(startYear) {
  return `${startYear}\u2013${String(startYear + 1).slice(-2)}`;
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
    const next = pruneHanoverOnlyCourses({
      ...current,
      planCreationDate,
      planCreationDateEdited: true
    });
    if (!current.isTransferStudent) return next;

    const nextContext = resolvePlanningContext(next);
    const nextOptions = transferPlanningOptions(nextContext);
    const selectedGraduationYear = Number(current.transferExpectedGraduationYear);
    const graduationYearStillValid = selectedGraduationYear >= nextContext.startYear + 1
      && selectedGraduationYear <= nextContext.startYear + 5;
    return pruneHanoverOnlyCourses({
      ...next,
      transferExpectedGraduationYear: graduationYearStillValid
        ? current.transferExpectedGraduationYear
        : "",
      transferEntryAcademicYear: nextOptions.entryAcademicYears.includes(current.transferEntryAcademicYear)
        ? current.transferEntryAcademicYear
        : ""
    });
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

  function cancelInFlightPlanEdit() {
    if (planEditInFlightRef.current) {
      planEditRequestRef.current += 1;
      planEditAbortRef.current?.abort();
      planEditAbortRef.current = null;
      planEditInFlightRef.current = false;
      setEditingPlanCourseKey("");
      setPlanEditFeedback(null);
    }
  }

  function navigatePlanner(nextView, nextPlanId = selectedPlanId, { replace = false } = {}) {
    cancelInFlightPlanEdit();
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
            courses: migrateSavedCourses(opened.student?.courses, { ...initialForm, ...opened.student }),
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
              courses: migrateSavedCourses(migrated.formData.courses, { ...restoredForm, ...migrated.formData }),
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

      // The restored date can differ from the saved one, so re-check Hanover-only course marks.
      restoredForm = pruneHanoverOnlyCourses(restoredForm);
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
        student: { ...restoredForm, courses: selectedCourses(restoredForm.courses, restoredForm) },
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
        initialView = restoredView;
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
      cancelInFlightPlanEdit();
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

  function toggleHanoverOnlyStatus(code, status) {
    setFormData(current => {
      const selected = current.courses.some(course => course.code === code && course.status === status);
      const catalogCourse = COURSE_CATALOG.find(course => course.code === code);
      const others = current.courses.filter(course => course.code !== code);
      return {
        ...current,
        courses: selected ? others : [...others, { ...blankCourse(catalogCourse), status, source: "manual_code" }]
      };
    });
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
      return pruneHanoverOnlyCourses({
        ...candidate,
        planningPace: candidateContext.oneYearEarlyEligible
          ? current.planningPace
          : PLANNING_PACES.STANDARD
      });
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

    cancelRestoration();
    invalidatePlanEdits();
    reportContextIdRef.current = crypto.randomUUID();
    generationInFlightRef.current = true;
    setIsGenerating(true);
    setStatus("Building your economics plan...");
    setPlanEditStatus("");

    const student = {
      ...formData,
      courses: selectedCourses(formData.courses, formData)
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
        student: { ...formData, courses: selectedCourses(formData.courses, formData) },
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
    if (!followUp.required) return null;

    return (
      <div className="inline-prerequisite">
        <p role="status"><strong>Prerequisites for {course.code}</strong></p>
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
          {isHanoverOnly ? (canMarkHanoverOnly(code, formData, "completed") ? (
            <div className="course-toggles" role="group" aria-label={`Status for ${code}`}>
              {[["completed", "Completed"], ...(canMarkHanoverOnly(code, formData, "in_progress") ? [["in_progress", "Taking now"]] : [])].map(([value, label]) => {
                const selected = course?.status === value;
                return (
                  <button type="button" key={value} className={`course-toggle is-${value}${selected ? " is-selected" : ""}`}
                    aria-pressed={selected} onClick={() => toggleHanoverOnlyStatus(code, value)}>
                    <span className="selection-check" aria-hidden="true">{selected ? "✓" : ""}</span>
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          ) : <span className="course-status-note">Must be taken at Hanover College</span>) : renderStatusControls(code)}
        </div>
        {completed && !isHanoverOnly && (
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
        {course && ["completed", "transfer", "in_progress"].includes(course.status) && (() => {
          const message = historicalPrerequisiteCourseMessage(course.code, formData.courses, HISTORY_RULES, policyMessages.messages);
          return message ? <p className="prerequisite-conflict" role="status">{message}</p> : null;
        })()}
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
              courses: selectedCourses(formData.courses, formData)
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
        const resultMessage = `${edit.type === "move" ? `Moved to ${targetTerm?.term ? studentTermLabel(targetTerm.term) : "selected term"}` : edit.type === "add-extra" ? "Extra course added" : edit.type === "remove-extra" ? "Extra course removed" : "Course updated"}.${changedCourse?.publicationStatus === "PLANNING_PROJECTION" ? "" : " Plan checks pass."}`;
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
          selectedPlanId={selectedPlanId}
          isExiting={isComparisonExiting}
          isGenerating={isGenerating}
          editingPlanCourseKey={editingPlanCourseKey}
          planEditStatus={planEditStatus}
          planEditFeedback={planEditFeedback}
          undoPlanId={planEditUndo?.planId}
          onEditCourses={returnToCourseSelection}
          onReviewTimeline={() => returnToInputStep(1)}
          onReviewReservedRoom={returnToReservedRoomSetting}
          onClearAll={() => setClearDialogOpen(true)}
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
