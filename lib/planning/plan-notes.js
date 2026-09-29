import { normalizeStudentCourses } from "../requirements/normalize.js";
import { mayAllocateCourseToRequirement } from "./requirementAllocation.js";

export function economicsCourseLabel(course = {}) {
  const code = course.course || course.code || "";
  return code === "ECO elective" && course.minimumLevel >= 200 ? "ECO elective (200+)" : code;
}

function timeLabel(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? "PM" : "AM"}`;
}

function sectionLabel(section) {
  const letter = section.sectionId.split("-").at(-1);
  const weekdays = { MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu", FRI: "Fri", SAT: "Sat", SUN: "Sun" };
  const meeting = section.meeting || {};
  const start = timeLabel(meeting.startTime);
  const end = timeLabel(meeting.endTime);
  const days = (meeting.days || []).map(day => weekdays[day] || day).join(", ");
  return `${letter}: ${days && start && end ? `${days} ${start}–${end}` : "meeting time unavailable"}`;
}

// Informational projection only. No planner or validator consumes history here.
export function buildEconomicsPlanNotes({ plan, student = {}, mapping, policyBundle }) {
  const advice = policyBundle.planningAdvice;
  if (!advice || !plan) return [];
  const notes = [];
  const degree = plan.degreeRequirementInformation;
  if (degree?.items?.length) notes.push({ id: "ccr-ace", title: "CCR/ACE information",
    description: `${degree.terminology.ccr} / ${degree.terminology.ace}`,
    items: degree.items.map(item => ({ code: item.code, text: item.detail })) });
  else if (degree?.evidenceStatus === "UNAVAILABLE_FOR_APPLICABLE_GENERAL_DEGREE_CATALOG") {
    notes.push({ id: "ccr-ace", title: "CCR/ACE information", items: [{ text:
      policyBundle.messages["designation.applicability"].replace("{catalogYear}", degree.generalDegreeCatalogYear || "the applicable cohort") }] });
  }

  const used = new Set(normalizeStudentCourses(student.courses)
    .filter(course => ["completed", "transfer", "in_progress"].includes(course.status)).map(course => course.code));
  const remainingIds = new Set((mapping?.projectedAfterInProgress?.optimistic?.unresolved
    || mapping?.optimistic?.unresolved || []).map(item => item.requirementId));
  const remainingElectives = (mapping?.requirements || []).filter(requirement =>
    requirement.kind === "elective" && remainingIds.has(requirement.id));
  const relevant = code => !used.has(code)
    && !(remainingIds.has("finance") && code === policyBundle.indexes.byRuleId["PLANNING-FUTURE-COURSE-CONFIRMATION"].effect.unconfirmedFinanceCourse)
    && remainingElectives.some(requirement =>
    mayAllocateCourseToRequirement({ requirement, code, assignments: mapping.assignments || [],
      requirements: mapping.requirements, policyBundle }));
  const observations = advice.observations.filter(row => advice.display.completedAcademicYears.includes(row.academicYear));
  const mayCourses = [...new Set(observations.filter(row => row.term === "MAY" && relevant(row.course)).map(row => row.course))].sort();
  // Exclusion applies only to this display; all original observations are retained.
  const allMayCourses = new Set(observations.filter(row => row.term === "MAY").map(row => row.course));
  const history = [];
  if (["ECO 213", "ECO 214"].every(code => !used.has(code))
    && (["eco-213", "eco-214"].some(id => remainingIds.has(id))
      || (plan.terms || []).some(term => term.courses.some(course => ["ECO 213", "ECO 214"].includes(course.course))))) {
    history.push({ text: advice.display.intermediate });
  }
  const years = [...advice.display.completedAcademicYears].sort().slice(-advice.display.fallWinterYearCount);
  const yearLines = years.map(year => {
    const terms = ["FALL", "WINTER"].map(term => {
      const codes = [...new Set(observations.filter(row => row.academicYear === year && row.term === term
        && !allMayCourses.has(row.course) && relevant(row.course)).map(row => row.course))].sort();
      return codes.length ? `${term === "FALL" ? "Fall" : "Winter"} ${codes.join(", ")}` : null;
    }).filter(Boolean);
    return terms.length ? `${year.slice(0, 5)}${year.slice(-2)}: ${terms.join("; ")}.` : null;
  }).filter(Boolean);
  if (yearLines.length) history.push({ label: "Economics electives — Fall and Winter history", text: yearLines.join(" "), lines: yearLines });
  if (mayCourses.length) history.push({ label: "Economics electives — courses offered in May in past schedules", text: mayCourses.join(", ") + "." });
  if (history.length) notes.push({ id: "history", title: "Course offerings history", items: history, caveat: advice.display.caveat });

  const date = student.planCreationDate || plan.planningContext?.planCreationDate;
  const upcoming = Object.entries(policyBundle.indexes.offeringByTerm).filter(([_id, term]) => {
    if (!date || term.canonicalTerm === "SUMMER") return false;
    const lastDate = term.sections.map(section => section.meeting?.endDate).filter(Boolean).sort().at(-1);
    const earliestDate = term.sections.map(section => section.meeting?.startDate).filter(Boolean).sort()[0];
    return lastDate && lastDate >= date && (!earliestDate || earliestDate > date);
  }).sort(([left], [right]) => {
    const ordinal = id => Number(id.slice(0, 4)) * 10 + ({ WINTER: 1, MAY: 2, FALL: 3 }[id.split("-")[1]] || 4);
    return ordinal(left) - ordinal(right);
  }).map(([id, term]) => {
    const courses = new Map();
    for (const section of term.sections.filter(section => section.course.startsWith("ECO "))) {
      courses.set(section.course, [...(courses.get(section.course) || []), section]);
    }
    return { label: `${term.canonicalTerm === "MAY" ? "May" : term.canonicalTerm === "WINTER" ? "Winter" : "Fall"} ${id.slice(0, 4)}`,
      lines: [...courses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, sections]) =>
        `${code} — ${sections.map(sectionLabel).join("; ")}`) };
  }).filter(item => item.lines.length);
  if (upcoming.length) notes.push({ id: "upcoming", title: "Upcoming Economics courses", items: upcoming });

  const future = (plan.terms || []).some(term => term.publicationStatus === "PLANNING_PROJECTION");
  if (future) {
    const items = [{ text: advice.display.future }];
    if (plan.unmetElectiveNeed > 0) items.push({ text: advice.display.adjunct });
    if (remainingIds.has("finance")) items.push({ text: advice.display.finance });
    notes.push({ id: "future", title: "Future years", items });
  }
  return notes;
}
