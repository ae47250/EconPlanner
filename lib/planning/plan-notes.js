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
  return { clock: `${hour % 12 || 12}:${match[2]}`, period: hour >= 12 ? "p.m." : "a.m." };
}

function sectionLabel(section, showSection = true) {
  const letter = section.sectionId.split("-").at(-1);
  const weekdays = { MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu", FRI: "Fri", SAT: "Sat", SUN: "Sun" };
  const meeting = section.meeting || {};
  const start = timeLabel(meeting.startTime);
  const end = timeLabel(meeting.endTime);
  const days = (meeting.days || []).map(day => weekdays[day] || day).join("/");
  let time = "meeting time unavailable";
  if (start && end) {
    const startClock = start.period === end.period ? start.clock : `${start.clock} ${start.period}`;
    time = `${startClock}–${end.clock} ${end.period}`;
  }
  return `${showSection ? `Section ${letter}: ` : ""}${days ? `${days}, ` : ""}${time}`;
}

function dateLabel(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return value;
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC", year: "numeric", month: "long", day: "numeric"
  });
}

// Informational projection only. No planner or validator consumes history here.
export function buildEconomicsPlanNotes({ plan, student = {}, mapping, policyBundle, courseCatalog = [] }) {
  const advice = policyBundle.planningAdvice;
  if (!advice || !plan) return [];
  const notes = [];
  const degree = plan.degreeRequirementInformation;
  if (degree?.items?.length) notes.push({ id: "ccr-ace", title: degree.curriculum === "HANOVER_CORE" ? "Hanover Core: Knowledge and Skills" : "College-wide requirements",
    description: degree.curriculum === "HANOVER_CORE" ? "" : `${degree.terminology.ccr} / ${degree.terminology.ace}`,
    items: degree.items.map(item => ({ code: item.code, text: item.detail })) });
  else if (degree?.evidenceStatus === "UNAVAILABLE_FOR_APPLICABLE_GENERAL_DEGREE_CATALOG") {
    notes.push({ id: "ccr-ace", title: "College-wide requirements", items: [{ text:
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
  const seasonLines = ["FALL", "WINTER"].map(term => {
    const codes = [...new Set(observations.filter(row => years.includes(row.academicYear) && row.term === term
      && !allMayCourses.has(row.course) && relevant(row.course)).map(row => row.course))].sort();
    return codes.length ? `Past ${term === "FALL" ? "Fall" : "Winter"} schedules included: ${codes.join(", ")}.` : null;
  }).filter(Boolean);
  if (seasonLines.length) history.push({ text: seasonLines.join(" "), lines: seasonLines });
  if (mayCourses.length) {
    const text = mayCourses.every(code => /^ECO \d{3}$/.test(code))
      ? `ECO ${mayCourses.map(code => code.slice(4)).join(", ")}.`
      : `${mayCourses.join(", ")}.`;
    history.push({ text: `Past May schedules included: ${text}` });
  }
  if (history.length) notes.push({ id: "history", title: "Past Economics course offerings", items: history, caveat: advice.display.caveat });

  const date = student.planCreationDate || plan.planningContext?.planCreationDate;
  const titleByCode = new Map(courseCatalog.map(course => [course.code, course.title]));
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
        `${code}${titleByCode.get(code) ? ` · ${titleByCode.get(code)}` : ""} — ${sections.map(section => sectionLabel(section, sections.length > 1)).join("; ")}`) };
  }).filter(item => item.lines.length);
  if (upcoming.length) notes.push({ id: "upcoming", title: `Published schedules as of the plan date (${dateLabel(date)})`, items: upcoming });

  const future = (plan.terms || []).some(term => term.publicationStatus === "PLANNING_PROJECTION");
  if (future) {
    const items = [{ text: advice.display.future }];
    if (plan.unmetElectiveNeed > 0) items.push({ text: advice.display.adjunct });
    const financeAssignment = (plan.validation?.requirementAllocation?.assignments || [])
      .find(item => item.slotId === "finance");
    const financeCourse = financeAssignment?.code || financeAssignment?.course;
    const financeTerm = (plan.terms || []).find(term => (term.courses || []).some(course =>
      (course.course || course.code) === financeCourse && (course.requirementId === "finance" || financeAssignment)));
    const financeIsProjected = financeTerm?.publicationStatus === "PLANNING_PROJECTION";
    if (financeIsProjected && financeCourse === "BUSN 323") {
      items.push({ text: `This plan places BUSN 323 in ${financeTerm.term}. Its future offering is not confirmed.` });
    } else if (financeIsProjected && financeCourse === "ECO 321") {
      items.push({ text: `This plan places ECO 321 in ${financeTerm.term}. Future adjunct staffing is not confirmed.` });
    } else if (remainingIds.has("finance") && !financeAssignment) {
      items.push({ text: advice.display.finance });
    }
    notes.push({ id: "future", title: "Future years", items });
  }
  return notes;
}

// Shared factual offering information for cards, edit explanations and reports.
// Historical scheduling is neither a prediction nor an eligibility restriction.
export function courseOfferingInformation(course, policyBundle) {
  const code = course.course || course.code;
  if (!code || code === "ECO elective") return null;
  const advice = policyBundle?.planningAdvice;
  const observations = (advice?.observations || []).filter(row => row.course === code
    && (advice.display?.completedAcademicYears || []).includes(row.academicYear));
  if (!observations.length) return null;
  const names = { FALL: "Fall", WINTER: "Winter", MAY: "May", SUMMER: "Summer" };
  const terms = [...new Set(observations.map(row => names[row.term] || row.term))];
  const years = [...new Set(observations.map(row => row.academicYear))].sort();
  return { label: code === "ECO 461" ? "ECO 461 is offered only in Winter." : `Previously offered in ${terms.length === 2 ? terms.join(" and ") : terms.join(", ")}.`,
    detail: `Scheduled in ${years.join(", ")}. Past schedules do not confirm a future offering.`,
    sourceRefs: advice.sourceRefs || [], observations };
}
