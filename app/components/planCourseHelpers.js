import { seatStatusPresentation } from "../../lib/planning/seat-status.js";

function academicYearKey(value) {
  return String(value || "").replace("/", "-");
}

function scheduleTermKey(term) {
  const value = String(term?.termKey || term?.scheduleTerm || term?.displayTerm || term?.term || "");
  if (/spring|may/i.test(value)) return "May";
  return value;
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

function feasibilityLabel(status) {
  return ({
    VERIFIED_FEASIBLE: "Fits the current schedule",
    CONDITIONALLY_FEASIBLE: "Fits with checks",
    PRELIMINARY_ONLY: "Preliminary only",
    SEARCH_INCOMPLETE: "We could not find a complete plan yet",
    NOT_FEASIBLE: "No complete plan found"
  })[status] || "Status pending";
}

function courseHasMoveControl(course) {
  return course.course !== "ECO 461" || (course.moveDestinationOptions || [])
    .some(option => ["ALLOWED", "CONDITIONAL"].includes(option.status));
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

export { courseHasMoveControl, CourseAvailabilityStatus, CandidateOutcomes };
