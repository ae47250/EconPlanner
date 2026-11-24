"use client";

import { useEffect, useRef } from "react";
import { buildEarlyGraduationContext, buildPlanningSlots, PLANNING_PACES, resolvePlanningContext } from "../../lib/planning/horizon.js";
import { joinStudyAbroadTerms, studyAbroadTermIds } from "../../lib/planning/study-abroad.js";
import { studentTermLabel } from "../../lib/planning/student-language.js";
import { isTaken, planningSlotsLabel } from "../plannerShared.js";
import { PlanningGaps } from "./planNotes.js";
import { CandidateOutcomes } from "./PlanTimeline.js";

const STANDING_LABELS = Object.freeze({
  freshman: "Freshman",
  sophomore: "Sophomore",
  junior: "Junior",
  senior: "Senior"
});

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

export { STANDING_LABELS, SummaryCourseCodes, ResultDiagnostics, ClearAllDialog, PlannerSummary };
