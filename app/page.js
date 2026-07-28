"use client";

import { useState } from "react";

const initialForm = {
  studentYear: "freshman",
  mathCognate: "not completed",
  completedCourses: "",
  currentCourses: "",
  statsOption: "not completed",
  financeOption: "not completed",
  additionalNotes: ""
};

function renderCell(items) {
  if (!Array.isArray(items) || items.length === 0) return ["-"];
  return items.map(item => String(item).replace(/\bOR\b/g, "or"));
}

export default function Page() {
  const [formData, setFormData] = useState(initialForm);
  const [status, setStatus] = useState("");
  const [plan, setPlan] = useState(null);

  function updateField(event) {
    const { name, value } = event.target;
    setFormData(current => ({ ...current, [name]: value }));
  }

  async function submitPlan(event) {
    event.preventDefault();
    setStatus("Building plan...");
    setPlan(null);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData)
      });

      const data = await response.json();
      if (!response.ok) {
        const validationExplanations = Array.isArray(data.validation?.explanations)
          ? data.validation.explanations.join(" ")
          : "";
        throw new Error([data.error, validationExplanations].filter(Boolean).join(" "));
      }

      setStatus("");
      setPlan(data.plan);
    } catch (error) {
      setStatus(error.message);
    }
  }

  return (
    <main className="container">
      <style jsx global>{`
        :root {
          --planner-max-width: 880px;
          --planner-border: #d7d7d7;
          --planner-muted: #666;
          --planner-bg: #eef8ee;
        }

        body {
          background: var(--planner-bg);
        }

        main.container {
          max-width: var(--planner-max-width);
          padding-top: 2rem;
          padding-bottom: 3rem;
        }

        .hero {
          text-align: center;
          margin-bottom: 1.25rem;
        }

        .hero p {
          max-width: 680px;
          margin-inline: auto;
          color: var(--planner-muted);
        }

        .planner-card,
        .result-card,
        .year-card,
        .note-card {
          border: 1px solid var(--planner-border);
          border-radius: 1rem;
          background: #fff;
          box-shadow: none;
        }

        .planner-card {
          padding: 1.4rem;
        }

        .form-grid {
          display: grid;
          gap: 1rem;
        }

        .two-col {
          display: grid;
          gap: 1rem;
          grid-template-columns: 1fr;
        }

        @media (min-width: 720px) {
          .two-col {
            grid-template-columns: 1fr 1fr;
          }
        }

        textarea {
          min-height: 9rem;
          resize: vertical;
        }

        .submit-row {
          margin-top: 1.25rem;
        }

        .submit-row button {
          width: 100%;
        }

        .status {
          margin-top: 1rem;
          color: var(--planner-muted);
          min-height: 1.5rem;
        }

        .results {
          margin-top: 1.5rem;
        }

        .result-card {
          padding: 1.25rem;
        }

        .summary-card {
          border: 1px solid var(--planner-border);
          border-radius: 0.9rem;
          padding: 1rem;
          background: #fff;
          margin-bottom: 1rem;
        }

        .summary-card p {
          margin-bottom: 0.45rem;
        }

        .summary-card p:last-child {
          margin-bottom: 0;
        }

        .year-card {
          padding: 1rem;
          margin-top: 1rem;
        }

        .year-card h3 {
          margin-bottom: 0.75rem;
          text-align: center;
        }

        table {
          margin-bottom: 0;
        }

        th,
        td {
          text-align: center;
          vertical-align: top;
        }

        .note-card {
          padding: 0.85rem 1rem;
          margin-top: 0.75rem;
          font-size: 0.95rem;
          color: #333;
        }

        .note-card p:last-child {
          margin-bottom: 0;
        }

        .small-muted {
          color: var(--planner-muted);
          font-size: 0.92rem;
        }
      `}</style>

      <header className="hero">
        <h1>EconMapper</h1>
        <p>
          Build a possible economics major course plan. This tool is not a
          replacement for advisor confirmation.
        </p>
      </header>

      <article className="planner-card">
        <form onSubmit={submitPlan}>
          <div className="form-grid">
            <div className="two-col">
              <label>
                What year are you?
                <select
                  name="studentYear"
                  required
                  value={formData.studentYear}
                  onChange={updateField}
                >
                  <option value="freshman">Freshman</option>
                  <option value="sophomore">Sophomore</option>
                  <option value="junior">Junior</option>
                  <option value="senior">Senior</option>
                </select>
              </label>

              <label>
                MAT 113 / MAT 121
                <select
                  name="mathCognate"
                  value={formData.mathCognate}
                  onChange={updateField}
                >
                  <option value="not completed">Not completed</option>
                  <option value="completed MAT 113 / MAT 121">
                    Completed MAT 113 / MAT 121
                  </option>
                  <option value="currently taking MAT 113 / MAT 121">
                    Currently taking MAT 113 / MAT 121
                  </option>
                  <option value="unsure">Unsure</option>
                </select>
              </label>
            </div>

            <div className="two-col">
              <label>
                Completed ECO courses
                <input
                  name="completedCourses"
                  type="text"
                  placeholder="Example: ECO 113, ECO 114"
                  value={formData.completedCourses}
                  onChange={updateField}
                />
              </label>

              <label>
                Current ECO courses
                <input
                  name="currentCourses"
                  type="text"
                  placeholder="Example: ECO 213"
                  value={formData.currentCourses}
                  onChange={updateField}
                />
              </label>
            </div>

            <div className="two-col">
              <label>
                Statistics option
                <select
                  name="statsOption"
                  value={formData.statsOption}
                  onChange={updateField}
                >
                  <option value="not completed">Not completed</option>
                  <option value="completed MAT 217 / ECO 257 / PSY 217">
                    Completed MAT 217 / ECO 257 / PSY 217
                  </option>
                  <option value="currently taking MAT 217 / ECO 257 / PSY 217">
                    Currently taking MAT 217 / ECO 257 / PSY 217
                  </option>
                  <option value="unsure">Unsure</option>
                </select>
              </label>

              <label>
                Money/finance requirement
                <select
                  name="financeOption"
                  value={formData.financeOption}
                  onChange={updateField}
                >
                  <option value="not completed">Not completed</option>
                  <option value="completed ECO 321 / BUSN 323">
                    Completed ECO 321 / BUSN 323
                  </option>
                  <option value="currently taking ECO 321 / BUSN 323">
                    Currently taking ECO 321 / BUSN 323
                  </option>
                  <option value="unsure">Unsure</option>
                </select>
              </label>
            </div>

            <label>
              Additional notes
              <textarea
                name="additionalNotes"
                maxLength="8000"
                placeholder="Optional: add transfer/AP credit, schedule concerns, or anything else the planner should know."
                value={formData.additionalNotes}
                onChange={updateField}
              />
              <small className="small-muted">
                Long notes are summarized before they are displayed back to you.
              </small>
            </label>
          </div>

          <div className="submit-row">
            <button type="submit">Build My EconMap</button>
          </div>
        </form>

        <div className="status" aria-live="polite">
          {status}
        </div>
      </article>

      <section className="results" aria-live="polite">
        {plan ? <PlanResult plan={plan} /> : null}
      </section>
    </main>
  );
}

