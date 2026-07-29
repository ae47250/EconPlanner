"use client";

import { useEffect, useRef, useState } from "react";

const CATALOG_YEAR = "2025-2026";
const PLANNER_STORAGE_KEY = "econ-planner-ui-state";

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
  { code: "ECO 307", title: "Directed Study" },
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
  { code: "ECO 461", title: "Senior Seminar: Econometrics" },
  { code: "ECO 471", title: "Senior Thesis" }
];

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
    displayLevel: 200,
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
    .filter(course => !GROUPED_COURSE_CODES.has(course.code) && !["ECO 113", "ECO 114", "ECO 213", "ECO 214"].includes(course.code))
    .map(course => ({
      id: course.code,
      code: course.code,
      title: course.title,
      courseCodes: [course.code]
    }))
];

const blankCourse = course => ({
  id: course.code,
  code: course.code,
  title: course.title,
  status: "not_started",
  units: "1",
  grade: "",
  source: "manual_code",
  notes: ""
});

const initialForm = {
  displayName: "",
  entryCatalogYear: CATALOG_YEAR,
  majorDeclarationCatalogYear: "",
  academicStanding: "freshman",
  expectedGraduationTerm: "",
  courses: COURSE_CATALOG.map(blankCourse),
  advisorApprovals: ""
};

function courseLevel(code) {
  return Number(String(code).match(/\d+$/)?.[0] || 0);
}

function isTaken(course) {
  return course.status === "completed" || course.status === "transfer";
}

function selectedCourses(courses) {
  return courses.filter(course => ["completed", "transfer", "in_progress"].includes(course.status));
}

function economicsResult(report) {
  return report?.programs?.find(result => result.economicsPlan || result.program?.name === "Economics") || null;
}

function planCourseCount(plan) {
  return plan?.terms?.reduce((count, term) => count + term.courses.length, 0) || 0;
}

