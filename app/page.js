"use client";

import { useEffect, useRef, useState } from "react";
import { resolvePlanningContext } from "../lib/planning/horizon.js";
import {
  selectedStatus,
  validateCoursePrerequisites,
  validateStudentPrerequisites
} from "../lib/planning/prerequisiteValidation.js";
import economicsCourseData from "../data/normalized/economics/courses.json";

const PLANNER_STORAGE_KEY = "econ-planner-ui-state";
const PLANNER_STORAGE_VERSION = 2;
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

const GROUPED_COURSE_CODES = new Set([
  "MAT 113", "MAT 121", "ECO 257", "MAT 217", "PSY 217", "ECO 321", "BUSN 323"
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
    id: "ECO 461",
    code: "ECO 461",
    title: "Senior Seminar: Econometrics",
    courseCodes: ["ECO 461"]
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
  {
    id: "finance-requirement",
    code: "ECO 321 / BUSN 323",
    title: "Finance requirement",
    courseCodes: ["ECO 321", "BUSN 323"],
    options: [
      { code: "ECO 321", title: "Money & Financial Markets" },
      { code: "BUSN 323", title: "Business finance option" }
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
const DECLARATION_RIGHT_COURSE_IDS = ["ECO 160", "ECO 161"];
const RELATIVELY_FREQUENT_COURSE_IDS = new Set(["finance-requirement", "ECO 331", "ECO 333"]);
const DECLARATION_GROUP_IDS = new Set([...DECLARATION_COURSE_IDS, ...DECLARATION_REQUIREMENT_IDS, ...DECLARATION_RIGHT_COURSE_IDS]);
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
  return JSON.stringify({
    academicStanding: formData.academicStanding,
    planCreationDate: formData.planCreationDate,
    summerStandingConfirmed: formData.summerStandingConfirmed,
    courses: selectedCourses(formData.courses)
      .map(course => [canonicalSavedCode(course.code), course.status, course.units, course.source])
      .sort((left, right) => left[0].localeCompare(right[0]))
  });
}

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

function courseTitle(code) {
  return COURSE_CATALOG.find(course => course.code === code)?.title || code;
}

function clearInvalidDependents(courses, changedCode) {
  const nextCourses = courses.map(course => ({ ...course }));
  const affectedCodes = new Set([changedCode]);
  const clearedCodes = [];

  while (true) {
    const validation = validateStudentPrerequisites(nextCourses, COURSE_PREREQUISITES);
    const invalidDependent = validation.issues.find(issue => (
      !clearedCodes.includes(issue.course)
      && [issue.prerequisite, ...(issue.options || [])].some(code => affectedCodes.has(code))
    ));
    if (!invalidDependent) break;

    const dependent = nextCourses.find(course => course.code === invalidDependent.course);
    if (!dependent || dependent.status === "not_started") break;
    dependent.status = "not_started";
    affectedCodes.add(dependent.code);
    clearedCodes.push(dependent.code);
  }

  return { courses: nextCourses, clearedCodes };
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

function PlanningGaps({ items = [] }) {
  if (!items.length) return null;
  return (
    <div className="plan-notes planning-gaps" role="status">
      <strong>Planning Gaps</strong>
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

function AdvisorAttention({ catalog }) {
  const notices = catalog?.advisorAttention || [];
  if (!notices.length) return null;
  return (
    <section className="advisor-attention" aria-live="polite">
      <h2>Advisor Attention</h2>
      {notices.map(notice => (
        <div className={`advisor-attention-item is-${notice.severity || "warning"}`} key={notice.code}>
          {notice.title && notice.title !== "Advisor Attention" && <strong>{notice.title}</strong>}
          <p>{notice.message}</p>
          {notice.findings?.length > 0 && (
            <ul>
              {notice.findings.map(finding => <li key={`${finding.code}-${finding.message}`}>{finding.message}</li>)}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

function PlanTimeline({ plans = [], planningGaps = [] }) {
  const [activePlanId, setActivePlanId] = useState(plans[0]?.id || "plan-1");

  useEffect(() => {
    if (plans.length && !plans.some(plan => plan.id === activePlanId)) {
      setActivePlanId(plans[0].id);
    }
  }, [activePlanId, plans]);

  if (!plans.length) {
    return planningGaps.length ? (
      <section className="plan-section" aria-live="polite">
        <PlanningGaps items={planningGaps} />
      </section>
    ) : null;
  }

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
            <p className="plan-source-note">Verified course schedule: {formatAcademicYear(activePlan.academicYear)}. “Term to be confirmed” means the academic year is planned but the exact future offering has not been published.</p>
          </div>
        </div>
        <div className="academic-year-groups">
          {academicYearGroups.map(group => (
            <section className="academic-year-group" key={group.label}>
              <h3 className="academic-year-label">{group.label}</h3>
              <div className="plan-grid">
                {group.terms.map(term => (
                  <article className={`term-card${term.isPlaceholder ? " is-placeholder" : ""}`} key={term.slotId || term.term}>
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
                    {term.isPlaceholder && (
                      <p className="placeholder-term-note">Exact course offerings and terms must be confirmed after the schedule is published.</p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
        <PlanningGaps items={[...(activePlan.unscheduled || []), ...planningGaps]} />
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

function compactPlanCourse(course) {
  if (course.course === "ECO elective" && course.minimumLevel === 200) {
    return "ECO elective (200+)";
  }
  return course.course;
}

function comparisonScheduleRows(plan) {
  const rows = (plan?.terms || [])
    .filter(term => term.courses.length > 0)
    .map(term => ({
      key: `${term.academicYear || ""}-${term.isPlaceholder ? "TBC" : term.displayTerm || term.term}`,
      academicYear: formatAcademicYear(term.academicYear),
      term: term.isPlaceholder ? "Term to be confirmed" : term.displayTerm || term.term,
      courses: term.courses.map(compactPlanCourse)
    }));

  return rows.map((row, index) => {
    if (index > 0 && rows[index - 1].academicYear === row.academicYear) {
      return row;
    }

    const yearRowSpan = rows.slice(index).findIndex(item => item.academicYear !== row.academicYear);
    return { ...row, yearRowSpan: yearRowSpan === -1 ? rows.length - index : yearRowSpan };
  });
}

function PlanComparisonScreen({ report, courses, isExiting, onEditCourses }) {
  const result = economicsResult(report);
  const plans = result?.economicsPlans || [];
  const planningGaps = result?.economicsPlanningGaps || [];
  const planningContext = result?.planningContext;
  const [selectedPlanId, setSelectedPlanId] = useState(plans[0]?.id || "");
  const [showDifferencesOnly, setShowDifferencesOnly] = useState(false);

  useEffect(() => {
    if (plans.length && !plans.some(plan => plan.id === selectedPlanId)) {
      setSelectedPlanId(plans[0].id);
    }
  }, [plans, selectedPlanId]);

  const rowsByPlan = new Map(plans.map(plan => [plan.id, comparisonScheduleRows(plan)]));
  const allRowKeys = new Set([...rowsByPlan.values()].flatMap(rows => rows.map(row => row.key)));
  const identicalRowKeys = new Set([...allRowKeys].filter(key => {
    const signatures = plans.map(plan => {
      const row = rowsByPlan.get(plan.id)?.find(item => item.key === key);
      return row ? row.courses.join("|") : "";
    });
    return signatures.length > 1 && signatures.every(signature => signature === signatures[0]);
  }));
  const standing = planningContext?.effectiveStandingLabel
    || planningContext?.standingLabel
    || "Student";
  const graduationTarget = planningContext?.expectedGraduationTerm || "To be confirmed";
  const completedCodes = courses.filter(isTaken).map(course => course.code);
  const inProgressCodes = courses.filter(course => course.status === "in_progress").map(course => course.code);
  const planBadges = {
    "plan-1": "Even load",
    "plan-2": "More later",
    "plan-3": "Standing-aware"
  };

  return (
    <main className={`comparison-page${isExiting ? " is-exiting" : ""}`}>
      <style jsx global>{`
        body {
          margin: 0;
          background:
            radial-gradient(circle at 8% 10%, rgba(23, 151, 210, .12), transparent 24rem),
            linear-gradient(145deg, #f8fbff 0%, #eef4fa 58%, #fff8ed 100%);
          color: #101f45;
          font-family: Arial, sans-serif;
        }
        button, input { font-family: Arial, sans-serif; }
        .comparison-page {
          min-height: 100vh;
          animation: comparison-enter .28s ease-out both;
        }
        .comparison-page.is-exiting { animation: comparison-exit .24s ease-in both; }
        @keyframes comparison-enter {
          from { opacity: 0; transform: translateX(4rem); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes comparison-exit {
          from { opacity: 1; transform: translateX(0); }
          to { opacity: 0; transform: translateX(4rem); }
        }
        .comparison-topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 1rem 2rem;
          border-bottom: 1px solid #cbd5e1;
          background: rgba(255, 255, 255, .92);
          box-shadow: 0 1px 8px rgba(15, 35, 75, .06);
        }
        .comparison-brand {
          color: #071956;
          font-size: 25px;
          font-weight: 700;
          letter-spacing: -.03em;
        }
        .comparison-student {
          display: flex;
          align-items: center;
          gap: .45rem;
          margin-left: auto;
          color: #071956;
          font-size: 15px;
        }
        .comparison-student strong { font-weight: 700; }
        .edit-courses-button {
          width: auto;
          min-height: 0;
          margin: 0 0 0 1.25rem;
          padding: .65rem 1rem;
          border: 1px solid #102a83;
          border-radius: .45rem;
          background: #fff;
          color: #071956;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
        }
        .edit-courses-button:hover { background: #edf4ff; }
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
          color: #155eef;
          font-size: 14px;
          cursor: pointer;
        }
        .comparison-back:hover { text-decoration: underline; }
        .comparison-course-status {
          display: grid;
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
        .comparison-course-status strong { color: #071956; }
        .comparison-heading-row {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 1.5rem;
          margin: .55rem 0 1rem;
        }
        .comparison-heading-row h1 {
          margin: 0;
          color: #071956;
          font-size: clamp(29px, 3vw, 42px);
          line-height: 1.05;
          letter-spacing: -.035em;
        }
        .comparison-heading-row p {
          margin: .45rem 0 0;
          color: #53627a;
          font-size: 15px;
        }
        .difference-toggle {
          display: flex;
          align-items: center;
          gap: .6rem;
          flex: 0 0 auto;
          color: #071956;
          font-size: 14px;
          cursor: pointer;
        }
        .difference-toggle input {
          width: 2.7rem;
          height: 1.45rem;
          accent-color: #155eef;
          cursor: pointer;
        }
        .comparison-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 1rem;
          align-items: stretch;
        }
        .comparison-plan-card {
          display: flex;
          min-width: 0;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid #bdc9da;
          border-radius: .7rem;
          background: rgba(255, 255, 255, .96);
          box-shadow: 0 .45rem 1.2rem rgba(20, 44, 92, .06);
        }
        .comparison-plan-card.is-selected {
          border: 2px solid #155eef;
          box-shadow: 0 .65rem 1.5rem rgba(21, 94, 239, .14);
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
          color: #071956;
          font-size: 25px;
          line-height: 1.1;
        }
        .comparison-plan-summary p {
          max-width: 26rem;
          margin: .65rem auto 0;
          color: #41506a;
          font-size: 13px;
          line-height: 1.45;
        }
        .plan-strategy-badge {
          padding: .35rem .55rem;
          border: 1px solid #9dc7ff;
          border-radius: .4rem;
          background: #f3f8ff;
          color: #155eef;
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
          font-size: 11px;
        }
        .compact-schedule th,
        .compact-schedule td {
          padding: .38rem .42rem;
          border: 1px solid #d2dbe6;
          text-align: left;
          vertical-align: top;
        }
        .compact-schedule th {
          background: #eef7fc;
          color: #17345b;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: .035em;
        }
        .compact-schedule th:first-child,
        .compact-schedule td:first-child { width: 30%; white-space: nowrap; }
        .compact-schedule th:nth-child(2),
        .compact-schedule td:nth-child(2) { width: 24%; }
        .compact-schedule td:last-child {
          color: #111d36;
          font-weight: 700;
          line-height: 1.35;
          overflow-wrap: normal;
          word-break: normal;
        }
        .no-differences {
          margin: 1rem;
          padding: 1rem;
          border: 1px dashed #aebdd0;
          color: #53627a;
          text-align: center;
        }
        .plan-validation {
          margin: auto .9rem .7rem;
          color: #087257;
          font-size: 11px;
          font-weight: 700;
          text-align: center;
        }
        .choose-plan-button {
          width: calc(100% - 2rem);
          min-height: 0;
          margin: 0 1rem 1rem;
          padding: .72rem 1rem;
          border: 1px solid #0c3eaf;
          border-radius: .42rem;
          background: #fff;
          color: #071956;
          font-size: 16px;
          font-weight: 700;
          cursor: pointer;
        }
        .choose-plan-button:hover { background: #edf4ff; }
        .comparison-plan-card.is-selected .choose-plan-button {
          background: linear-gradient(135deg, #0b47c8, #07399e);
          color: #fff;
        }
        .comparison-plan-card.is-selected .choose-plan-button:hover {
          background: linear-gradient(135deg, #083ca9, #062f83);
        }
        .comparison-empty {
          padding: 1.25rem;
          border: 1px solid #bdc9da;
          border-radius: .7rem;
          background: #fff;
          color: #41506a;
        }
        .comparison-page .advisor-attention,
        .comparison-page .plan-notes {
          margin: 0 0 1rem;
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
        .comparison-page .advisor-attention-item + .advisor-attention-item {
          margin-top: .5rem;
          padding-top: .5rem;
          border-top: 1px solid #e4c679;
        }
        .comparison-page .advisor-attention-item p { margin: .25rem 0 0; }
        .comparison-page .planning-gaps {
          margin-top: 1rem;
          border-color: #d17a65;
          background: #fff2ed;
        }
        .comparison-page .plan-notes ul {
          margin: .45rem 0 0;
          padding-left: 1.1rem;
        }
        @media (max-width: 760px) {
          .comparison-grid { grid-template-columns: 1fr; }
          .comparison-plan-summary { min-height: 0; }
        }
        @media (max-width: 700px) {
          .comparison-topbar {
            align-items: flex-start;
            flex-wrap: wrap;
            padding: .8rem 1rem;
          }
          .comparison-student {
            width: 100%;
            order: 3;
            margin: 0;
          }
          .edit-courses-button { margin-left: auto; }
          .comparison-content { width: min(100% - 1.25rem, 1460px); }
          .comparison-heading-row {
            align-items: flex-start;
            flex-direction: column;
          }
          .compact-schedule { font-size: 10px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .comparison-page,
          .comparison-page.is-exiting { animation: none; }
        }
      `}</style>

      <header className="comparison-topbar">
        <div className="comparison-brand">EconPlanner</div>
        <div className="comparison-student">
          <strong>{standing}</strong>
          <span aria-hidden="true">·</span>
          <span>Graduation target: {graduationTarget}</span>
        </div>
        <button type="button" className="edit-courses-button" onClick={onEditCourses}>
          Edit completed courses
        </button>
      </header>

      <div className="comparison-content">
        <button type="button" className="comparison-back" onClick={onEditCourses}>
          ← Back to course selection
        </button>
        <section className="comparison-course-status" aria-label="Selected course status">
          <p><strong>Completed:</strong> {completedCodes.join(", ") || "None"}</p>
          <p><strong>In Progress:</strong> {inProgressCodes.join(", ") || "None"}</p>
        </section>
        <div className="comparison-heading-row">
          <div>
            <h1>Compare your plans</h1>
            <p>Same degree requirements and graduation target, different pacing.</p>
          </div>
          {plans.length > 1 && (
            <label className="difference-toggle">
              <span>Show differences only</span>
              <input
                type="checkbox"
                checked={showDifferencesOnly}
                onChange={event => setShowDifferencesOnly(event.target.checked)}
              />
            </label>
          )}
        </div>

        <AdvisorAttention catalog={report?.catalog} />

        {plans.length > 0 ? (
          <div className="comparison-grid">
            {plans.map(plan => {
              const rows = rowsByPlan.get(plan.id) || [];
              const visibleRows = showDifferencesOnly
                ? rows.filter(row => !identicalRowKeys.has(row.key))
                : rows;
              const selected = selectedPlanId === plan.id;
              return (
                <article className={`comparison-plan-card${selected ? " is-selected" : ""}`} key={plan.id}>
                  <div className="comparison-plan-summary">
                    <div className="plan-title-row">
                      <h2>{plan.label}</h2>
                      <span className="plan-strategy-badge">{planBadges[plan.id] || "Validated"}</span>
                    </div>
                    <p>{plan.description}</p>
                  </div>

                  {visibleRows.length > 0 ? (
                    <table className="compact-schedule">
                      <thead>
                        <tr>
                          <th>Year</th>
                          <th>Term</th>
                          <th>Courses</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRows.map(row => (
                          <tr key={`${plan.id}-${row.key}`}>
                            {row.yearRowSpan && <td rowSpan={row.yearRowSpan}>{row.academicYear}</td>}
                            <td>{row.term}</td>
                            <td>{row.courses.join(", ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="no-differences">No schedule differences in this plan.</p>
                  )}

                  <p className="plan-validation">Validated against all 12 requirement slots</p>
                  <button
                    type="button"
                    className="choose-plan-button"
                    aria-pressed={selected}
                    onClick={() => setSelectedPlanId(plan.id)}
                  >
                    {selected ? `${plan.label} selected` : `Choose ${plan.label}`}
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="comparison-empty">
            No validated plan can be displayed for this profile.
          </div>
        )}

        <PlanningGaps items={planningGaps} />
      </div>
    </main>
  );
}

function PlannerSummary({ report, courses, planningContext: initialPlanningContext }) {
  const result = economicsResult(report);
  const plan = result?.economicsPlans?.[0] || result?.economicsPlan;
  const planningContext = result?.planningContext || initialPlanningContext;
  const chosen = selectedCourses(courses);
  const completedCount = chosen.filter(course => isTaken(course)).length;
  const inProgressCount = chosen.filter(course => course.status === "in_progress").length;
  const remainingUnits = result?.projectedAfterInProgress?.optimistic?.remainingUnits
    ?? result?.optimistic?.remainingUnits;
  const catalog = report?.catalog;

  return (
    <aside className="summary-card">
      <div className="section-heading">
        <div>
          <h2>{report ? "Planner Summary" : "Plan setup"}</h2>
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
          {planningContext?.expectedGraduationTerm && (
            <p className="summary-footnote">{planningContext.effectiveStandingLabel || planningContext.standingLabel} plan, {planningContext.remainingYears} years remaining; expected graduation {planningContext.expectedGraduationTerm}.</p>
          )}
          <p className="summary-footnote">Applied catalog: {formatAcademicYear(catalog?.selectedCatalogYear)}. The plan uses the selected course status and verified economics scheduling rules.</p>
        </>
      ) : (
        <>
          <div className="apple-summary-preview">
            <div className="apple-summary-line"><span>Class standing</span><strong>{planningContext?.standingLabel || "Choose standing"}</strong></div>
            <div className="apple-summary-line"><span>Planning horizon</span><strong>{planningContext?.remainingYears ? `${planningContext.remainingYears} years` : "To be confirmed"}</strong></div>
            <div className="apple-summary-line"><span>Completed</span><strong>{completedCount}</strong></div>
            <div className="apple-summary-line"><span>In progress</span><strong>{inProgressCount}</strong></div>
            <div className="apple-summary-courses" aria-label="Selected courses">
              <div className="apple-summary-courses-heading"><span>Selected courses</span><strong>{chosen.length}</strong></div>
              {chosen.length ? (
                <ul>
                  {chosen.map(course => (
                    <li key={course.code}>
                      <strong>{course.code}</strong>
                      <span>{isTaken(course) ? "Completed" : "In progress"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="apple-summary-no-courses">None selected</p>
              )}
            </div>
            <p>The plan will use the published 2026/2027 schedule where available and mark later terms for confirmation.</p>
          </div>
          <div className="summary-empty">Select your courses, then choose <strong>Generate My Plan</strong>.</div>
        </>
      )}
    </aside>
  );
}

export default function Page() {
  const [appleLayoutPreview, setAppleLayoutPreview] = useState(true);
  const [formData, setFormData] = useState(initialForm);
  const [requirementModes, setRequirementModes] = useState({});
  const [requirementScrollTarget, setRequirementScrollTarget] = useState("");
  const [requirementPopoverPosition, setRequirementPopoverPosition] = useState(null);
  const [pendingPrerequisiteSelection, setPendingPrerequisiteSelection] = useState(null);
  const requirementCardRefs = useRef({});
  const courseAccordionRefs = useRef({});
  const generatedInputSignatureRef = useRef("");
  const [courseSearch, setCourseSearch] = useState("");
  const [isEditingPlanDate, setIsEditingPlanDate] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState(null);
  const [isComparisonExiting, setIsComparisonExiting] = useState(false);
  const planningContext = resolvePlanningContext(formData);
  const inputPrerequisiteValidation = validateStudentPrerequisites(formData.courses, COURSE_PREREQUISITES);
  const summerStandingSelection = planningContext.isSummer && ["yes", "no"].includes(formData.summerStandingConfirmed)
    ? formData.summerStandingConfirmed === "yes"
      ? `${planningContext.standingLabel} in Fall ${planningContext.startYear}`
      : `${planningContext.standingLabel} during ${planningContext.startYear - 1}\u2013${String(planningContext.startYear).slice(-2)} academic year`
    : "";

  useEffect(() => {
    setAppleLayoutPreview(new URLSearchParams(window.location.search).get("layout") !== "classic");
  }, []);

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
            courses: migrateSavedCourses(savedFormData.courses),
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
        schemaVersion: PLANNER_STORAGE_VERSION,
        formData,
        requirementModes,
        courseSearch
      }));
    } catch {
      // Local storage may be unavailable in restricted browser sessions.
    }
  }, [courseSearch, formData, isHydrated, requirementModes]);

  useEffect(() => {
    if (!report || !generatedInputSignatureRef.current) return;
    if (plannerInputSignature(formData) === generatedInputSignatureRef.current) return;
    generatedInputSignatureRef.current = "";
    setReport(null);
    setStatus("");
  }, [formData, report]);

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
    setPendingPrerequisiteSelection(current => current?.groupId === groupId ? null : current);
  }

  useEffect(() => {
    if (!Object.values(requirementModes).some(Boolean) && !pendingPrerequisiteSelection) return undefined;

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
      setPendingPrerequisiteSelection(null);
    }

    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [pendingPrerequisiteSelection, requirementModes]);

  function applyCourseChanges(changes) {
    let nextCourses = formData.courses.map(course => ({ ...course }));
    const clearedDependents = new Set();

    for (const [code, nextStatus] of changes) {
      nextCourses = nextCourses.map(course => course.code === code
        ? { ...course, status: nextStatus }
        : course);
      const result = clearInvalidDependents(nextCourses, code);
      nextCourses = result.courses;
      result.clearedCodes.forEach(item => clearedDependents.add(item));
    }

    setFormData(current => ({ ...current, courses: nextCourses }));
    if (clearedDependents.size) {
      setStatus(`${[...clearedDependents].join(", ")} was cleared because a required prerequisite is no longer satisfied.`);
    }
  }

  function setPopoverPosition(group, event) {
    if (!event?.currentTarget) return;
    const row = event.currentTarget.closest(".course-row");
    const rowRect = row?.getBoundingClientRect();
    const buttonRect = event.currentTarget.getBoundingClientRect();
    if (!rowRect) return;
    setRequirementPopoverPosition({
      groupId: group.id,
      left: buttonRect.left - rowRect.left,
      top: buttonRect.bottom - rowRect.top + 6
    });
  }

  function beginCourseSelection(group, code, targetStatus, event) {
    const course = formData.courses.find(item => item.code === code);
    const alreadySelected = targetStatus === "completed"
      ? isTaken(course || {})
      : course?.status === targetStatus;
    if (alreadySelected) {
      applyCourseChanges([[code, "not_started"]]);
      if (!group.options) closeRequirementPopover(group.id);
      return;
    }

    if (COURSE_PREREQUISITES[code]) {
      const prerequisiteValidation = validateCoursePrerequisites({
        course: code,
        targetStatus,
        courses: formData.courses,
        prerequisites: COURSE_PREREQUISITES
      });
      if (prerequisiteValidation.valid && !prerequisiteValidation.conditionalApprovals.length) {
        applyCourseChanges([[code, targetStatus]]);
        return;
      }
      setPendingPrerequisiteSelection({
        groupId: group.id,
        courseCode: code,
        targetStatus
      });
      setRequirementScrollTarget(group.id);
      if (event) setPopoverPosition(group, event);
      return;
    }

    applyCourseChanges([[code, targetStatus]]);
  }

  function toggleCourseGroup(group, nextStatus, event) {
    if (group.courseCodes.some(code => NON_SELECTABLE_COURSE_CODES.has(code))) return;

    if (group.options) {
      const selectedCodes = group.courseCodes.filter(code => {
        const course = formData.courses.find(item => item.code === code);
        return nextStatus === "completed" ? isTaken(course || {}) : course?.status === nextStatus;
      });
      if (selectedCodes.length) {
        applyCourseChanges(selectedCodes.map(code => [code, "not_started"]));
        closeRequirementPopover(group.id);
        return;
      }

      setRequirementModes(current => ({ ...current, [group.id]: nextStatus }));
      setPendingPrerequisiteSelection(null);
      setRequirementScrollTarget(group.id);
      setPopoverPosition(group, event);
      return;
    }

    beginCourseSelection(group, group.courseCodes[0], nextStatus, event);
  }

  function toggleGroupOption(group, code) {
    const mode = requirementModes[group.id];
    if (!mode) return;
    beginCourseSelection(group, code, mode);
  }

  function setPrerequisiteStatus(code, nextStatus) {
    applyCourseChanges([[code, nextStatus]]);
  }

  function confirmPrerequisiteSelection(validation) {
    if (!pendingPrerequisiteSelection || !validation.valid) return;
    const { groupId, courseCode, targetStatus } = pendingPrerequisiteSelection;
    applyCourseChanges([[courseCode, targetStatus]]);
    if (validation.conditionalApprovals.length) {
      setStatus(validation.conditionalApprovals[0].message);
    }
    closeRequirementPopover(groupId);
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

    if (!inputPrerequisiteValidation.valid) {
      setStatus("Correct the highlighted prerequisite issues before generating a plan.");
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
      generatedInputSignatureRef.current = plannerInputSignature(formData);
      setIsComparisonExiting(false);
      setReport(data);
      setStatus("");
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      });
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
  const declarationRightCourseGroups = visibleGroups.filter(group => DECLARATION_RIGHT_COURSE_IDS.includes(group.id));
  const declarationGroups = [...declarationCourseGroups, ...declarationRequirementGroups, ...declarationRightCourseGroups];
  const remainingGroups = visibleGroups.filter(group => !DECLARATION_GROUP_IDS.has(group.id));
  const sortCourseGroups = groups => [...groups].sort((a, b) => courseLevel(a.code) - courseLevel(b.code) || a.code.localeCompare(b.code));
  const relativelyFrequentGroups = sortCourseGroups(remainingGroups.filter(group =>
    (courseLevel(group.code) >= 200 && courseLevel(group.code) < 300) || RELATIVELY_FREQUENT_COURSE_IDS.has(group.id)
  ));
  const advancedGroups = sortCourseGroups(remainingGroups.filter(group =>
    courseLevel(group.code) >= 300 && !RELATIVELY_FREQUENT_COURSE_IDS.has(group.id)
  ));
  const appleAdvancedGroups = appleLayoutPreview
    ? sortCourseGroups([...advancedGroups, ...declarationRightCourseGroups])
    : advancedGroups;

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

  function prerequisitePopoverStyle(groupId) {
    return requirementPopoverPosition?.groupId === groupId ? {
      left: `${requirementPopoverPosition.left}px`,
      top: `${requirementPopoverPosition.top}px`
    } : undefined;
  }

  function renderPrerequisiteChoiceCard(group) {
    const pending = pendingPrerequisiteSelection;
    if (!pending || pending.groupId !== group.id) return null;
    const rule = COURSE_PREREQUISITES[pending.courseCode];
    const validation = validateCoursePrerequisites({
      course: pending.courseCode,
      targetStatus: pending.targetStatus,
      courses: formData.courses,
      prerequisites: COURSE_PREREQUISITES
    });
    const requirementSections = [
      ...(rule.all || []).map(code => ({ label: "Required course", options: [code] })),
      ...(rule.any || []).map(options => ({ label: "Choose one or more", options }))
    ];
    const targetStatusLabel = pending.targetStatus === "completed" ? "Taken" : "In Progress";

    return (
      <div
        className="requirement-choice-card prerequisite-choice-card"
        style={prerequisitePopoverStyle(group.id)}
        ref={node => {
          requirementCardRefs.current[group.id] = node;
        }}
      >
        <strong>Confirm prerequisites for {pending.courseCode}</strong>
        <p className="prerequisite-help">Set each prerequisite status, then confirm {targetStatusLabel.toLowerCase()}.</p>
        <div className="prerequisite-sections">
          {requirementSections.map((section, sectionIndex) => (
            <section className="prerequisite-section" key={`${section.label}-${sectionIndex}`}>
              <span className="prerequisite-section-label">{section.label}</span>
              {section.options.map(code => {
                const statusValue = selectedStatus(formData.courses, code);
                return (
                  <div className="prerequisite-option" key={code}>
                    <div className="prerequisite-name">
                      <strong>{code}</strong>
                      <small>{courseTitle(code)}</small>
                    </div>
                    <div className="prerequisite-statuses" role="group" aria-label={`Status for prerequisite ${code}`}>
                      {[
                        ["completed", "Taken"],
                        ["in_progress", "In Progress"],
                        ["not_started", "Not taken"]
                      ].map(([value, label]) => (
                        <button
                          type="button"
                          className={`prerequisite-status is-${value}${statusValue === value ? " is-selected" : ""}`}
                          aria-pressed={statusValue === value}
                          key={value}
                          onClick={() => setPrerequisiteStatus(code, value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
        {!validation.valid && (
          <ul className="prerequisite-issues">
            {validation.issues.map(issue => <li key={`${issue.code}-${issue.course}-${issue.message}`}>{issue.message}</li>)}
          </ul>
        )}
        {validation.conditionalApprovals.map(item => (
          <p className="prerequisite-approval" key={`${item.course}-${item.prerequisite}`}>{item.message}</p>
        ))}
        <div className="prerequisite-actions">
          <button type="button" className="prerequisite-cancel" onClick={() => closeRequirementPopover(group.id)}>
            Cancel
          </button>
          <button
            type="button"
            className="prerequisite-confirm"
            disabled={!validation.valid}
            onClick={() => confirmPrerequisiteSelection(validation)}
          >
            Confirm {targetStatusLabel}
          </button>
        </div>
      </div>
    );
  }

  function renderCourseGroup(group) {
    const groupCourses = formData.courses.filter(course => group.courseCodes.includes(course.code));
    const requirementMode = requirementModes[group.id] || "";
    const hasPendingPrerequisite = pendingPrerequisiteSelection?.groupId === group.id;
    const taken = groupCourses.some(isTaken);
    const inProgress = groupCourses.some(course => course.status === "in_progress");
    const isHanoverOnly = group.courseCodes.some(code => NON_SELECTABLE_COURSE_CODES.has(code));
    const allowsApCredit = group.courseCodes.some(code => AP_CREDIT_ALLOWED_COURSE_CODES.has(code));
    const takenButtonLabel = allowsApCredit ? "Taken or AP credit" : "Taken";
    return (
      <div
        className={`course-row${(group.options && requirementMode) || hasPendingPrerequisite ? " has-requirement" : ""}`}
        key={group.id}
        onMouseLeave={() => {
          if (group.options && requirementMode) closeRequirementPopover(group.id);
        }}
      >
        <div className="course-name">
          <strong>{group.code}</strong>
          <span>{group.title}</span>
        </div>
        {isHanoverOnly ? (
          <span className="course-status-note">Must be taken at Hanover College</span>
        ) : (
          <div className="course-toggles" role="group" aria-label={`Status for ${group.code}`}>
            <button
              type="button"
              className={`course-toggle taken-toggle${taken ? " is-selected" : ""}`}
              aria-pressed={taken}
              onClick={event => toggleCourseGroup(group, "completed", event)}
            >
              <span className="default-course-label">{takenButtonLabel}</span>
              <span className="apple-course-label">Completed</span>
            </button>
            <button
              type="button"
              className={`course-toggle progress-toggle${inProgress ? " is-selected" : ""}`}
              aria-pressed={inProgress}
              onClick={event => toggleCourseGroup(group, "in_progress", event)}
            >
              <span className="default-course-label">In Progress</span>
              <span className="apple-course-label">In progress</span>
            </button>
          </div>
        )}
        {hasPendingPrerequisite && renderPrerequisiteChoiceCard(group)}
        {group.options && requirementMode && !hasPendingPrerequisite && (
          <div
            className="requirement-choice-card"
            style={prerequisitePopoverStyle(group.id)}
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

  function returnToCourseSelection() {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const finish = () => {
      generatedInputSignatureRef.current = "";
      setReport(null);
      setStatus("");
      setIsComparisonExiting(false);
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      });
    };

    if (reducedMotion) {
      finish();
      return;
    }
    setIsComparisonExiting(true);
    window.setTimeout(finish, 240);
  }

  if (report) {
    return (
      <PlanComparisonScreen
        report={report}
        courses={formData.courses}
        isExiting={isComparisonExiting}
        onEditCourses={returnToCourseSelection}
      />
    );
  }

  return (
    <main className={`container${appleLayoutPreview ? " apple-layout-preview" : ""}`}>
      <style jsx global>{`
        :root {
          --planner-bg: #7c3aed;
          --planner-panel: #ffffff;
          --planner-border: #a9b0b5;
          --planner-strong-border: #202427;
          --planner-muted: #5c656b;
          --planner-green: #bde9c9;
          --planner-dark-green: #006400;
          --planner-generate-bg: #fff1b8;
          --planner-generate-bg-hover: #ffe58a;
          --planner-purple: #850085;
          --planner-dropdown-bg: #fff;
          --planner-blue: #cfe9fb;
          --planner-blue-border: #8dbddb;
          --planner-font-family: Arial, sans-serif;
          --planner-body-size: 11px;
          --planner-heading-size: 14px;
          --planner-page-title-size: 43.2px;
          --planner-intro-title-size: 20px;
          --planner-intro-text-size: 18px;
          --planner-action-size: var(--planner-intro-text-size);
          --urveska-orange: #ff9d5c;
          --urveska-gold: #ffd166;
          --urveska-aqua: #8ef7d3;
          --urveska-lead-orange: #c94b00;
          --urveska-lead-gold: #c46a00;
          --urveska-lead-aqua: #006f8f;
        }
        .apple-brand,
        .apple-progress,
        .apple-heading-row,
        .apple-planning-heading,
        .apple-standing-segmented,
        .apple-mini-fields,
        .apple-course-heading,
        .apple-course-toolbar,
        .apple-course-label,
        .apple-generate-label,
        .apple-summary-preview { display: none; }
        body { font-family: var(--planner-font-family); font-size: var(--planner-body-size); }
        button, input, select, textarea { font-family: var(--planner-font-family); font-size: var(--planner-body-size); font-weight: inherit; }
        body { background: var(--planner-bg); color: #171a1c; }
        h1, h2, h3, h4, h5, h6 { color: #1d4ed8; font-family: inherit; font-size: var(--planner-heading-size); font-weight: 700; }
        main.container { max-width: 1240px; padding: 1.25rem 1rem 4rem; }
        .summary-card, .plan-section { border: 1px solid var(--planner-strong-border); background: var(--planner-panel); }
        .intake-card { border: 1px solid var(--planner-strong-border); background: #f1faff; }
        .generate-card { border: 1px solid var(--planner-strong-border); background: #f1faff; padding: 1.1rem; }
        .instruction-card { margin-bottom: 1rem; padding: 1.1rem; border: 1px solid var(--planner-strong-border); background: #f1faff; font-size: var(--planner-intro-text-size); }
        .instruction-card h2 { font-size: var(--planner-intro-title-size); }
        .instruction-card p { font-size: inherit; }
        .instruction-card .instruction-lead { margin: .85rem 0 0; font-size: var(--planner-intro-title-size); font-weight: 700; }
        .instruction-lead .lead-aqua { color: var(--urveska-lead-aqua); }
        .instruction-lead .lead-gold { color: var(--urveska-lead-gold); }
        .instruction-lead .lead-orange { color: var(--urveska-lead-orange); }
        .instruction-card h2 { margin: 0; }
        .app-header { display: flex; align-items: center; justify-content: center; text-align: center; gap: 1rem; padding: .85rem 1.1rem; margin-bottom: 1rem; }
        .app-header h1 { margin: 0; color: #06182e; font-size: var(--planner-page-title-size); line-height: 1.05; }
        .app-header h1 .headline-econ { color: var(--urveska-aqua); }
        .app-header h1 .headline-planner { color: var(--urveska-orange); }
        .intake-layout { display: grid; gap: 1rem; grid-template-columns: 1fr; align-items: start; }
        .apple-left-column, .apple-right-column { display: contents; }
        .intake-card, .summary-card, .plan-section { padding: 1.1rem; }
        .section-heading { display: flex; gap: .65rem; align-items: flex-start; }
        .section-heading h2 { margin: 0; }
        .course-heading h2 { color: var(--planner-purple); font-size: var(--planner-intro-text-size); }
        .section-heading p { margin: .2rem 0 0; color: var(--planner-muted); font-size: 12px; }
        .step-number { font-weight: 700; line-height: 1.1; }
        .planning-details .section-heading h2 { color: var(--urveska-lead-orange); font-size: var(--planner-intro-text-size); }
        .planning-details { margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--planner-border); }
        .planning-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; margin-top: .85rem; max-width: 38rem; }
        .planning-field { display: grid; gap: .25rem; }
        .planning-field label, .planning-label { color: var(--planner-muted); }
        .planning-field input, .planning-field select { width: 100%; box-sizing: border-box; }
        .summer-standing-selection { display: flex; align-items: center; gap: .35rem; margin-top: .35rem; color: var(--planner-muted); }
        .summer-standing-selection strong { color: #171a1c; font-weight: 700; }
        button.summer-standing-change { width: auto; min-height: 0 !important; margin: 0; padding: 0 .3rem; border: 0; background: transparent; color: #1d4ed8; font-family: var(--planner-font-family); font-size: var(--planner-body-size); text-decoration: underline; }
        button.summer-standing-change:hover { color: #163ea9; }
        .date-display { display: flex; align-items: baseline; gap: .4rem; min-height: 1.5rem; }
        .date-display strong { font-weight: 400; }
        button.date-edit-button { width: auto; min-height: 0 !important; margin: 0 0 0 .25rem; padding: 0 .3rem; border: 0; background: transparent; color: #1d4ed8; font-family: var(--planner-font-family); font-size: var(--planner-body-size); text-decoration: underline; }
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
        .course-status-note { color: var(--planner-dark-green); font-weight: 700; white-space: nowrap; }
        button.course-toggle { width: auto; min-height: 0 !important; height: auto; margin: 0; padding: 0 .35rem; border: 1px solid var(--planner-border); border-radius: .35rem; background: #fff; color: #171a1c; font-family: var(--planner-font-family); font-size: var(--planner-body-size); line-height: 1.25; white-space: nowrap; }
        button.course-toggle:hover { border-color: var(--planner-strong-border); }
        button.taken-toggle.is-selected { background: var(--planner-green); border-color: #6db784; }
        button.progress-toggle.is-selected { background: var(--planner-blue); border-color: var(--planner-blue-border); }
        .course-accordion { margin-top: .85rem; border-top: 1px solid var(--planner-border); padding-top: .75rem; }
        .course-accordion summary { display: flex; align-items: center; gap: .5rem; cursor: pointer; list-style: none; color: #171a1c; font-weight: 700; }
        .course-accordion summary::-webkit-details-marker { display: none; }
        .course-accordion summary::before { content: "▶"; color: #ff7a00; font-size: 14px; line-height: 1; }
        .course-accordion[open] summary::before { content: "▼"; }
        .course-accordion-title { color: #171a1c; }
        .course-accordion-count { margin-left: auto; color: var(--planner-muted); font-weight: 400; }
        .course-accordion .course-columns { margin-top: .7rem; }
        .requirement-choice-card { position: absolute; z-index: 30; top: calc(100% + .35rem); left: 0; width: max-content; max-width: calc(100vw - 2rem); scroll-margin: 1rem; padding: .35rem; border: 1px solid #cfd3d5; border-radius: .9rem; background: var(--planner-dropdown-bg); box-shadow: 0 .5rem 1.4rem rgba(32, 36, 39, .14); }
        .requirement-choice-card > strong { display: block; padding: .4rem .55rem .3rem; color: var(--planner-muted); font-weight: 400; }
        .choice-options { display: grid; gap: .1rem; width: max-content; min-width: 100%; margin: 0; }
        .choice-option { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; width: max-content; min-width: 100%; box-sizing: border-box; gap: .8rem; padding: .55rem .8rem .55rem .6rem; border: 0; border-radius: .65rem; background: var(--planner-dropdown-bg); cursor: pointer; white-space: nowrap; }
        .choice-option.is-selected { background: #f3fff5; }
        .choice-option:hover { background: #f4f5f6; }
        .choice-option input { position: absolute; opacity: 0; pointer-events: none; }
        .choice-radio { display: none; }
        .choice-label { display: grid; gap: .1rem; min-width: 0; }
        .choice-check { width: 1rem; color: #2f8f4e; font-size: 15px; font-weight: 700; line-height: 1; text-align: center; }
        .choice-option small { color: var(--planner-muted); }
        .prerequisite-choice-card { width: min(34rem, calc(100vw - 2rem)); padding: .55rem; }
        .prerequisite-help { margin: 0; padding: 0 .55rem .45rem; color: var(--planner-muted); }
        .prerequisite-sections { display: grid; gap: .45rem; }
        .prerequisite-section { display: grid; gap: .35rem; padding: .45rem .55rem; border-top: 1px solid #d9dddf; }
        .prerequisite-section-label { color: var(--planner-muted); font-weight: 700; }
        .prerequisite-option { display: grid; grid-template-columns: minmax(9rem, 1fr) auto; gap: .65rem; align-items: center; }
        .prerequisite-name { display: grid; gap: .1rem; }
        .prerequisite-name small { color: var(--planner-muted); }
        .prerequisite-statuses { display: flex; gap: .25rem; }
        button.prerequisite-status,
        button.prerequisite-cancel,
        button.prerequisite-confirm {
          width: auto;
          min-height: 0 !important;
          margin: 0;
          padding: .3rem .45rem;
          border: 1px solid var(--planner-border);
          border-radius: .35rem;
          background: #fff;
          color: #171a1c;
        }
        button.prerequisite-status.is-completed.is-selected { border-color: #6db784; background: var(--planner-green); }
        button.prerequisite-status.is-in_progress.is-selected { border-color: var(--planner-blue-border); background: var(--planner-blue); }
        button.prerequisite-status.is-not_started.is-selected { border-color: #9da4a8; background: #eceff1; }
        .prerequisite-issues { margin: .45rem .55rem; padding-left: 1.1rem; color: #9b2f1f; }
        .prerequisite-approval { margin: .45rem .55rem; padding: .45rem; border: 1px solid #d5a233; background: #fff9e8; color: #704600; }
        .prerequisite-actions { display: flex; justify-content: flex-end; gap: .35rem; padding: .45rem .55rem .1rem; }
        button.prerequisite-confirm { border-color: #5a9a6e; background: #d9f4e1; color: #064f20; font-weight: 700; }
        button.prerequisite-confirm:disabled { cursor: not-allowed; opacity: .5; }
        .prerequisite-error-summary { margin: .8rem 0 0; padding: .65rem .75rem; border: 1px solid #bd6a5d; background: #fff3ef; color: #7e281c; }
        .prerequisite-error-summary strong { display: block; margin-bottom: .25rem; }
        .prerequisite-error-summary ul { margin: 0; padding-left: 1.1rem; }
        .generate-row { margin-top: 1rem; display: flex; justify-content: flex-end; }
        .generate-button { width: auto; margin: 0; border: 1px solid #73b98a; background: var(--planner-generate-bg); color: var(--planner-dark-green); font-family: var(--planner-font-family); font-size: var(--planner-intro-text-size); font-weight: 700; }
        .generate-button:hover { background: var(--planner-generate-bg-hover); }
        .generate-button:disabled { cursor: not-allowed; opacity: .6; }
        .summary-card { min-height: 100%; margin-bottom: 1rem; }
        .planner-instructions { margin: .85rem 0 0; padding-left: 3ch; font-size: inherit; font-weight: 700; }
        .planner-instructions p { margin: .25rem 0; font-size: inherit; font-weight: 700; }
        .planner-instructions p:first-child { color: var(--urveska-lead-orange); }
        .planner-instructions p:nth-child(2) { color: var(--planner-purple); }
        .planner-instructions p:nth-child(3) { color: var(--planner-dark-green); font-size: var(--planner-action-size); }
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
        button.plan-tab { width: auto; min-height: 0 !important; margin: 0; padding: .35rem .75rem; border: 1px solid var(--planner-border); border-bottom: 0; background: #fff; color: #171a1c; font-family: var(--planner-font-family); font-size: var(--planner-body-size); font-weight: 700; }
        button.plan-tab.is-active { background: var(--planner-blue); border-color: var(--planner-blue-border); }
        .academic-year-group { margin-top: 1rem; }
        .academic-year-label { margin: 0 0 .55rem; color: #1d4ed8; font-size: var(--planner-heading-size); font-weight: 700; }
        .plan-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .8rem; }
        .term-card { border: 1px solid var(--planner-border); padding: .8rem; min-height: 8rem; }
        .term-card h4 { margin: 0 0 .65rem; color: #1d4ed8; font-size: var(--planner-heading-size); font-weight: 700; }
        .term-card ul { display: grid; gap: .45rem; list-style: none; margin: 0; padding: 0; }
        .term-card li { border: 1px solid #d1d6d9; padding: .45rem; }
        .term-card li strong, .term-card li span { display: block; }
        .term-card li span { color: var(--planner-muted); margin-top: .1rem; }
        .term-card.is-placeholder { border-style: dashed; background: #f7fbff; }
        .placeholder-term-note { margin: .65rem 0 0; color: var(--planner-muted); }
        .empty-term { margin: 0; color: var(--planner-muted); }
        .summer-term-note { margin: .65rem 0 0; color: #2f8f4e; font-weight: 700; }
        .plan-notes { margin-top: 1rem; padding: .75rem; border: 1px solid #d5b36a; background: #fff9e8; }
        .plan-notes ul { margin: .45rem 0 0; padding-left: 1.25rem; }
        .planning-gaps { border-color: #bd6a5d; background: #fff3ef; }
        .advisor-attention { margin-top: 1rem; padding: 1rem; border: 2px solid #d5a233; background: #fff9e8; }
        .advisor-attention h2 { margin: 0 0 .65rem; }
        .advisor-attention-item + .advisor-attention-item { margin-top: .75rem; padding-top: .75rem; border-top: 1px solid #d5b36a; }
        .advisor-attention-item strong { color: #1d4ed8; }
        .advisor-attention-item p { margin: .35rem 0 0; }
        .advisor-attention-item ul { margin: .45rem 0 0; padding-left: 1.25rem; }
        .advisor-attention-item.is-info { border-left: 3px solid #2f8f4e; padding-left: .65rem; }
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
          .prerequisite-choice-card { width: auto; }
          .prerequisite-option { grid-template-columns: 1fr; }
          .prerequisite-statuses { flex-wrap: wrap; }
          .generate-row { justify-content: stretch; }
          .generate-button { width: 100%; }
          .plan-grid { grid-template-columns: 1fr; }
        }
        main.apple-layout-preview {
          max-width: 1580px;
          padding: 0 .5rem 2rem;
          color: #101010;
        }
        html:has(main.apple-layout-preview) { font-size: 16px; }
        body:has(main.apple-layout-preview) {
          background: #fff;
          color: #101010;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        main.apple-layout-preview .app-header {
          min-height: 3.1rem;
          margin: 0 0 1rem;
          padding: .55rem 0;
          border-bottom: 1px solid #eef0f2;
          background: #fff;
          color: #101010;
        }
        main.apple-layout-preview .app-title { display: none; }
        main.apple-layout-preview .apple-brand,
        main.apple-layout-preview .apple-progress { display: flex; }
        main.apple-layout-preview .apple-brand {
          align-items: center;
          gap: .45rem;
          color: #111;
          font-size: 12px;
          font-weight: 500;
        }
        main.apple-layout-preview .apple-brand-mark {
          display: grid;
          width: 1.55rem;
          height: 1.55rem;
          place-items: center;
          border-radius: 50%;
          background: #3699ef;
          color: #fff;
          font-size: 11px;
        }
        main.apple-layout-preview .apple-progress {
          align-items: center;
          gap: .9rem;
          color: #b4b4b8;
          font-size: 11px;
        }
        main.apple-layout-preview .apple-progress-step {
          display: inline-flex;
          align-items: center;
          gap: .3rem;
        }
        main.apple-layout-preview .apple-progress-step span {
          width: .42rem;
          height: .42rem;
          border-radius: 50%;
          background: #e1e2e5;
        }
        main.apple-layout-preview .apple-progress-step.is-current { color: #111; }
        main.apple-layout-preview .apple-progress-step.is-current span { background: #3699ef; }
        main.apple-layout-preview .apple-heading-row {
          display: flex;
          align-items: end;
          justify-content: space-between;
          gap: 1rem;
          margin: 0 0 .6rem;
        }
        main.apple-layout-preview .apple-heading-row h2 {
          margin: 0;
          color: #101010;
          font-size: 16px;
          line-height: 1.2;
        }
        main.apple-layout-preview .apple-heading-row p {
          margin: .3rem 0 0;
          color: #7e8791;
          font-size: 11px;
        }
        main.apple-layout-preview .apple-help-button {
          width: auto;
          min-height: 0 !important;
          margin: 0;
          padding: .2rem 0;
          border: 0;
          background: transparent;
          color: #7e8791;
          font-size: 11px;
        }
        main.apple-layout-preview .apple-help-button span { margin-left: .2rem; }
        main.apple-layout-preview .app-header {
          justify-content: space-between;
          text-align: left;
        }
        main.apple-layout-preview .instruction-card { display: none; }
        main.apple-layout-preview .intake-layout {
          grid-template-columns: minmax(0, 1.35fr) minmax(16rem, .65fr);
          gap: 1.25rem;
        }
        main.apple-layout-preview .apple-left-column,
        main.apple-layout-preview .apple-right-column {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          align-content: start;
          gap: .65rem;
          min-width: 0;
        }
        main.apple-layout-preview .apple-left-column { grid-column: 1; grid-row: 1; }
        main.apple-layout-preview .apple-right-column { grid-column: 2; grid-row: 1; }
        main.apple-layout-preview .intake-card {
          border: 0;
          border-radius: .75rem;
          background: #f3f3f4;
          box-shadow: none;
          padding: .55rem .65rem;
        }
        main.apple-layout-preview .planning-intake-card,
        main.apple-layout-preview .course-intake-card {
          margin: 0;
        }
        main.apple-layout-preview .planning-intake-card,
        main.apple-layout-preview .course-intake-card,
        main.apple-layout-preview .summary-card,
        main.apple-layout-preview .generate-card {
          grid-column: 1;
          grid-row: auto;
        }
        main.apple-layout-preview .summary-card {
          grid-column: 2;
          grid-row: 1;
          min-height: 0;
          margin: 0;
          padding: .55rem .65rem;
          border: 0;
          border-radius: .75rem;
          background: #f3f3f4;
          box-shadow: none;
        }
        main.apple-layout-preview .generate-card {
          grid-column: 2;
          grid-row: 2;
          align-self: start;
          margin: 0;
          padding: 0;
          border: 0;
          background: transparent;
        }
        main.apple-layout-preview .planning-details { margin: 0; padding: 0; border: 0; }
        main.apple-layout-preview .planning-details .section-heading,
        main.apple-layout-preview .course-heading { display: none; }
        main.apple-layout-preview .apple-planning-heading { display: block; margin-bottom: .45rem; }
        main.apple-layout-preview .apple-planning-heading h2 {
          margin: 0;
          color: #111;
          font-size: 14px;
          line-height: 1.2;
        }
        main.apple-layout-preview .apple-planning-heading p {
          margin: .25rem 0 0;
          color: #7e8791;
          font-size: 11px;
        }
        main.apple-layout-preview .section-heading h2,
        main.apple-layout-preview .apple-course-heading h2,
        main.apple-layout-preview .summary-card h2 {
          color: #111;
          font-size: 14px;
          line-height: 1.2;
        }
        main.apple-layout-preview .planning-fields { display: none; }
        main.apple-layout-preview .apple-standing-segmented {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: .35rem;
          margin: 0;
        }
        main.apple-layout-preview .apple-standing-segmented button {
          width: 100%;
          min-height: 0 !important;
          margin: 0;
          padding: .1rem .35rem;
          border: 1px solid #d9dadd;
          border-radius: .4rem;
          background: #fff;
          color: #111;
          font-size: 11px;
        }
        main.apple-layout-preview .apple-standing-segmented button.is-selected {
          border-color: #3699ef;
          background: #3699ef;
          color: #fff;
        }
        main.apple-layout-preview .apple-mini-fields {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: .65rem;
          margin-top: .35rem;
        }
        main.apple-layout-preview .apple-mini-fields {
          grid-auto-rows: max-content;
        }
        main.apple-layout-preview .apple-mini-fields label {
          display: grid;
          align-self: start;
          gap: .2rem;
          height: auto;
          margin: 0 !important;
        }
        main.apple-layout-preview .apple-mini-fields label > span {
          color: #333;
          font-size: 10px;
        }
        main.apple-layout-preview .apple-mini-fields input {
          width: 100%;
          height: 1.35rem !important;
          min-height: 0 !important;
          box-sizing: border-box;
          margin: 0 !important;
          padding: .1rem .35rem !important;
          border: 1px solid #d9dadd;
          border-radius: .4rem;
          background: #fff;
          color: #111;
          font-size: 11px;
          line-height: 1.1 !important;
        }
        main.apple-layout-preview .apple-course-heading {
          display: flex;
          align-items: start;
          justify-content: space-between;
          gap: .75rem;
        }
        main.apple-layout-preview .apple-course-heading p {
          margin: .25rem 0 0;
          color: #7e8791;
          font-size: 11px;
        }
        main.apple-layout-preview .apple-course-heading > span {
          flex: 0 0 auto;
          padding-top: .1rem;
          color: #3699ef;
          font-size: 10px;
        }
        main.apple-layout-preview .apple-course-toolbar {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: .65rem;
          align-items: center;
          margin-top: .4rem;
        }
        main.apple-layout-preview .search-label { width: 100%; margin: 0; }
        main.apple-layout-preview .search-label input {
          height: 1.35rem !important;
          min-height: 0 !important;
          padding: .1rem .35rem !important;
          border: 1px solid #d9dadd;
          border-radius: .4rem;
          background: #fff;
          font-size: 11px;
          line-height: 1.1 !important;
        }
        main.apple-layout-preview .apple-course-toolbar .sr-only { display: none; }
        main.apple-layout-preview .apple-clear-button {
          width: auto;
          min-height: 0 !important;
          margin: 0;
          padding: .2rem .45rem;
          border: 1px solid #a9c8ed;
          border-radius: .35rem;
          background: #eaf4ff;
          color: #0b47c8;
          font-size: 10px;
          font-weight: 600;
        }
        main.apple-layout-preview .apple-clear-button:hover {
          border-color: #0b47c8;
          background: #dceeff;
        }
        main.apple-layout-preview .course-columns { display: block; width: 100%; }
        main.apple-layout-preview .course-column { display: block; width: 100%; max-width: none; }
        main.apple-layout-preview .course-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          width: 100%;
          max-width: none;
          padding: .5rem 0;
          border: 0;
          border-bottom: 1px solid #dedee0;
          background: transparent;
        }
        main.apple-layout-preview .course-name { width: auto; gap: .6rem; }
        main.apple-layout-preview .course-name strong { color: #111; font-weight: 500; }
        main.apple-layout-preview .course-name span { color: #7e8791; }
        main.apple-layout-preview .course-toggles { gap: .45rem; }
        main.apple-layout-preview button.course-toggle {
          min-width: 5.4rem;
          padding: .25rem .4rem;
          border-color: #d9dadd;
          border-radius: .45rem;
          font-size: 11px;
        }
        main.apple-layout-preview button.course-toggle.is-selected,
        main.apple-layout-preview button.taken-toggle.is-selected {
          background: #dff4e4;
          border-color: #6db784;
          color: #064f20;
          font-weight: 600;
        }
        main.apple-layout-preview button.course-toggle:focus {
          outline: none;
          box-shadow: none;
        }
        main.apple-layout-preview .default-course-label { display: none; }
        main.apple-layout-preview .apple-course-label { display: inline; }
        main.apple-layout-preview .course-accordion { margin-top: 0; border-color: #dedee0; padding: .45rem 0 0; }
        main.apple-layout-preview .course-accordion summary { font-size: 11px; font-weight: 500; }
        main.apple-layout-preview .course-accordion summary::before { color: #111; font-size: 10px; }
        main.apple-layout-preview .course-accordion-count { display: none; }
        main.apple-layout-preview .apple-summary-preview { display: block; }
        main.apple-layout-preview .summary-card > .section-heading { margin-bottom: .3rem; }
        main.apple-layout-preview .summary-card > .section-heading p { display: none; }
        main.apple-layout-preview .apple-summary-line {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 1rem;
          padding: .45rem 0;
          border-bottom: 1px solid #dedee0;
          font-size: 11px;
        }
        main.apple-layout-preview .apple-summary-line strong { font-weight: 500; }
        main.apple-layout-preview .apple-summary-courses {
          padding: .45rem 0 0;
        }
        main.apple-layout-preview .apple-summary-courses-heading {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 1rem;
          color: #333;
          font-size: 10px;
          font-weight: 600;
        }
        main.apple-layout-preview .apple-summary-courses-heading strong {
          color: #111;
          font-weight: 500;
        }
        main.apple-layout-preview .apple-summary-courses ul {
          display: grid;
          gap: .2rem;
          margin: .3rem 0 0;
          padding: 0;
          list-style: none;
        }
        main.apple-layout-preview .apple-summary-courses li {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: .6rem;
          color: #102a5c;
          font-size: 10px;
        }
        main.apple-layout-preview .apple-summary-courses li span,
        main.apple-layout-preview .apple-summary-no-courses {
          color: #7e8791;
        }
        main.apple-layout-preview .apple-summary-no-courses {
          margin: .3rem 0 0;
          font-size: 10px;
        }
        main.apple-layout-preview .apple-summary-preview > p {
          margin: .45rem 0 0;
          color: #7e8791;
          font-size: 10px;
          line-height: 1.35;
        }
        main.apple-layout-preview .summary-empty { display: none; }
        main.apple-layout-preview .generate-row { margin: .75rem 0 0; }
        main.apple-layout-preview .prerequisite-choice-card {
          width: min(34rem, calc(100vw - 2rem));
          padding: 0;
          border-color: #a9c8ed;
          border-radius: .7rem;
          background: #fff;
          box-shadow: 0 .45rem 1.2rem rgba(20, 44, 92, .12);
          color: #102a5c;
        }
        main.apple-layout-preview .requirement-choice-card {
          left: auto !important;
          right: 0;
        }
        main.apple-layout-preview .prerequisite-choice-card > strong {
          padding: .8rem .9rem .35rem;
          color: #102a5c;
          font-size: var(--planner-body-size);
          font-weight: 700;
        }
        main.apple-layout-preview .prerequisite-help {
          padding: 0 .9rem .65rem;
          color: #53627a;
          font-size: var(--planner-body-size);
        }
        main.apple-layout-preview .prerequisite-sections { gap: 0; }
        main.apple-layout-preview .prerequisite-section {
          gap: .45rem;
          padding: .7rem .9rem;
          border-color: #d7e1ec;
        }
        main.apple-layout-preview .prerequisite-section-label {
          color: #53627a;
          font-size: var(--planner-body-size);
        }
        main.apple-layout-preview .prerequisite-option {
          grid-template-columns: minmax(8rem, 1fr) auto;
          gap: .75rem;
        }
        main.apple-layout-preview .prerequisite-name { gap: .1rem; }
        main.apple-layout-preview .prerequisite-name strong { color: #102a5c; font-size: var(--planner-body-size); }
        main.apple-layout-preview .prerequisite-name small { color: #53627a; font-size: .7rem; }
        main.apple-layout-preview .prerequisite-statuses { gap: .3rem; }
        main.apple-layout-preview button.prerequisite-status,
        main.apple-layout-preview button.prerequisite-cancel,
        main.apple-layout-preview button.prerequisite-confirm {
          min-height: 0 !important;
          padding: .3rem .45rem;
          border-color: #a9c8ed;
          border-radius: .35rem;
          font-size: var(--planner-body-size);
          line-height: 1.25;
        }
        main.apple-layout-preview button.prerequisite-status.is-completed.is-selected { border-color: #6db784; background: #dff4e4; }
        main.apple-layout-preview button.prerequisite-status.is-in_progress.is-selected { border-color: #8bb7e8; background: #e6f1ff; }
        main.apple-layout-preview button.prerequisite-status.is-not_started.is-selected { border-color: #b8c8d8; background: #eef3f8; }
        main.apple-layout-preview .prerequisite-issues { margin: .55rem .9rem; font-size: var(--planner-body-size); }
        main.apple-layout-preview .prerequisite-actions {
          gap: .45rem;
          padding: .7rem .9rem .85rem;
        }
        main.apple-layout-preview button.prerequisite-cancel { color: #102a5c; }
        main.apple-layout-preview button.prerequisite-confirm {
          border-color: #0b47c8;
          background: #0b47c8;
          color: #fff;
        }
        main.apple-layout-preview button.prerequisite-confirm:disabled {
          border-color: #b8c8d8;
          background: #eef3f8;
          color: #7690aa;
        }
        main.apple-layout-preview .generate-card { border: 0; padding: 0; background: transparent; }
        main.apple-layout-preview .generate-button {
          width: 100%;
          border: 0;
          min-height: 0 !important;
          padding: .3rem .5rem;
          border-radius: .35rem;
          background: #1b1c1e;
          color: #fff;
          font-size: 11px;
          line-height: 1.1;
        }
        main.apple-layout-preview .default-generate-label { display: none; }
        main.apple-layout-preview .apple-generate-label { display: inline; }
        @media (max-width: 900px) {
          main.apple-layout-preview .intake-layout { grid-template-columns: 1fr; }
          main.apple-layout-preview .apple-left-column,
          main.apple-layout-preview .apple-right-column {
            grid-column: 1;
            grid-row: auto;
          }
        }
        @media (max-width: 560px) {
          main.apple-layout-preview .apple-progress { gap: .35rem; font-size: 0; }
          main.apple-layout-preview .apple-progress-step span { width: .5rem; height: .5rem; }
          main.apple-layout-preview .apple-heading-row { align-items: flex-start; }
          main.apple-layout-preview .apple-help-button span { display: none; }
          main.apple-layout-preview .apple-mini-fields { grid-template-columns: 1fr; }
          main.apple-layout-preview .apple-course-toolbar { grid-template-columns: 1fr; gap: .2rem; }
          main.apple-layout-preview .apple-clear-button { justify-self: start; }
          main.apple-layout-preview .course-row { grid-template-columns: 1fr; gap: .35rem; }
          main.apple-layout-preview .course-toggles { justify-content: stretch; }
          main.apple-layout-preview button.course-toggle { flex: 1; }
        }
      `}</style>

      <header className="app-header">
        <div className="apple-brand" aria-label="EconPlanner">
          <span className="apple-brand-mark" aria-hidden="true">E</span>
          <span>EconPlanner</span>
        </div>
        <div className="apple-progress" aria-label="Planner progress">
          <span className="apple-progress-step is-current"><span />About you</span>
          <span className="apple-progress-step"><span />Your courses</span>
          <span className="apple-progress-step"><span />Your plan</span>
        </div>
        <div className="app-title">
          <h1><span className="headline-econ">Econ</span> <span className="headline-planner">Planner</span></h1>
        </div>
      </header>

      <div className="apple-heading-row">
        <div>
          <h2>Build your economics course plan</h2>
          <p>Tell us where you are and which courses you have completed or are taking.</p>
        </div>
        <button type="button" className="apple-help-button">? <span>How this works</span></button>
      </div>

      <form onSubmit={mapMajors}>
        <section className="instruction-card">
          <h2>The EconPlanner combines your completed and current courses, major requirements, and course timing to show what you still need and help build a manageable semester-by-semester path through the rest of your time at Hanover College so you can plan ahead easily.</h2>
          <p className="instruction-lead"><span className="lead-aqua">This</span> <span className="lead-gold">is</span> <span className="lead-orange">what</span> <span className="lead-gold">you</span> <span className="lead-aqua">do</span></p>
          <div className="planner-instructions">
            <p>1. Choose class standing</p>
            <p>2. Select Econ and cognate courses taken or in progress</p>
            <p>3. Click on Generate My Plan below course selection list.</p>
            <p>4. EconPlanner will generate a course plan.</p>
          </div>
        </section>

        <div className="intake-layout">
          <div className="apple-left-column">
          <section className="intake-card planning-intake-card">
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
              <div className="apple-planning-heading">
                <h2>Where are you in your degree?</h2>
                <p>Choose the standing you will have in the upcoming Fall.</p>
              </div>
              <div className="apple-standing-segmented" role="group" aria-label="Class standing">
                {[
                  ["freshman", "Freshman"],
                  ["sophomore", "Sophomore"],
                  ["junior", "Junior"],
                  ["senior", "Senior"]
                ].map(([value, label]) => (
                  <button
                    type="button"
                    className={formData.academicStanding === value ? "is-selected" : ""}
                    key={value}
                    onClick={() => setFormData(current => ({ ...current, academicStanding: value, summerStandingConfirmed: "" }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="apple-mini-fields">
                <label>
                  <span>Plan creation date</span>
                  <input
                    type="date"
                    value={formData.planCreationDate}
                    onChange={event => setFormData(current => ({
                      ...current,
                      planCreationDate: event.target.value,
                      summerStandingConfirmed: ""
                    }))}
                  />
                </label>
                <label>
                  <span>Expected graduation</span>
                  <input type="text" value={planningContext.expectedGraduationTerm || "To be confirmed"} readOnly />
                </label>
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

          <section className="intake-card course-intake-card">
            <div className="section-heading course-heading">
              <div>
                <h2>2. Select Econ and cognate courses you have taken or are taking (in-progress).</h2>
                <p>Select completed and in-progress courses. We will map out your remaining plan.</p>
                <p>Choose a status for each course. Click a selected button again to clear it.</p>
              </div>
            </div>
            <div className="apple-course-heading">
              <div>
                <h2>Which courses have you taken?</h2>
                <p>Select Completed or In progress. Tap a selected status again to clear it.</p>
              </div>
              <span>{selectedCourses(formData.courses).length} selected</span>
            </div>

            <div className="apple-course-toolbar">
              <label className="search-label">
                <span className="sr-only">Search courses</span>
                <input
                  type="search"
                  value={courseSearch}
                  onChange={event => setCourseSearch(event.target.value)}
                  placeholder="Search by course or title"
                />
              </label>
              <button
                type="button"
                className="apple-clear-button"
                onClick={() => setFormData(current => ({
                  ...current,
                  courses: current.courses.map(course => ({ ...course, status: "not_started" }))
                }))}
              >
                Clear selections
              </button>
            </div>

            {declarationGroups.length > 0 && (
              <div className="course-level-section declaration-section">
                {renderDeclarationColumns(
                  declarationCourseGroups,
                  appleLayoutPreview ? declarationRequirementGroups : [...declarationRequirementGroups, ...declarationRightCourseGroups]
                )}
              </div>
            )}

            {renderCourseAccordion(
              "two-hundred-level",
              appleLayoutPreview ? "Courses offered relatively frequently" : "Courses offered relatively frequent",
              relativelyFrequentGroups
            )}
            {renderCourseAccordion(
              "three-hundred-level",
              appleLayoutPreview ? "Additional and less-frequent economics courses" : "Econ courses offered infrequently",
              appleAdvancedGroups
            )}

            {visibleGroups.length === 0 && <p className="status">No courses match your search.</p>}

          </section>
          </div>

          <div className="apple-right-column">
          <PlannerSummary report={report} courses={formData.courses} planningContext={planningContext} />

          <section className="generate-card">
            {!inputPrerequisiteValidation.valid && (
              <div className="prerequisite-error-summary" role="alert">
                <strong>Correct these course selections before generating a plan:</strong>
                <ul>
                  {inputPrerequisiteValidation.issues.map(issue => (
                    <li key={`${issue.code}-${issue.course}-${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="generate-row">
              <button
                type="submit"
                className="generate-button"
                disabled={!formData.planCreationDate || planningContext.requiresSummerClarification || !inputPrerequisiteValidation.valid}
              >
                <span className="default-generate-label">3. Generate My Plan</span>
                <span className="apple-generate-label">Generate my three plans &#8594;</span>
              </button>
            </div>
          </section>
          </div>
        </div>
      </form>

      {status && <p className="status" role="status">{status}</p>}
      <AdvisorAttention catalog={report?.catalog} />
      <PlanTimeline
        plans={economicsResult(report)?.economicsPlans || []}
        planningGaps={economicsResult(report)?.economicsPlanningGaps || []}
      />
    </main>
  );
}
