import { canonicalTerm, canonicalTermId } from "../decision-engine/placement.js";
import { normalizeStudentCourses } from "../requirements/normalize.js";
import { electivePlaceholderMinimumLevel } from "../policy/requirement-choices.js";

// Software contract: policy/provenance/extra-courses-contract-2026-10-17.md.
// Extra identities never allocate credit to a degree requirement.
export function extraCourseError(course, bundle) {
  if (course.extra !== true) return null;
  if (!/^extra-economics-[1-9]\d*$/.test(course.requirementId || "") || course.fixedInProgress) {
    return "An Extra course needs its own placement identity and cannot replace a required course.";
  }
  if (course.course === "ECO elective") {
    return course.minimumLevel === electivePlaceholderMinimumLevel(bundle) ? null : "Choose a 200+ Economics elective for this extra placement.";
  }
  return /^ECO \d{3}$/.test(course.course || "") && bundle.indexes.coursesByCode[course.course]
    ? null : "Choose an Economics course from the catalog.";
}

export function nextExtraCourseId(plan) {
  const ids = new Set(plan.terms.flatMap(term => term.courses.map(course => course.requirementId)));
  let number = 1;
  while (ids.has(`extra-economics-${number}`)) number += 1;
  return `extra-economics-${number}`;
}

// Exact sections are selectable candidates, subject to complete validation.
// Historical observations are display-only and cannot authorize a named future
// placement. The future selectable choice remains a generic elective.
export function extraCourseChoices({ plan, term, student, policyBundle, courseCatalog = [] }) {
  const used = new Set([
    ...normalizeStudentCourses(student.courses).filter(course => ["completed", "transfer", "in_progress"].includes(course.status)).map(course => course.code),
    ...plan.terms.flatMap(item => item.courses.map(course => course.course))
  ]);
  const exact = policyBundle.indexes.offeringByTerm[canonicalTermId(term)];
  const titles = new Map(courseCatalog.map(course => [course.code, course.title]));
  const candidates = exact ? [...new Set(exact.sections.map(section => section.course))]
    .filter(code => /^ECO \d{3}$/.test(code) && !used.has(code))
    .sort().map(course => ({ course, title: titles.get(course) || "", evidence: "published" }))
    : term.isSummer || term.isPlaceholder ? [] : [{ course: "ECO elective", title: "Choose the course later", evidence: "unpublished" }];
  const advice = policyBundle.planningAdvice;
  const history = exact ? [] : [...new Set((advice?.observations || []).filter(row =>
    row.term === canonicalTerm(term.termKey) && advice.display.completedAcademicYears.includes(row.academicYear)
    && !used.has(row.course)).map(row => row.course))].sort()
    .map(course => ({ course, title: titles.get(course) || "" }));
  return { candidates, history };
}
