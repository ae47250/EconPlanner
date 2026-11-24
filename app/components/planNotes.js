"use client";

import { planningRequirementsNote, replacesLegacyCatalogNotice } from "../../lib/catalog/planning-requirements-note.js";
import { studentTermLabel } from "../../lib/planning/student-language.js";

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

export { PlanningGaps, isFlattenedPlanNotice, PlanNoteText, UpcomingCourseEntry, AdvisorAttention, PlanConditions, MajorRequirementsChecklist };
