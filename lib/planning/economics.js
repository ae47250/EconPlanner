import { normalizeStudentCourses } from "../requirements/normalize.js";

const TERM_ORDER = ["Fall", "Winter", "May"];

function offeredCourse(schedule, term, code) {
  return (schedule?.terms?.[term] || []).find(course => course.course === code) || null;
}

function prerequisiteMissing(code, completedCodes, prerequisites) {
  const rule = prerequisites?.[code];
  if (!rule) return [];
  const missing = (rule.all || []).filter(item => !completedCodes.has(item));
  for (const group of rule.any || []) {
    if (!group.some(item => completedCodes.has(item))) missing.push(group.join(" / "));
  }
  return missing;
}

function isSeniorWinterOnly(code) {
  return code === "ECO 461";
}

export function buildEconomicsTermPlan({ student = {}, mapping, schedule, prerequisites = {} }) {
  const courses = normalizeStudentCourses(student.courses);
  const completedCodes = new Set(courses.filter(course => ["completed", "transfer", "in_progress"].includes(course.status)).map(course => course.code));
  const scheduledCodes = new Set(completedCodes);
  const termPlans = TERM_ORDER.map(term => ({ term, courses: [] }));
  const unscheduled = [];
  const advisorChecks = [];
  const standing = String(student.academicStanding || "").toLowerCase();

  for (const item of mapping?.optimistic?.unresolved || []) {
    const slot = (mapping.requirements || []).find(requirement => requirement.id === item.requirementId);
    if (!slot) continue;
    if (slot.kind === "elective") {
      unscheduled.push({ requirementId: slot.id, label: slot.label, course: "ECO elective", reason: "Future exact offering is not verified; choose an eligible ECO elective with an advisor." });
      continue;
    }

    const options = slot.options || [];
    let placed = false;
    for (const code of options) {
      if (scheduledCodes.has(code)) continue;
      for (const term of TERM_ORDER) {
        if (isSeniorWinterOnly(code) && term !== "Winter") continue;
        if (isSeniorWinterOnly(code) && standing && standing !== "senior") continue;
        const offering = offeredCourse(schedule, term, code);
        if (!offering) continue;
        if (term === "May" && termPlans.find(plan => plan.term === term).courses.length >= 1) continue;
        const availableBeforeTerm = new Set(completedCodes);
        for (const earlierPlan of termPlans.slice(0, TERM_ORDER.indexOf(term))) {
          for (const earlierCourse of earlierPlan.courses) availableBeforeTerm.add(earlierCourse.course);
        }
        const missing = prerequisiteMissing(code, availableBeforeTerm, prerequisites);
        if (missing.length) {
          advisorChecks.push({ course: code, term, reason: `Prerequisites must be completed before this course: ${missing.join("; ")}` });
          continue;
        }
        const plan = termPlans.find(item => item.term === term);
        plan.courses.push({ ...offering, requirementId: slot.id, source: "verified-offering" });
        scheduledCodes.add(code);
        placed = true;
        break;
      }
      if (placed) break;
    }
    if (!placed) {
      unscheduled.push({ requirementId: slot.id, label: slot.label, course: options.join(" / ") || slot.label, reason: "No safe verified term placement under the current prerequisites and schedule." });
    }
  }

  const fallCodes = new Set(termPlans.find(plan => plan.term === "Fall").courses.map(course => course.course));
  const winterCodes = new Set(termPlans.find(plan => plan.term === "Winter").courses.map(course => course.course));
  if ((fallCodes.has("ECO 213") && fallCodes.has("ECO 214")) || (winterCodes.has("ECO 213") && winterCodes.has("ECO 214"))) {
    advisorChecks.push({ course: "ECO 213 / ECO 214", reason: "These courses cannot share a term." });
  }
  if (termPlans.find(plan => plan.term === "May").courses.length > 1) {
    advisorChecks.push({ course: "May Term", reason: "May Term is limited to one total course." });
  }

  return {
    academicYear: schedule?.academicYear || null,
    terms: termPlans,
    unscheduled,
    advisorChecks,
    rules: [
      "Prerequisites must precede dependent courses.",
      "ECO 213 and ECO 214 cannot share a term or be placed in May.",
      "ECO 461 is Senior Winter only.",
      "May Term has at most one total course."
    ]
  };
}