function PlanResult({ plan }) {
  const years = Array.isArray(plan.years) ? plan.years : [];
  const advisorChecks = Array.isArray(plan.advisorChecks) ? plan.advisorChecks : [];
  const globalNotes = Array.isArray(plan.globalNotes) ? plan.globalNotes : [];

  return (
    <article className="result-card">
      <div className="summary-card">
        <p>
          <strong>Student Summary</strong>
        </p>
        <p>{plan.assumptions || "Assumptions not provided."}</p>
        {plan.studentSummary ? <p>{plan.studentSummary}</p> : null}
      </div>

      {years.map((year, index) => {
        const terms = year.terms || {};
        const notes = Array.isArray(year.notes) ? year.notes : [];

        return (
          <section className="year-card" key={`${year.label || "year"}-${index}`}>
            <h3>
              {year.label} - {year.academicYear}
            </h3>
            <table>
              <thead>
                <tr>
                  <th>Fall</th>
                  <th>Winter</th>
                  <th>May</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    {renderCell(terms.Fall).map((item, itemIndex) => (
                      <div key={`${item}-${itemIndex}`}>{item}</div>
                    ))}
                  </td>
                  <td>
                    {renderCell(terms.Winter).map((item, itemIndex) => (
                      <div key={`${item}-${itemIndex}`}>{item}</div>
                    ))}
                  </td>
                  <td>
                    {renderCell(terms.May).map((item, itemIndex) => (
                      <div key={`${item}-${itemIndex}`}>{item}</div>
                    ))}
                  </td>
                </tr>
              </tbody>
            </table>
            {notes.map((note, noteIndex) => (
              <div className="note-card" key={`${note}-${noteIndex}`}>
                <p>{note}</p>
              </div>
            ))}
          </section>
        );
      })}

      {advisorChecks.length ? (
        <div className="note-card">
          <strong>Advisor check:</strong>
          <br />
          {advisorChecks.map((check, index) => (
            <div key={`${check}-${index}`}>{check}</div>
          ))}
        </div>
      ) : null}

      {globalNotes.map((note, index) => (
        <div className="note-card" key={`${note}-${index}`}>
          <p>{note}</p>
        </div>
      ))}
    </article>
  );
}
