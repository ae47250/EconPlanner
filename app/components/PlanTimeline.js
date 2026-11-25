"use client";

import { useContext, useEffect, useState } from "react";
import { acceleratedMathSequenceNotes } from "../../lib/planning/acceleratedMathSequence.js";
import { summerLastResortNote } from "../../lib/planning/summer-note.js";
import { seatStatusPresentation } from "../../lib/planning/seat-status.js";
import { planTermsWithCurrentCourses } from "../../lib/planning/plan-display.js";
import { studentFriendlyCourseMarker, studentFriendlyUnavailableReason, studentTermLabel } from "../../lib/planning/student-language.js";
import { COURSE_CATALOG, COURSE_PREREQUISITES, courseTitle, planCourseIdentity, formatAcademicYear, compactPlanCourse } from "../plannerShared.js";
import { PlanningGaps } from "./planNotes.js";
import { CourseMenuContext, CourseChange, CourseDragHandle, MoveConfirmation } from "./courseEditing.js";

function academicYearKey(value) {
  return String(value || "").replace("/", "-");
}

function scheduleTermKey(term) {
  const value = String(term?.termKey || term?.scheduleTerm || term?.displayTerm || term?.term || "");
  if (/spring|may/i.test(value)) return "May";
  return value;
}

function courseHasMoveControl(course) {
  return course.course !== "ECO 461" || (course.moveDestinationOptions || [])
    .some(option => ["ALLOWED", "CONDITIONAL"].includes(option.status));
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
                      <p className="summer-term-note">{summerLastResortNote()}</p>
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
                  {item.course} in {item.term}: {summerLastResortNote()} {item.reason}
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

export { PlanTimeline, academicYearKey, scheduleTermKey, courseHasMoveControl, feasibilityLabel, hasExactAvailabilityEvidence, exactPublishedScheduleSection, courseAvailabilityLabel, availabilityClassName, CourseAvailabilityStatus, CandidateOutcomes };
