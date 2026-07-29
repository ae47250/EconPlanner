"use client";

import { useEffect, useRef, useState } from "react";
import { resolvePlanningContext } from "../lib/planning/horizon.js";

const PLANNER_STORAGE_KEY = "econ-planner-ui-state";
const NON_SELECTABLE_COURSE_CODES = new Set(["ECO 461"]);

const COURSE_CATALOG = [
  { code: "ECO 113", title: "Principles of Microeconomics" },
  { code: "ECO 114", title: "Principles of Macroeconomics" },
  { code: "ECO 160", title: "Special Topics" },
  { code: "ECO 161", title: "Foundations of Economics" },
  { code: "MAT 113", title: "Mathematics cognate" },
  { code: "MAT 121", title: "Calculus I" },
  { code: "ECO 213", title: "Intermediate Microeconomics" },
  { code: "ECO 214", title: "Intermediate Macroeconomics" },
  { code: "ECO 221", title: "Environmental Economics" },
  { code: "ECO 222", title: "Economics of the European Union" },
  { code: "ECO 223", title: "Economics: Poverty & Discrimination" },
  { code: "ECO 224", title: "Introduction to Sustainability" },
  { code: "ECO 234", title: "Rational Choices" },
  { code: "ECO 257", title: "Quantitative Methods for Business/Economics" },
  { code: "ECO 260", title: "Special Topics" },
  { code: "MAT 217", title: "Applied Statistics" },
  { code: "PSY 217", title: "Statistical Analysis" },
  { code: "ECO 307", title: "Directed Study", units: 0.5 },
  { code: "ECO 315", title: "U.S. Economic History" },
  { code: "ECO 316", title: "History of Economic Thought" },
  { code: "ECO 321", title: "Money & Financial Markets" },
  { code: "BUSN 323", title: "Business finance option" },
  { code: "ECO 331", title: "Labor Economics" },
  { code: "ECO 333", title: "International Trade & Finance" },
  { code: "ECO 335", title: "Managerial Economics" },
  { code: "ECO 337", title: "Economic Development" },
  { code: "ECO 357", title: "Internship" },
  { code: "ECO 360", title: "Special Topics" },
  { code: "ECO 370", title: "Directed Study" },
  { code: "ECO 461", title: "Senior Seminar: Econometrics", studentSelectable: false },
  { code: "ECO 471", title: "Senior Thesis" }
];

const SELECTABLE_COURSE_CATALOG = COURSE_CATALOG.filter(course => course.studentSelectable !== false);

const GROUPED_COURSE_CODES = new Set([
  "MAT 113", "MAT 121", "ECO 257", "MAT 217", "PSY 217"
]);