function PlanTimeline({ plan }) {
  if (!plan) return null;

  return (
    <section className="plan-section" aria-live="polite">
      <div className="plan-tabs" role="tablist" aria-label="Generated plans">
        <button
          type="button"
          className="plan-tab is-active"
          id="plan-1-tab"
          role="tab"
          aria-selected="true"
          aria-controls="plan-1"
        >
          Plan 1
        </button>
      </div>
      <div id="plan-1" role="tabpanel" aria-labelledby="plan-1-tab">
        <div className="section-heading">
          <span className="step-number">3.</span>
          <div>
            <h2>Your Plan</h2>
            <p>Suggested placements based on the courses you selected.</p>
          </div>
        </div>
        <div className="plan-grid">
          {(plan.terms || []).map(term => (
            <article className="term-card" key={term.term}>
              <h3>{term.term}</h3>
              {term.courses.length > 0 ? (
                <ul>
                  {term.courses.map(course => (
                    <li key={`${term.term}-${course.course}`}>
                      <strong>{course.course}</strong>
                      <span>{course.title}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-term">No courses placed</p>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function PlannerSummary({ report, courses }) {
  const result = economicsResult(report);
  const plan = result?.economicsPlan;
  const chosen = selectedCourses(courses);
  const completedCount = chosen.filter(course => isTaken(course)).length;
  const inProgressCount = chosen.filter(course => course.status === "in_progress").length;
  const remainingUnits = result?.projectedAfterInProgress?.optimistic?.remainingUnits
    ?? result?.optimistic?.remainingUnits;

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
          <div className="summary-grid">
            <div><span>Taken or AP credit</span><strong>{completedCount}</strong></div>
            <div><span>In Progress</span><strong>{inProgressCount}</strong></div>
            <div><span>Remaining</span><strong>{remainingUnits ?? "-"}</strong></div>
            <div><span>Courses in plan</span><strong>{planCourseCount(plan)}</strong></div>
          </div>
          <p className="summary-footnote">The plan uses the selected course status and verified economics scheduling rules.</p>
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
  const [courseSearch, setCourseSearch] = useState("");
  const [isHydrated, setIsHydrated] = useState(false);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(PLANNER_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.formData && Array.isArray(parsed.formData.courses)) {
          setFormData(current => ({ ...current, ...parsed.formData }));
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
  const regularGroups = visibleGroups.filter(group => courseLevel(group.code) < 300);
  const groupLevel = group => group.displayLevel || courseLevel(group.code);
  const foundationGroups = regularGroups.filter(group => groupLevel(group) < 200);
  const twoHundredGroups = regularGroups.filter(group => groupLevel(group) >= 200);
  const advancedGroups = visibleGroups.filter(group => groupLevel(group) >= 300);

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

  function renderCourseColumns(groups) {
    const midpoint = Math.ceil(groups.length / 2);
    return (
      <div className="course-columns">
        <div className="course-column">{groups.slice(0, midpoint).map(renderCourseGroup)}</div>
        <div className="course-column">{groups.slice(midpoint).map(renderCourseGroup)}</div>
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
        }
        body, button, input, select, textarea { font-family: Arial, sans-serif !important; font-size: 11px !important; }
        body { background: var(--planner-bg); color: #171a1c; }
        h1, h2, h3, h4, h5, h6 { color: #1d4ed8 !important; font-size: 14px !important; font-weight: 700 !important; }
        main.container { max-width: 1240px; padding: 1.25rem 1rem 4rem; }
        .app-header, .summary-card, .plan-section { border: 1px solid var(--planner-strong-border); background: var(--planner-panel); }
        .intake-card { border: 1px solid var(--planner-strong-border); background: #f1faff; }
        .app-header { display: flex; align-items: center; gap: 1rem; padding: .85rem 1.1rem; margin-bottom: 1rem; }
        .app-header h1 { margin: 0; }
        .app-header p { margin: .1rem 0 0; color: var(--planner-muted); font-size: 12px; }
        .menu-button { position: relative; width: 2.4rem; height: 2.4rem; padding: 0; border: 1px solid var(--planner-strong-border); background: #fff; color: transparent !important; font-size: 0; }
        .menu-button::before { content: ""; position: absolute; top: 50%; left: 50%; width: 1.1rem; height: 2px; background: #171a1c; transform: translate(-50%, -50%); box-shadow: 0 -5px #171a1c, 0 5px #171a1c; }
        .intake-layout { display: grid; gap: 1rem; grid-template-columns: 1fr; align-items: start; }
        .intake-card, .summary-card, .plan-section { padding: 1.1rem; }
        .section-heading { display: flex; gap: .65rem; align-items: flex-start; }
        .section-heading h2 { margin: 0; }
        .section-heading p { margin: .2rem 0 0; color: var(--planner-muted); font-size: 12px; }
        .step-number { font-weight: 700; line-height: 1.1; }
        .search-label { display: block; width: 33.333%; margin: 1rem 0 .7rem; }
        .search-label input { width: 100%; box-sizing: border-box; margin: 0; }
        .course-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .45rem; align-items: start; }
        .course-column { display: grid; gap: .45rem; min-width: 0; }
        .two-hundred-section { margin-top: .9rem; padding-top: .85rem; border-top: 2px solid var(--planner-strong-border); }
        .course-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .5rem; align-items: baseline; min-width: 0; border: 1px solid var(--planner-border); padding: .4rem .5rem; background: #fff; }
        .course-row.has-requirement { z-index: 20; }
        .course-name { display: flex; gap: .65rem; align-items: baseline; min-width: 0; white-space: nowrap; }
        .course-name strong { flex: 0 0 auto; min-width: 0; white-space: nowrap; }
        .course-name span { min-width: 0; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: break-word; line-height: 1.25; }
        .course-toggles { display: flex; gap: .25rem; align-items: baseline; flex-wrap: nowrap; }
        button.course-toggle { width: auto; min-height: 0 !important; height: auto; margin: 0; padding: 0 .35rem; border: 1px solid var(--planner-border); border-radius: .35rem; background: #fff; color: #171a1c; line-height: 1.25; white-space: nowrap; }
        button.course-toggle:hover { border-color: var(--planner-strong-border); }
        button.taken-toggle.is-selected { background: var(--planner-green); border-color: #6db784; }
        button.progress-toggle.is-selected { background: var(--planner-blue); border-color: var(--planner-blue-border); }
        .course-accordion { margin-top: .85rem; border-top: 1px solid var(--planner-border); padding-top: .75rem; }
        .course-accordion summary { display: flex; justify-content: space-between; cursor: pointer; color: #171a1c; font-weight: 700; }
        .course-accordion summary span { color: var(--planner-muted); font-weight: 400; }
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
        .generate-button { width: auto; margin: 0; border: 1px solid var(--planner-strong-border); background: #fff; color: #171a1c; font-weight: 700; }
        .generate-button:hover { background: #edf0f1; }
        .summary-card { min-height: 100%; margin-bottom: 1rem; }
        .summary-grid { display: grid; gap: .65rem; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 1rem; }
        .summary-grid div { border: 1px solid var(--planner-border); padding: .8rem; min-height: 4.6rem; }
        .summary-grid span { display: block; color: var(--planner-muted); }
        .summary-grid strong { display: block; margin-top: .3rem; }
        .summary-empty { margin-top: 1rem; padding: 1rem; border: 1px dashed var(--planner-border); color: var(--planner-muted); }
        .summary-footnote { margin: 1rem 0 0; color: var(--planner-muted); }
        .status { margin: .8rem 0 0; color: var(--planner-muted); min-height: 1.4rem; }
        .plan-section { margin-top: 1rem; }
        .plan-tabs { display: flex; gap: .35rem; border-bottom: 1px solid var(--planner-border); margin-bottom: .85rem; }
        button.plan-tab { width: auto; min-height: 0 !important; margin: 0; padding: .35rem .75rem; border: 1px solid var(--planner-border); border-bottom: 0; background: #fff; color: #171a1c; font-weight: 700; }
        button.plan-tab.is-active { background: var(--planner-blue); border-color: var(--planner-blue-border); }
        .plan-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .8rem; margin-top: 1rem; }
        .term-card { border: 1px solid var(--planner-border); padding: .8rem; min-height: 8rem; }
        .term-card h3 { margin: 0 0 .65rem; }
        .term-card ul { display: grid; gap: .45rem; list-style: none; margin: 0; padding: 0; }
        .term-card li { border: 1px solid #d1d6d9; padding: .45rem; }
        .term-card li strong, .term-card li span { display: block; }
        .term-card li span { color: var(--planner-muted); margin-top: .1rem; }
        .empty-term { margin: 0; color: var(--planner-muted); }
        @media (max-width: 900px) { .intake-layout { grid-template-columns: 1fr; } }
        @media (max-width: 680px) {
          .course-columns { grid-template-columns: 1fr; }
          .course-row { grid-template-columns: 1fr; }
          .search-label { width: 100%; }
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
        <button type="button" className="menu-button" aria-label="Open menu">=</button>
        <div>
          <h1>Econ Planner</h1>
          <p>Select completed and in-progress courses. We will map out your remaining plan.</p>
        </div>
      </header>

      <form onSubmit={mapMajors}>
        <PlannerSummary report={report} courses={formData.courses} />

        <div className="intake-layout">
          <section className="intake-card">
            <div className="section-heading">
              <span className="step-number">1.</span>
              <div>
                <h2>Your Courses</h2>
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

            <div className="course-level-section">
              {foundationGroups.length > 0 && renderCourseColumns(foundationGroups)}
            </div>

            {twoHundredGroups.length > 0 && (
              <div className="course-level-section two-hundred-section">
                {renderCourseColumns(twoHundredGroups)}
              </div>
            )}

            <details className="course-accordion">
              <summary>
                <span>300-level and above</span>
                <span>{advancedGroups.length} courses</span>
              </summary>
              {renderCourseColumns(advancedGroups)}
            </details>

            {visibleGroups.length === 0 && <p className="status">No courses match your search.</p>}

            <div className="generate-row">
              <button type="submit" className="generate-button">Generate My Plan</button>
            </div>
          </section>
        </div>
      </form>

      {status && <p className="status" role="status">{status}</p>}
      <PlanTimeline plan={economicsResult(report)?.economicsPlan} />
    </main>
  );
}
