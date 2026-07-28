"use client";

import { useState } from "react";

const CATALOG_YEAR = "2025-2026";

const blankCourse = id => ({
  id,
  code: "",
  title: "",
  status: "completed",
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
  courses: [blankCourse("course-1")],
  advisorApprovals: ""
};

function formatRemaining(value) {
  return value == null ? "Not available" : `${value} unit${value === 1 ? "" : "s"}`;
}

function assignmentFor(result, slotId, scenario = "strict") {
  return result?.[scenario]?.assignments?.find(item => item.slotId === slotId) || null;
}

function statusLabel(status) {
  return String(status || "").replaceAll("_", " ").toLowerCase();
}

function riskClass(result) {
  return String(result?.risk?.class || "UNKNOWN").toLowerCase().replaceAll("_", "-");
}

function Schedule({ schedule, plan }) {
  if (!schedule) return null;
  return (
    <div className="schedule-card">
      <h4>Economics 2026/2027 offerings</h4>
      <p className="muted">The registrar’s <code>S</code> section is normalized and displayed as May Term.</p>
      <div className="schedule-grid">
        {Object.entries(schedule.terms || {}).map(([term, courses]) => (
          <section key={term}>
            <strong>{term}</strong>
            <ul>
              {[...new Map(courses.map(course => [course.course, course])).values()].map(course => (
                <li key={course.course}>{course.course} — {course.title}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {plan?.terms?.some(term => term.courses.length > 0) && (
        <>
          <h4 className="plan-heading">Suggested verified placements</h4>
          <div className="schedule-grid">
            {plan.terms.map(term => (
              <section key={`plan-${term.term}`}><strong>{term.term}</strong><ul>
                {term.courses.length ? term.courses.map(course => <li key={`${term.term}-${course.course}`}>{course.course} — {course.title}</li>) : <li>None placed</li>}
              </ul></section>
            ))}
          </div>
        </>
      )}
      {plan?.unscheduled?.length > 0 && <p className="warning"><strong>Economics term advisor checks:</strong> {plan.unscheduled.map(item => `${item.label}: ${item.reason}`).join("; ")}</p>}
    </div>
  );
}

function ProgramCard({ result }) {
  const slots = result.requirements || [];
  const strict = result.strict || {};
  const optimistic = result.optimistic || {};

  return (
    <article className="program-card">
      <div className="program-heading">
        <div>
          <h3>{result.program?.name || result.program?.label}</h3>
          <p className="muted">
            {result.program?.degree || "Degree variant pending review"} · {result.program?.catalogYear} · {result.sourceStatus}
          </p>
        </div>
        <span className={`risk risk-${riskClass(result)}`}>{statusLabel(result.risk?.class)}</span>
      </div>

      <div className="metric-grid">
        <div><span>Strict remaining</span><strong>{formatRemaining(strict.remainingUnits)}</strong></div>
        <div><span>Optimistic remaining</span><strong>{formatRemaining(optimistic.remainingUnits)}</strong></div>
        <div><span>After in-progress</span><strong>{formatRemaining(result.projectedAfterInProgress?.optimistic?.remainingUnits)}</strong></div>
        <div><span>Minimum regular terms</span><strong>{result.minimumRegularTerms ?? "Not available"}</strong></div>
      </div>

      {result.risk?.reasons?.length > 0 && (
        <p className="warning"><strong>Advisor checks:</strong> {result.risk.reasons.join("; ")}</p>
      )}

      <details>
        <summary>View assignment details</summary>
        {slots.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Requirement</th><th>Strict</th><th>Optimistic</th><th>Evidence</th></tr></thead>
              <tbody>
                {slots.map(slot => {
                  const strictAssignment = assignmentFor(result, slot.id, "strict");
                  const optimisticAssignment = assignmentFor(result, slot.id, "optimistic");
                  const assignment = strictAssignment || optimisticAssignment;
                  return (
                    <tr key={slot.id}>
                      <td>{slot.label}</td>
                      <td>{strictAssignment?.code || "Remaining"}</td>
                      <td>{optimisticAssignment?.code || "Remaining"}</td>
                      <td>{assignment?.evidenceStatus || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="warning">The official catalog source is captured, but this program’s requirement tree has not been approved for runtime mapping.</p>
        )}

        {result.missingPrerequisites?.length > 0 && (
          <div className="detail-block">
            <strong>Missing prerequisites</strong>
            <ul>{result.missingPrerequisites.map(item => <li key={`${item.course}-${item.missing}`}>{item.course}: {item.missing}</li>)}</ul>
          </div>
        )}
        {result.unusedCourses?.length > 0 && (
          <div className="detail-block"><strong>Unused or duplicate courses</strong><p>{result.unusedCourses.map(course => course.code || course.title).join(", ")}</p></div>
        )}
        <p className="muted">Source confidence: {result.sourceStatus}. Catalog source: <a href={result.program?.sourceUrl} target="_blank" rel="noreferrer">official Hanover page</a>.</p>
      </details>

      <Schedule schedule={result.annualSchedule} plan={result.economicsPlan} />
    </article>
  );
}

export default function Page() {
  const [formData, setFormData] = useState(initialForm);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState(null);

  function updateField(event) {
    const { name, value } = event.target;
    setFormData(current => ({ ...current, [name]: value }));
  }

  function updateCourse(id, field, value) {
    setFormData(current => ({
      ...current,
      courses: current.courses.map(course => course.id === id ? { ...course, [field]: value } : course)
    }));
  }

  function addCourse() {
    setFormData(current => ({
      ...current,
      courses: [...current.courses, blankCourse(`course-${Date.now()}`)]
    }));
  }

  function removeCourse(id) {
    setFormData(current => ({
      ...current,
      courses: current.courses.length === 1 ? current.courses : current.courses.filter(course => course.id !== id)
    }));
  }

  async function mapMajors(event) {
    event.preventDefault();
    setStatus("Mapping course history to every cataloged major variant...");
    setReport(null);

    const student = {
      ...formData,
      courses: formData.courses.filter(course => course.code || course.title || course.notes)
    };

    try {
      const response = await fetch("/api/majors/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ student })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The major mapper could not complete.");
      setReport(data);
      setStatus("");
    } catch (error) {
      setStatus(error.message);
    }
  }

  return (
    <main className="container">
      <style jsx global>{`
        :root { --planner-bg: #eef8ee; --planner-border: #c9d8cc; --planner-muted: #536257; --planner-green: #1f6b45; }
        body { background: var(--planner-bg); }
        main.container { max-width: 1180px; padding-top: 2rem; padding-bottom: 4rem; }
        .hero { text-align: center; margin-bottom: 1.25rem; }
        .hero p { max-width: 760px; margin-inline: auto; color: var(--planner-muted); }
        .planner-card, .program-card, .summary-card, .schedule-card { border: 1px solid var(--planner-border); border-radius: 1rem; background: #fff; box-shadow: none; }
        .planner-card { padding: 1.4rem; }
        .form-grid, .course-row { display: grid; gap: .8rem; }
        .two-col { display: grid; gap: 1rem; grid-template-columns: 1fr; }
        @media (min-width: 760px) { .two-col { grid-template-columns: 1fr 1fr; } .course-row { grid-template-columns: 1fr 1fr 1fr 1fr; } }
        .course-entry { border: 1px solid var(--planner-border); border-radius: .75rem; padding: .9rem; margin-top: .75rem; }
        .course-entry .wide { grid-column: 1 / -1; }
        .course-actions { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: .75rem; }
        .course-actions button { width: auto; margin: 0; }
        .submit-row { margin-top: 1.25rem; }
        .submit-row button { width: 100%; }
        .status { margin-top: 1rem; color: var(--planner-muted); min-height: 1.5rem; }
        .results { margin-top: 1.5rem; }
        .summary-card { padding: 1rem; margin-bottom: 1rem; }
        .summary-grid, .metric-grid, .schedule-grid { display: grid; gap: .8rem; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
        .summary-grid div, .metric-grid div { border: 1px solid var(--planner-border); border-radius: .7rem; padding: .75rem; }
        .summary-grid span, .metric-grid span { display: block; color: var(--planner-muted); font-size: .85rem; }
        .summary-grid strong, .metric-grid strong { display: block; margin-top: .25rem; }
        .program-card { padding: 1.15rem; margin-top: 1rem; }
        .program-heading { display: flex; gap: 1rem; justify-content: space-between; align-items: flex-start; }
        .program-heading h3 { margin-bottom: .2rem; }
        .muted { color: var(--planner-muted); font-size: .92rem; }
        .risk { border-radius: 999px; padding: .35rem .65rem; font-size: .8rem; white-space: nowrap; background: #e8f0ea; color: var(--planner-green); }
        .risk-insufficient-information { background: #fff3d6; color: #795b00; }
        .risk-feasible-with-assumptions { background: #fff3d6; color: #795b00; }
        .risk-not-currently-feasible, .risk-high-risk { background: #ffe0df; color: #8c241e; }
        .metric-grid { margin: 1rem 0; }
        .warning { border-left: 4px solid #d59b00; padding: .65rem .8rem; background: #fff9e8; }
        details { margin-top: 1rem; }
        summary { cursor: pointer; color: var(--planner-green); font-weight: 700; }
        .table-wrap { overflow-x: auto; margin-top: .75rem; }
        table { min-width: 680px; margin-bottom: .75rem; }
        th, td { vertical-align: top; }
        .detail-block { border-top: 1px solid var(--planner-border); padding-top: .75rem; margin-top: .75rem; }
        .detail-block p:last-child, .detail-block ul:last-child { margin-bottom: 0; }
        .schedule-card { margin-top: 1rem; padding: 1rem; background: #f8fcf8; }
        .schedule-card h4 { margin-bottom: .4rem; }
        .schedule-grid section { border: 1px solid var(--planner-border); border-radius: .65rem; padding: .65rem; }
        .schedule-grid ul { margin: .4rem 0 0; padding-left: 1.1rem; font-size: .9rem; }
        .catalog-note { margin-top: 1rem; font-size: .9rem; color: var(--planner-muted); }
      `}</style>

      <header className="hero">
        <h1>Hanover EconMapper</h1>
        <p>Map a student’s course history against every Hanover undergraduate major and program variant. Economics includes the first exact Fall/Winter/May planning layer.</p>
      </header>

      <article className="planner-card">
        <form onSubmit={mapMajors}>
          <div className="form-grid">
            <div className="two-col">
              <label>Display name<input name="displayName" value={formData.displayName} onChange={updateField} placeholder="Optional" /></label>
              <label>Academic standing<select name="academicStanding" value={formData.academicStanding} onChange={updateField}>
                <option value="freshman">Freshman</option><option value="sophomore">Sophomore</option><option value="junior">Junior</option><option value="senior">Senior</option>
              </select></label>
            </div>
            <div className="two-col">
              <label>Entry catalog year<select name="entryCatalogYear" value={formData.entryCatalogYear} onChange={updateField} required><option value="2025-2026">2025–2026</option></select></label>
              <label>Major-declaration catalog year<input name="majorDeclarationCatalogYear" value={formData.majorDeclarationCatalogYear} onChange={updateField} placeholder="Leave blank if unknown" /></label>
            </div>
            <div className="two-col">
              <label>Expected graduation term<input name="expectedGraduationTerm" value={formData.expectedGraduationTerm} onChange={updateField} placeholder="Example: Spring 2029" /></label>
              <label>Advisor approvals or substitutions<textarea name="advisorApprovals" value={formData.advisorApprovals} onChange={updateField} placeholder="Optional notes; these remain advisor checks until verified." /></label>
            </div>
          </div>

          <h3>Course history</h3>
          <p className="muted">Enter codes when known. Transfer, uncertain, repeated, failed, and withdrawn records are retained for review and are not silently counted.</p>
          {formData.courses.map(course => (
            <div className="course-entry" key={course.id}>
              <div className="course-row">
                <label>Course code<input value={course.code} onChange={event => updateCourse(course.id, "code", event.target.value)} placeholder="ECO 113" /></label>
                <label>Course title<input value={course.title} onChange={event => updateCourse(course.id, "title", event.target.value)} placeholder="Optional" /></label>
                <label>Status<select value={course.status} onChange={event => updateCourse(course.id, "status", event.target.value)}>
                  <option value="completed">Completed</option><option value="in_progress">In progress</option><option value="transfer">Transfer/AP/IB</option><option value="uncertain">Uncertain equivalency</option><option value="repeated">Repeated</option><option value="failed">Failed</option><option value="withdrawn">Withdrawn</option>
                </select></label>
                <label>Units<input value={course.units} onChange={event => updateCourse(course.id, "units", event.target.value)} placeholder="1" /></label>
                <label>Grade<input value={course.grade} onChange={event => updateCourse(course.id, "grade", event.target.value)} placeholder="A" /></label>
              </div>
              <div className="course-actions"><button type="button" className="secondary" onClick={() => removeCourse(course.id)}>Remove course</button></div>
            </div>
          ))}
          <div className="course-actions"><button type="button" className="secondary" onClick={addCourse}>Add course</button></div>
          <div className="submit-row"><button type="submit">Map all Hanover majors</button></div>
        </form>
        <p className="catalog-note">Catalog source currently captured locally: Hanover 2025–2026. Requirement maps that have not passed human source review are shown as “Insufficient information,” never guessed.</p>
      </article>

      {status && <p className="status" role="status">{status}</p>}
      {report && (
        <section className="results" aria-live="polite">
          <div className="summary-card">
            <h2>Major comparison</h2>
            <p className="muted">Catalog basis: {report.catalog.basis.replaceAll("_", " ")} · {report.catalog.selectedCatalogYear}</p>
            <div className="summary-grid">
              <div><span>Program variants</span><strong>{report.summary.programCount}</strong></div>
              <div><span>Approved mappings</span><strong>{report.summary.mappedProgramCount}</strong></div>
              <div><span>Advisor review required</span><strong>{report.summary.reviewRequiredProgramCount}</strong></div>
            </div>
          </div>
          {report.programs.map(result => <ProgramCard key={result.program?.id || result.program?.label} result={result} />)}
        </section>
      )}
    </main>
  );
}
