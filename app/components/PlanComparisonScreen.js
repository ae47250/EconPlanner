"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { buildPlanningSlots } from "../../lib/planning/horizon.js";
import { acceleratedMathSequenceNotes } from "../../lib/planning/acceleratedMathSequence.js";
import { joinStudyAbroadTerms, studyAbroadAdvisorContext, studyAbroadTermIds } from "../../lib/planning/study-abroad.js";
import { noPlanPresentation } from "../../lib/planning/no-plan-presentation.js";
import { planningRequirementsNote } from "../../lib/catalog/planning-requirements-note.js";
import { feasibilityMeaning, planTermsWithCurrentCourses } from "../../lib/planning/plan-display.js";
import { summerLastResortNote } from "../../lib/planning/summer-note.js";
import { preliminaryScheduleExplanation, studentFriendlyCourseMarker, studentFriendlyUnavailableReason, studentStandingSummary, studentTermLabel } from "../../lib/planning/student-language.js";
import { comparisonStyles } from "../styles/comparisonStyles";
import { COURSE_CATALOG, COURSE_PREREQUISITES, isTaken, courseTitle, economicsResult, planCourseIdentity, formatAcademicYear, planningSlotsLabel, compactPlanCourse, planReadinessLabel } from "../plannerShared.js";
import { AdvisorAttention, PlanConditions, MajorRequirementsChecklist } from "./planNotes.js";
import { CourseMenuContext, ExtraCoursePicker, CourseChange, CourseDragHandle, MoveConfirmation } from "./courseEditing.js";
import { courseHasMoveControl, CourseAvailabilityStatus } from "./planCourseHelpers.js";
import { ResultDiagnostics } from "./plannerSummary.js";

const STUDENT_READINESS_EXPLANATIONS = Object.freeze({
  "Ready to plan": "The plan meets the major rules. Check seats and future schedules before you register.",
  "Needs confirmation": "Check the approval and standing notes on each plan before registering.",
  "Needs advisor attention": "Ask your advisor to review the reason below before relying on this plan."
});

function structuredItemText(item, fallback) {
  if (typeof item === "string") return item;
  return item?.message || item?.question || item?.prompt || item?.reason || item?.label || item?.code || fallback;
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
  selectedPlanId,
  isExiting,
  isGenerating,
  editingPlanCourseKey,
  planEditStatus,
  planEditFeedback,
  undoPlanId,
  onEditCourses,
  onReviewTimeline,
  onReviewReservedRoom,
  onClearAll,
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
  useEffect(() => { setOpenCourseMenuId(null); setConfirmingCourseMenuId(null); }, [selectedPlanId]);
  useEffect(() => { if (openCourseMenuId) setComparisonDropMessage(""); }, [openCourseMenuId]);
  const [highlightDifferences, setHighlightDifferences] = useState(false);
  const resultHeadingRef = useRef(null);
  const planningContext = comparisonContext;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => resultHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

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
  const earlyGraduationTarget = plans.find(plan => plan.id === "one-year-early")?.planningContext?.expectedGraduationTerm;
  const graduationTargetDisplay = earlyGraduationTarget && studentTermLabel(earlyGraduationTarget) !== graduationTarget
    ? `${graduationTarget} (one year early: ${studentTermLabel(earlyGraduationTarget)})`
    : graduationTarget;
  const completedCodes = courses.filter(isTaken).map(course => (
    `${course.code}${course.source === "ap_credit" ? " (AP)" : course.status === "transfer" ? " (transfer)" : ""}`
  ));
  const inProgressCodes = courses.filter(course => course.status === "in_progress").map(course => course.code);
  const overallStatus = overallPlanReadiness(plans);
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
  const statusPlans = plans;
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
        <nav className="result-progress" aria-label="Planner progress">
          <ol>
            <li><button type="button" onClick={onReviewTimeline}>About you</button></li>
            <li><button type="button" onClick={onEditCourses}>Your courses</button></li>
            <li className="is-current" aria-current="step"><span>Your plans</span></li>
          </ol>
        </nav>
        <div className="comparison-student">
          <strong>{standing}</strong>
          <span aria-hidden="true">·</span>
          <span>Graduation target: {graduationTargetDisplay}</span>
          {studyAbroadLabel && <><span aria-hidden="true">·</span><span>Study abroad: {studyAbroadLabel}</span></>}
        </div>
        <div className="comparison-actions">
          <button
            type="button"
            className="regenerate-plans-button"
            disabled={isGenerating || Boolean(editingPlanCourseKey)}
            onClick={onRegenerate}
          >
            {isGenerating ? "Regenerating..." : "Regenerate all plans"}
          </button>
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
            {plans.length > 0 && <span className="result-status-reason">{displayedOverallStatus === "Needs confirmation" && plans.length === 1
              ? "Check this plan's approval and standing notes before registering."
              : STUDENT_READINESS_EXPLANATIONS[displayedOverallStatus]}{paperworkReminder && " See the notes below for paperwork to file."}</span>}
            {displayedOverallStatus === "Needs advisor attention" && statusReason && <span className="result-status-reason">Why: {statusReason}</span>}
          </p>
        </section>
        <div className="comparison-heading-row">
          <div>
            <h1 ref={resultHeadingRef} tabIndex={-1}>{plans.length > 1
                ? "Compare your course plans"
                : plans.length === 1
                  ? "Your plan"
                  : "Your planning result"}</h1>
            {plans.length > 0 && <p className="plan-edit-instructions"><strong>Click a course to see where it can move. You can also drag it by the ⠿ handle.</strong><span>While you drag, green terms are open, amber terms need approval or a check first, and gray terms show why the course can&apos;t go there.</span></p>}
          </div>
          {plans.length > 1 && (
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

        {highlightDifferences && (
          <p className="comparison-difference-key">
            <strong>Purple bars show classes placed in only one plan.</strong> Classes in the same term in both plans have no bar.
          </p>
        )}

        {planEditStatus && <p className="plan-edit-status" role="status">{planEditStatus}</p>}
        <p role="status">{comparisonDropMessage}</p>
        {comparisonDrop && <MoveConfirmation drop={comparisonDrop} onApply={applyComparisonDrop}
          onCancel={() => setComparisonDrop(null)} busy={Boolean(editingPlanCourseKey)} />}
        {plans.length > 0 ? (
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
                                    {course.source === "summer-last-resort" && <span className="summer-term-note">{summerLastResortNote()}</span>}
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

        {acceleratedResult && !mergePossibleEarlyResult && (
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

function overallPlanReadiness(plans = []) {
  const labels = plans.map(planReadinessLabel);
  if (labels.includes("Needs advisor attention")) return "Needs advisor attention";
  if (labels.includes("Needs confirmation")) return "Needs confirmation";
  return plans.length ? "Ready to plan" : "Not available";
}

export { STUDENT_READINESS_EXPLANATIONS, structuredItemText, comparisonScheduleRows, PlanComparisonScreen, overallPlanReadiness };