const COURSE_DISPLAY_GROUPS = [
  {
    id: "ECO 113",
    code: "ECO 113",
    title: "Principles of Microeconomics",
    courseCodes: ["ECO 113"]
  },
  {
    id: "ECO 114",
    code: "ECO 114",
    title: "Principles of Macroeconomics",
    courseCodes: ["ECO 114"]
  },
  {
    id: "ECO 160",
    code: "ECO 160",
    title: "Special Topics",
    courseCodes: ["ECO 160"]
  },
  {
    id: "ECO 161",
    code: "ECO 161",
    title: "Foundations of Economics",
    courseCodes: ["ECO 161"]
  },
  {
    id: "ECO 213",
    code: "ECO 213",
    title: "Intermediate Microeconomics",
    courseCodes: ["ECO 213"]
  },
  {
    id: "ECO 214",
    code: "ECO 214",
    title: "Intermediate Macroeconomics",
    courseCodes: ["ECO 214"]
  },
  {
    id: "math-requirement",
    code: "MAT 113 / MAT 121",
    title: "Mathematics cognate",
    courseCodes: ["MAT 113", "MAT 121"],
    options: [
      { code: "MAT 113", title: "Mathematics cognate" },
      { code: "MAT 121", title: "Calculus I" }
    ]
  },
  {
    id: "statistics-requirement",
    code: "ECO 257 / MAT 217 / PSY 217",
    title: "Statistics requirement",
    courseCodes: ["ECO 257", "MAT 217", "PSY 217"],
    options: [
      { code: "ECO 257", title: "Quantitative Methods for Business/Economics" },
      { code: "MAT 217", title: "Applied Statistics" },
      { code: "PSY 217", title: "Statistical Analysis" }
    ]
  },
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
const DECLARATION_GROUP_IDS = new Set([...DECLARATION_COURSE_IDS, ...DECLARATION_REQUIREMENT_IDS]);
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

const initialForm = {
  displayName: "",
  academicStanding: "freshman",
  planCreationDate: "",
  summerStandingConfirmed: "",
  expectedGraduationTerm: "",
  courses: SELECTABLE_COURSE_CATALOG.map(blankCourse),
  advisorApprovals: ""
};

function courseLevel(code) {
  return Number(String(code).match(/\d+$/)?.[0] || 0);
}

function isTaken(course) {
  return course.status === "completed" || course.status === "transfer";
}

function selectedCourses(courses) {
  return courses.filter(course => !NON_SELECTABLE_COURSE_CODES.has(course.code) && ["completed", "transfer", "in_progress"].includes(course.status));
}

function economicsResult(report) {
  return report?.programs?.find(result => result.economicsPlan || result.program?.name === "Economics") || null;
}

function planCourseCount(plan) {
  return plan?.terms?.reduce((count, term) => count + term.courses.length, 0) || 0;
}

function localToday() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatPlanCreationDate(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return "Not set";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(new Date(year, month - 1, day));
}

function formatAcademicYear(value) {
  return value ? String(value).replace("-", "/") : "Academic year";
}

function PlanTimeline({ plans = [] }) {
  const [activePlanId, setActivePlanId] = useState(plans[0]?.id || "plan-1");

  useEffect(() => {
    if (plans.length && !plans.some(plan => plan.id === activePlanId)) {
      setActivePlanId(plans[0].id);
    }
  }, [activePlanId, plans]);

  if (!plans.length) return null;

  const activePlan = plans.find(plan => plan.id === activePlanId) || plans[0];
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
    <section className="plan-section" aria-live="polite">
      <div className="plan-tabs" role="tablist" aria-label="Generated plans">
        {plans.map(plan => (
          <button
            type="button"
            className={`plan-tab${plan.id === activePlan.id ? " is-active" : ""}`}
            id={`${plan.id}-tab`}
            role="tab"
            aria-selected={plan.id === activePlan.id}
            aria-controls={plan.id}
            key={plan.id}
            onClick={() => setActivePlanId(plan.id)}
          >
            {plan.label}
          </button>
        ))}
      </div>
      <div id={activePlan.id} role="tabpanel" aria-labelledby={`${activePlan.id}-tab`}>
        <div className="section-heading">
          <span className="step-number">3.</span>
          <div>
            <h2>Your Plan</h2>
            <p>{activePlan.description}</p>
            <p className="plan-source-note">Verified course schedule: {formatAcademicYear(activePlan.academicYear)}. Later-year offerings remain unverified until published.</p>
          </div>
        </div>
        <div className="academic-year-groups">
          {academicYearGroups.map(group => (
            <section className="academic-year-group" key={group.label}>
              <h3 className="academic-year-label">{group.label}</h3>
              <div className="plan-grid">
                {group.terms.map(term => (
                  <article className="term-card" key={term.term}>
                    <h4>{term.displayTerm || term.term}</h4>
                    {term.courses.length > 0 ? (
                      <ul>
                        {term.courses.map((course, courseIndex) => (
                          <li key={`${term.term}-${course.course}-${course.requirementId || "course"}-${courseIndex}`}>
                            <strong>{course.course}</strong>
                            <span>{course.title}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="empty-term">No courses placed</p>
                    )}
                    {term.isSummer && (
                      <p className="summer-term-note">Summer, online, last-resort option.</p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
        {activePlan.unscheduled?.length > 0 && (
          <div className="plan-notes">
            <strong>Future course offerings to verify</strong>
            <ul>
              {activePlan.unscheduled.map(item => (
                <li key={`${activePlan.id}-${item.requirementId}`}>{item.course}: {item.reason}</li>
              ))}
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
      </div>
    </section>
  );
}

function PlannerSummary({ report, courses }) {
  const result = economicsResult(report);
  const plan = result?.economicsPlans?.[0] || result?.economicsPlan;
  const planningContext = result?.planningContext;
  const chosen = selectedCourses(courses);
  const completedCount = chosen.filter(course => isTaken(course)).length;
  const inProgressCount = chosen.filter(course => course.status === "in_progress").length;
  const remainingUnits = result?.projectedAfterInProgress?.optimistic?.remainingUnits
    ?? result?.optimistic?.remainingUnits;
  const catalog = report?.catalog;
  const comparisonFindings = catalog?.comparisonFindings || [];
  const comparisonStatus = catalog?.comparisonStatus;
  const comparisonNotice = comparisonStatus === "more_flexible"
    ? {
        className: "catalog-notice catalog-notice-positive",
        title: "Newer catalog available for review",
        message: `Your entry catalog is ${formatAcademicYear(catalog.selectedCatalogYear)}. The ${formatAcademicYear(catalog.comparisonCatalogYear)} Economics catalog appears more flexible. This plan still uses your entry catalog; review the newer requirements with the department or advisor before changing the governing catalog.`
      }
    : comparisonStatus === "changed_review"
      ? {
          className: "catalog-notice catalog-notice-warning",
          title: "Catalog requirements changed",
          message: `The ${formatAcademicYear(catalog.comparisonCatalogYear)} Economics catalog contains changes compared with your entry catalog, including changes that may not all be more flexible. This plan uses ${formatAcademicYear(catalog.selectedCatalogYear)}; advisor review is recommended.`
        }
      : comparisonStatus === "unavailable"
        ? {
            className: "catalog-notice catalog-notice-warning",
            title: "Newer catalog could not be checked",
            message: `This plan uses your entry catalog, ${formatAcademicYear(catalog.selectedCatalogYear)}. The newer ${formatAcademicYear(catalog.comparisonCatalogYear)} catalog is not captured locally yet.`
          }
        : null;

  return (
    <aside className="summary-card">
      <div className="section-heading">
        <div>
          <h2>Planner Summary</h2>
          <p>{report ? "Your selected courses and generated plan at a glance." : "Your summary will appear after you generate your plan."}</p>
        </div>
      </div>
      {report ? (
        <>
          {comparisonNotice && (
            <div className={comparisonNotice.className} role="status">
              <strong>{comparisonNotice.title}</strong>
              <p>{comparisonNotice.message}</p>
              {comparisonFindings.length > 0 && (
                <ul>
                  {comparisonFindings.map(finding => <li key={`${finding.code}-${finding.message}`}>{finding.message}</li>)}
                </ul>
              )}
            </div>
          )}
          <div className="summary-grid">
            <div><span>Taken or AP credit</span><strong>{completedCount}</strong></div>
            <div><span>In Progress</span><strong>{inProgressCount}</strong></div>
            <div><span>Remaining</span><strong>{remainingUnits ?? "-"}</strong></div>
            <div><span>Courses in plan</span><strong>{planCourseCount(plan)}</strong></div>
          </div>
          {planningContext?.expectedGraduationTerm && (
            <p className="summary-footnote">{planningContext.effectiveStandingLabel || planningContext.standingLabel} plan, {planningContext.remainingYears} years remaining; expected graduation {planningContext.expectedGraduationTerm}.</p>
          )}
          <p className="summary-footnote">Applied catalog: {formatAcademicYear(catalog?.selectedCatalogYear)}. The plan uses the selected course status and verified economics scheduling rules.</p>
        </>
      ) : (
        <div className="summary-empty">Select your courses, then choose <strong>Generate My Plan</strong>.</div>
      )}
    </aside>
  );
}

export default function Page() {
  const [formData, setFormData] = useState(initialForm);
  const [requirementModes, setRequirementModes] = useState({});
  const [requirementScrollTarget, setRequirementScrollTarget] = useState("");
  const [requirementPopoverPosition, setRequirementPopoverPosition] = useState(null);
  const requirementCardRefs = useRef({});
  const courseAccordionRefs = useRef({});
  const [courseSearch, setCourseSearch] = useState("");
  const [isEditingPlanDate, setIsEditingPlanDate] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState(null);
  const planningContext = resolvePlanningContext(formData);
  const summerStandingSelection = planningContext.isSummer && ["yes", "no"].includes(formData.summerStandingConfirmed)
    ? formData.summerStandingConfirmed === "yes"
      ? `${planningContext.standingLabel} in Fall ${planningContext.startYear}`
      : `${planningContext.standingLabel} during ${planningContext.startYear - 1}\u2013${String(planningContext.startYear).slice(-2)} academic year`
    : "";

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(PLANNER_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.formData && Array.isArray(parsed.formData.courses)) {
          const { entryCatalogYear, majorDeclarationCatalogYear, ...savedFormData } = parsed.formData;
          setFormData(current => ({
            ...current,
            ...savedFormData,
            courses: savedFormData.courses.filter(course => !NON_SELECTABLE_COURSE_CODES.has(course.code)),
            planCreationDate: savedFormData.planCreationDate || localToday()
          }));
        }
        if (parsed.requirementModes && typeof parsed.requirementModes === "object") {
          setRequirementModes(parsed.requirementModes);
        }
        if (typeof parsed.courseSearch === "string") {
          setCourseSearch(parsed.courseSearch);
        }
      }
    } catch {
      window.localStorage.removeItem(PLANNER_STORAGE_KEY);
    }

    setFormData(current => current.planCreationDate
      ? current
      : { ...current, planCreationDate: localToday() });

    window.history.scrollRestoration = "manual";
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;

    try {
      window.localStorage.setItem(PLANNER_STORAGE_KEY, JSON.stringify({
        formData,
        requirementModes,
        courseSearch
      }));
    } catch {
      // Local storage may be unavailable in restricted browser sessions.
    }
  }, [courseSearch, formData, isHydrated, requirementModes]);

  useEffect(() => {
    if (!requirementScrollTarget) return undefined;

    const frame = window.requestAnimationFrame(() => {
      requirementCardRefs.current[requirementScrollTarget]?.scrollIntoView({
        behavior: "smooth",
        block: "nearest"
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [requirementScrollTarget]);

  function closeRequirementPopover(groupId) {
    setRequirementModes(current => current[groupId]
      ? { ...current, [groupId]: "" }
      : current);
    setRequirementScrollTarget(current => current === groupId ? "" : current);
    setRequirementPopoverPosition(current => current?.groupId === groupId ? null : current);
  }

  useEffect(() => {
    if (!Object.values(requirementModes).some(Boolean)) return undefined;

    function handleOutsidePointer(event) {
      const openCards = document.querySelectorAll(".requirement-choice-card");
      if ([...openCards].some(card => card.contains(event.target))) return;
      const clickedRow = event.target.closest?.(".course-row");
      if (clickedRow && [...document.querySelectorAll(".course-row.has-requirement")].includes(clickedRow)) return;

      setRequirementModes(current => Object.fromEntries(
        Object.keys(current).map(id => [id, ""])
      ));
      setRequirementScrollTarget("");
      setRequirementPopoverPosition(null);
    }

    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [requirementModes]);

  function toggleCourseGroup(group, nextStatus, event) {
    if (group.courseCodes.some(code => NON_SELECTABLE_COURSE_CODES.has(code))) return;

    if (group.options) {
      const currentMode = requirementModes[group.id] || "";
      const nextMode = currentMode === nextStatus ? "" : nextStatus;
      setRequirementModes(current => ({ ...current, [group.id]: nextMode }));
      setRequirementScrollTarget(nextMode ? group.id : "");
      if (nextMode && event?.currentTarget) {
        const row = event.currentTarget.closest(".course-row");
        const rowRect = row?.getBoundingClientRect();
        const buttonRect = event.currentTarget.getBoundingClientRect();
        if (rowRect) {
          setRequirementPopoverPosition({
            groupId: group.id,
            left: buttonRect.left - rowRect.left,
            top: buttonRect.bottom - rowRect.top + 6
          });
        }
      } else {
        setRequirementPopoverPosition(null);
      }
      setFormData(current => ({
        ...current,
        courses: current.courses.map(course => group.courseCodes.includes(course.code)
          ? { ...course, status: "not_started" }
          : course)
      }));
      return;
    }

    setFormData(current => {
      const course = current.courses.find(item => item.code === group.courseCodes[0]);
      const currentlySelected = nextStatus === "completed" ? isTaken(course || {}) : course?.status === nextStatus;

      return {
        ...current,
        courses: current.courses.map(course => {
          if (!group.courseCodes.includes(course.code)) return course;
          return { ...course, status: currentlySelected ? "not_started" : nextStatus };
        })
      };
    });
  }

  function toggleGroupOption(group, code) {
    const mode = requirementModes[group.id];
    if (!mode) return;
    setFormData(current => {
      return {
        ...current,
        courses: current.courses.map(course => {
          if (course.code !== code) return course;
          const selected = mode === "completed" ? isTaken(course) : course.status === mode;
          return { ...course, status: selected ? "not_started" : mode };
        })
      };
    });
  }

  async function mapMajors(event) {
    event.preventDefault();

    if (!formData.planCreationDate) {
      setStatus("Enter the plan creation date before generating a plan.");
      return;
    }

    if (planningContext.requiresSummerClarification) {
      setStatus("Answer the summer class-standing question before generating a plan.");
      return;
    }

    setStatus("Building your economics plan...");
    setReport(null);

    const student = {
      ...formData,
      courses: selectedCourses(formData.courses)
    };

    try {
      const response = await fetch("/api/majors/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ student })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The planner could not complete.");
      setReport(data);
      setStatus("");
    } catch (error) {
      setStatus(error.message);
    }
  }

  const query = courseSearch.trim().toLowerCase();
  const visibleGroups = COURSE_DISPLAY_GROUPS.filter(group =>
    !query || `${group.code} ${group.title} ${(group.options || []).map(option => `${option.code} ${option.title}`).join(" ")}`.toLowerCase().includes(query)
  );
  const declarationCourseGroups = visibleGroups.filter(group => DECLARATION_COURSE_IDS.includes(group.id));
  const declarationRequirementGroups = visibleGroups.filter(group => DECLARATION_REQUIREMENT_IDS.includes(group.id));
  const declarationGroups = [...declarationCourseGroups, ...declarationRequirementGroups];
  const remainingGroups = visibleGroups.filter(group => !DECLARATION_GROUP_IDS.has(group.id));
  const sortCourseGroups = groups => [...groups].sort((a, b) => courseLevel(a.code) - courseLevel(b.code) || a.code.localeCompare(b.code));
  const oneHundredGroups = sortCourseGroups(remainingGroups.filter(group => courseLevel(group.code) >= 100 && courseLevel(group.code) < 200));
  const twoHundredGroups = sortCourseGroups(remainingGroups.filter(group => courseLevel(group.code) >= 200 && courseLevel(group.code) < 300));
  const advancedGroups = sortCourseGroups(remainingGroups.filter(group => courseLevel(group.code) >= 300));

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

  function renderCourseGroup(group) {
    const groupCourses = formData.courses.filter(course => group.courseCodes.includes(course.code));
    const requirementMode = requirementModes[group.id] || "";
    const taken = group.options ? requirementMode === "completed" : groupCourses.some(isTaken);
    const inProgress = group.options ? requirementMode === "in_progress" : groupCourses.some(course => course.status === "in_progress");
    return (
      <div
        className={`course-row${group.options && requirementMode ? " has-requirement" : ""}`}
        key={group.id}
        onMouseLeave={() => {
          if (group.options && requirementMode) closeRequirementPopover(group.id);
        }}
      >
        <div className="course-name">
          <strong>{group.code}</strong>
          <span>{group.title}</span>
        </div>
        <div className="course-toggles" role="group" aria-label={`Status for ${group.code}`}>
          <button
            type="button"
            className={`course-toggle taken-toggle${taken ? " is-selected" : ""}`}
            aria-pressed={taken}
            onClick={event => toggleCourseGroup(group, "completed", event)}
          >
            Taken or AP credit
          </button>
          <button
            type="button"
            className={`course-toggle progress-toggle${inProgress ? " is-selected" : ""}`}
            aria-pressed={inProgress}
            onClick={event => toggleCourseGroup(group, "in_progress", event)}
          >
            In Progress
          </button>
        </div>
        {group.options && requirementMode && (
          <div
            className="requirement-choice-card"
            style={requirementPopoverPosition?.groupId === group.id ? {
              left: `${requirementPopoverPosition.left}px`,
              top: `${requirementPopoverPosition.top}px`
            } : undefined}
            onMouseLeave={() => closeRequirementPopover(group.id)}
            ref={node => {
              requirementCardRefs.current[group.id] = node;
            }}
          >
            <strong>Which course(s) satisfy this requirement?</strong>
            <div className="choice-options">
              {group.options.map(option => {
                const course = formData.courses.find(item => item.code === option.code);
                const checked = requirementMode === "completed" ? isTaken(course || {}) : course?.status === requirementMode;
                return (
                  <label className={`choice-option${checked ? " is-selected" : ""}`} key={option.code}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleGroupOption(group, option.code)}
                    />
                    <span className="choice-radio" aria-hidden="true" />
                    <span className="choice-check" aria-hidden="true">{checked ? "\u2713" : ""}</span>
                    <span className="choice-label"><strong>{option.code}</strong><small>{option.title}</small></span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
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

  function renderDeclarationColumns(courseGroups, requirementGroups) {
    return (
      <div className="course-columns" style={COURSE_COLUMNS_STYLE}>
        <div className="course-column">{courseGroups.map(renderCourseGroup)}</div>
        <div className="course-column">{requirementGroups.map(renderCourseGroup)}</div>
      </div>
    );
  }

  return (
    <main className="container">
      <style jsx global>{`
        :root {
          --planner-bg: #7c3aed;
          --planner-panel: #ffffff;
          --planner-border: #a9b0b5;
          --planner-strong-border: #202427;
          --planner-muted: #5c656b;
          --planner-green: #bde9c9;
          --planner-blue: #cfe9fb;
          --planner-blue-border: #8dbddb;
          --urveska-orange: #ff9d5c;
          --urveska-gold: #ffd166;
          --urveska-aqua: #8ef7d3;
        }
        body, button, input, select, textarea { font-family: Arial, sans-serif !important; font-size: 11px !important; }
        body { background: var(--planner-bg); color: #171a1c; }
        h1, h2, h3, h4, h5, h6 { color: #1d4ed8 !important; font-size: 14px !important; font-weight: 700 !important; }
        main.container { max-width: 1240px; padding: 1.25rem 1rem 4rem; }
        .summary-card, .plan-section { border: 1px solid var(--planner-strong-border); background: var(--planner-panel); }
        .intake-card { border: 1px solid var(--planner-strong-border); background: #f1faff; }
        .app-header { display: flex; align-items: center; justify-content: center; text-align: center; gap: 1rem; padding: .85rem 1.1rem; margin-bottom: 1rem; }
        .app-header h1 { margin: 0; color: #06182e !important; font-size: 36px !important; line-height: 1.05; }
        .app-header h1 .headline-econ { color: var(--urveska-aqua) !important; }
        .app-header h1 .headline-planner { color: var(--urveska-orange) !important; }
        .intake-layout { display: grid; gap: 1rem; grid-template-columns: 1fr; align-items: start; }
        .intake-card, .summary-card, .plan-section { padding: 1.1rem; }
        .section-heading { display: flex; gap: .65rem; align-items: flex-start; }
        .section-heading h2 { margin: 0; }
        .section-heading p { margin: .2rem 0 0; color: var(--planner-muted); font-size: 12px; }
        .step-number { font-weight: 700; line-height: 1.1; }
        .planning-details { margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--planner-border); }
        .planning-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; margin-top: .85rem; max-width: 38rem; }
        .planning-field { display: grid; gap: .25rem; }
        .planning-field label, .planning-label { color: var(--planner-muted); }
        .planning-field input, .planning-field select { width: 100%; box-sizing: border-box; }
        .summer-standing-selection { display: flex; align-items: center; gap: .35rem; margin-top: .35rem; color: var(--planner-muted); }
        .summer-standing-selection strong { color: #171a1c; font-weight: 700; }
        button.summer-standing-change { width: auto; min-height: 0 !important; margin: 0; padding: 0 .3rem; border: 0; background: transparent; color: #1d4ed8; font-size: 11px !important; text-decoration: underline; }
        button.summer-standing-change:hover { color: #163ea9; }
        .date-display { display: flex; align-items: baseline; gap: .4rem; min-height: 1.5rem; }
        .date-display strong { font-weight: 400; }
        button.date-edit-button { width: auto; min-height: 0 !important; margin: 0 0 0 .25rem; padding: 0 .3rem; border: 0; background: transparent; color: #1d4ed8; text-decoration: underline; }
        button.date-edit-button:hover { color: #163ea9; }
        #plan-creation-date::-webkit-calendar-picker-indicator { display: none; }
        .clarification-card { display: block; max-width: 38rem; margin-top: .85rem; padding: .8rem; border: 1px solid #6db784; background: #effaf1; }
        .clarification-card strong { display: block; }
        .clarification-card p { margin: .35rem 0 .65rem; color: var(--planner-muted); }
        .clarification-card > p, .clarification-card > .radio-choices { width: 100%; box-sizing: border-box; }
        .radio-choices { display: grid; grid-template-columns: 1fr; gap: .35rem; margin-top: .65rem; padding-left: 3ch; }
        .radio-choice { display: flex; align-items: center; gap: .35rem; cursor: pointer; }
        .radio-choice input { margin: 0; }
        .search-label { display: block; width: 33.333%; margin: 1rem 0 .7rem; }
        .search-label input { width: 100%; box-sizing: border-box; margin: 0; }
        .course-columns { display: grid; grid-template-columns: max-content max-content; gap: .45rem; align-items: start; justify-content: start; }
        .course-column { display: flex; flex-direction: column; gap: .45rem; width: max-content; max-width: 100%; min-width: 0; }
        .two-hundred-section { margin-top: .9rem; padding-top: .85rem; border-top: 2px solid var(--planner-strong-border); }
        .course-row { position: relative; display: grid; grid-template-columns: var(--course-name-width) auto; grid-template-rows: 16.5px; width: max-content; max-width: 100%; height: max-content; gap: .5rem; align-items: center; min-width: 0; border: 1px solid var(--planner-border); padding: .4rem .5rem; background: #fff; }
        .course-row.has-requirement { z-index: 20; }
        .course-name { display: flex; width: var(--course-name-width); gap: .65rem; align-items: center; min-width: 0; white-space: nowrap; }
        .course-name strong { flex: 0 0 auto; min-width: 0; white-space: nowrap; }
        .course-name span { min-width: 0; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: break-word; line-height: 1.25; }
        .course-toggles { display: flex; gap: .25rem; align-items: center; flex-wrap: nowrap; }
        button.course-toggle { width: auto; min-height: 0 !important; height: auto; margin: 0; padding: 0 .35rem; border: 1px solid var(--planner-border); border-radius: .35rem; background: #fff; color: #171a1c; line-height: 1.25; white-space: nowrap; }
        button.course-toggle:hover { border-color: var(--planner-strong-border); }
        button.taken-toggle.is-selected { background: var(--planner-green); border-color: #6db784; }
        button.progress-toggle.is-selected { background: var(--planner-blue); border-color: var(--planner-blue-border); }
        .course-accordion { margin-top: .85rem; border-top: 1px solid var(--planner-border); padding-top: .75rem; }
        .course-accordion summary { display: flex; align-items: center; gap: .5rem; cursor: pointer; list-style: none; color: #171a1c; font-weight: 700; }
        .course-accordion summary::-webkit-details-marker { display: none; }
        .course-accordion summary::after { content: "▶"; margin-left: .1rem; color: #ff7a00; font-size: 14px; line-height: 1; }
        .course-accordion[open] summary::after { content: "▼"; }
        .course-accordion-title { color: #171a1c; }
        .course-accordion-count { margin-left: auto; color: var(--planner-muted); font-weight: 400; }
        .course-accordion .course-columns { margin-top: .7rem; }
        .requirement-choice-card { position: absolute; z-index: 30; top: calc(100% + .35rem); left: 0; width: max-content; max-width: calc(100vw - 2rem); scroll-margin: 1rem; padding: .35rem; border: 1px solid #cfd3d5; border-radius: .9rem; background: #fff; box-shadow: 0 .5rem 1.4rem rgba(32, 36, 39, .14); }
        .requirement-choice-card > strong { display: block; padding: .4rem .55rem .3rem; color: var(--planner-muted); font-weight: 400; }
        .choice-options { display: grid; gap: .1rem; width: max-content; min-width: 100%; margin: 0; }
        .choice-option { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; width: max-content; min-width: 100%; box-sizing: border-box; gap: .8rem; padding: .55rem .8rem .55rem .6rem; border: 0; border-radius: .65rem; background: #fff; cursor: pointer; white-space: nowrap; }
        .choice-option.is-selected { background: #f3fff5; }
        .choice-option:hover { background: #f4f5f6; }
        .choice-option input { position: absolute; opacity: 0; pointer-events: none; }
        .choice-radio { display: none; }
        .choice-label { display: grid; gap: .1rem; min-width: 0; }
        .choice-check { width: 1rem; color: #2f8f4e; font-size: 15px; font-weight: 700; line-height: 1; text-align: center; }
        .choice-option small { color: var(--planner-muted); }
        .generate-row { margin-top: 1rem; display: flex; justify-content: flex-end; }
        .generate-button { width: auto; margin: 0; border: 1px solid #73b98a; background: var(--planner-green); color: #171a1c; font-weight: 700; }
        .generate-button:hover { background: #a6dfb6; }
        .generate-button:disabled { cursor: not-allowed; opacity: .6; }
        .summary-card { min-height: 100%; margin-bottom: 1rem; }
        .planner-instructions { margin: .85rem 0 0; font-size: 16px !important; font-weight: 700; }
        .planner-instructions p { margin: .25rem 0; font-size: 16px !important; font-weight: 700; }
        .summary-grid { display: grid; gap: .45rem; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 1rem; }
        .summary-grid div { display: flex; align-items: baseline; gap: .35rem; border: 1px solid var(--planner-border); padding: .45rem .6rem; min-height: 0; }
        .summary-grid span { color: var(--planner-muted); }
        .summary-grid strong { margin: 0; }
        .summary-empty { margin-top: 1rem; padding: 1rem; border: 1px dashed var(--planner-border); color: var(--planner-muted); }
        .summary-footnote { margin: 1rem 0 0; color: var(--planner-muted); }
        .status { margin: .8rem 0 0; color: var(--planner-muted); min-height: 1.4rem; }
        .plan-section { margin-top: 1rem; }
        .plan-source-note { margin: .35rem 0 0; color: var(--planner-muted); }
        .plan-tabs { display: flex; gap: .35rem; border-bottom: 1px solid var(--planner-border); margin-bottom: .85rem; }
        button.plan-tab { width: auto; min-height: 0 !important; margin: 0; padding: .35rem .75rem; border: 1px solid var(--planner-border); border-bottom: 0; background: #fff; color: #171a1c; font-weight: 700; }
        button.plan-tab.is-active { background: var(--planner-blue); border-color: var(--planner-blue-border); }
        .academic-year-group { margin-top: 1rem; }
        .academic-year-label { margin: 0 0 .55rem; color: #1d4ed8 !important; font-size: 14px !important; font-weight: 700 !important; }
        .plan-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .8rem; }
        .term-card { border: 1px solid var(--planner-border); padding: .8rem; min-height: 8rem; }
        .term-card h4 { margin: 0 0 .65rem; color: #1d4ed8; font-size: 14px; font-weight: 700; }
        .term-card ul { display: grid; gap: .45rem; list-style: none; margin: 0; padding: 0; }
        .term-card li { border: 1px solid #d1d6d9; padding: .45rem; }
        .term-card li strong, .term-card li span { display: block; }
        .term-card li span { color: var(--planner-muted); margin-top: .1rem; }
        .empty-term { margin: 0; color: var(--planner-muted); }
        .summer-term-note { margin: .65rem 0 0; color: #2f8f4e; font-weight: 700; }
        .plan-notes { margin-top: 1rem; padding: .75rem; border: 1px solid #d5b36a; background: #fff9e8; }
        .plan-notes ul { margin: .45rem 0 0; padding-left: 1.25rem; }
        .catalog-notice { margin: 0 0 1rem; padding: .75rem; border: 1px solid #d5b36a; background: #fff9e8; }
        .catalog-notice-positive { border-color: #73b98a; background: #effaf1; }
        .catalog-notice strong { color: #1d4ed8; }
        .catalog-notice p { margin: .35rem 0 0; }
        .catalog-notice ul { margin: .45rem 0 0; padding-left: 1.25rem; }
        @media (max-width: 900px) { .intake-layout { grid-template-columns: 1fr; } }
        @media (max-width: 680px) {
          .course-columns { grid-template-columns: 1fr; }
          .course-column, .course-row { width: 100%; max-width: 100%; }
          .course-row { grid-template-columns: 1fr; grid-template-rows: auto; height: auto; }
          .course-name { width: auto; }
          .search-label { width: 100%; }
          .planning-fields { grid-template-columns: 1fr; }
          .course-name { white-space: normal; }
          .course-name span { white-space: normal; }
          .course-toggles { flex-wrap: wrap; }
          .requirement-choice-card { right: 0; width: auto; max-width: none; }
          .choice-options, .choice-option { width: 100%; min-width: 0; }
          .choice-option { white-space: normal; }
          .generate-row { justify-content: stretch; }
          .generate-button { width: 100%; }
          .plan-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      <header className="app-header">
        <div>
          <h1><span className="headline-econ">Econ</span> <span className="headline-planner">Planner</span></h1>
        </div>
      </header>

      <form onSubmit={mapMajors}>
        <div className="intake-layout">
          <section className="intake-card">
            <div className="planner-instructions">
              <p>1. Choose class standing</p>
              <p>2. Select Econ courses taken or in progress</p>
              <p>3. Click on Generate My Plan below course selection list.</p>
            </div>
            <div className="planning-details">
              <div className="section-heading">
                <div>
                  <h2>1. Choose class standing and courses taken or in progress</h2>
                  <p>These two answers set the number of years and terms in your plan.</p>
                </div>
              </div>
              <div className="planning-fields">
                <div className="planning-field">
                  <label htmlFor="academic-standing">Class standing</label>
                  <select
                    id="academic-standing"
                    value={formData.academicStanding}
                    onChange={event => setFormData(current => ({
                      ...current,
                      academicStanding: event.target.value,
                      summerStandingConfirmed: ""
                    }))}
                  >
                    <option value="freshman">Freshman</option>
                    <option value="sophomore">Sophomore</option>
                    <option value="junior">Junior</option>
                    <option value="senior">Senior</option>
                  </select>
                  {summerStandingSelection && (
                    <div className="summer-standing-selection" role="status">
                      <span>Selected: <strong>{summerStandingSelection}</strong></span>
                      <button
                        type="button"
                        className="summer-standing-change"
                        onClick={() => setFormData(current => ({ ...current, summerStandingConfirmed: "" }))}
                      >
                        Change
                      </button>
                    </div>
                  )}
                </div>
                <div className="planning-field">
                  <div className="date-display" aria-labelledby="plan-creation-date-label">
                    <span id="plan-creation-date-label" className="planning-label">Plan creation date:</span>
                    <strong>{formatPlanCreationDate(formData.planCreationDate)}</strong>
                    <button
                      type="button"
                      className="date-edit-button"
                      aria-expanded={isEditingPlanDate}
                      aria-controls="plan-creation-date"
                      onClick={() => setIsEditingPlanDate(current => !current)}
                    >
                      {isEditingPlanDate ? "Done" : "Change"}
                    </button>
                  </div>
                  {isEditingPlanDate && (
                    <input
                      id="plan-creation-date"
                      type="date"
                      aria-labelledby="plan-creation-date-label"
                      value={formData.planCreationDate}
                      onChange={event => setFormData(current => ({
                        ...current,
                        planCreationDate: event.target.value,
                        summerStandingConfirmed: ""
                      }))}
                    />
                  )}
                </div>
              </div>
              {planningContext.requiresSummerClarification && (
                <div className="clarification-card" role="group" aria-labelledby="summer-standing-question">
                  <strong id="summer-standing-question">{planningContext.question}</strong>
                  <p>Summer class standing can refer to the upcoming Fall or the academic year that ended in Spring/May.<br />Choose one so the planner does not guess.</p>
                  <div className="radio-choices">
                    <label className="radio-choice">
                      <input
                        type="radio"
                        name="summer-standing-confirmed"
                        value="yes"
                        checked={formData.summerStandingConfirmed === "yes"}
                        onChange={event => setFormData(current => ({ ...current, summerStandingConfirmed: event.target.value }))}
                      />
                      Yes, I will be this standing in the upcoming Fall.
                    </label>
                    <label className="radio-choice">
                      <input
                        type="radio"
                        name="summer-standing-confirmed"
                        value="no"
                        checked={formData.summerStandingConfirmed === "no"}
                        onChange={event => setFormData(current => ({ ...current, summerStandingConfirmed: event.target.value }))}
                      />
                      No, I was this standing during the year that ended in Spring/May.
                    </label>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="intake-card">
            <div className="section-heading">
              <span className="step-number">2.</span>
              <div>
                <h2>Your Courses</h2>
                <p>Select completed and in-progress courses. We will map out your remaining plan.</p>
                <p>Choose a status for each course. Click a selected button again to clear it.</p>
              </div>
            </div>

            <label className="search-label">
              <span className="sr-only">Search courses</span>
              <input
                type="search"
                value={courseSearch}
                onChange={event => setCourseSearch(event.target.value)}
                placeholder="Search courses..."
              />
            </label>

            {declarationGroups.length > 0 && (
              <div className="course-level-section declaration-section">
                {renderDeclarationColumns(declarationCourseGroups, declarationRequirementGroups)}
              </div>
            )}

            {renderCourseAccordion("one-hundred-level", "100 level courses", oneHundredGroups)}
            {renderCourseAccordion("two-hundred-level", "200 level courses", twoHundredGroups)}
            {renderCourseAccordion("three-hundred-level", "300 level and above", advancedGroups)}

            {visibleGroups.length === 0 && <p className="status">No courses match your search.</p>}

            <div className="generate-row">
              <button
                type="submit"
                className="generate-button"
                disabled={!formData.planCreationDate || planningContext.requiresSummerClarification}
              >
                Generate My Plan
              </button>
            </div>
          </section>
        </div>
        <PlannerSummary report={report} courses={formData.courses} />
      </form>

      {status && <p className="status" role="status">{status}</p>}
      <PlanTimeline plans={economicsResult(report)?.economicsPlans || []} />
    </main>
  );
}
