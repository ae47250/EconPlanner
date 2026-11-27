// Swapping the Finance, Statistics and math choices (owner decision 2026-11-27,
// policy/provenance/owner-course-swaps-2026-11-27.md).
// Pass rules, written before the code:
// 1. A swap is offered only for a course in the requirement's own choice list (read from policy), and
//    applying an allowed swap returns a valid plan with that requirement changed and every other course in place.
// 2. On the 2024-25 catalog, swapping to BUSN 323 adds the petition note; swapping back to ECO 321 removes it.
// 3. Statistics in ECO 461's term is blocked. The student is told to choose an earlier term, and is told to move
//    ECO 461 later only when the plan has a later Winter for it (a fifth-year plan).
// 4. Every blocked swap has a plain reason, which the menu shows when nothing else is usable.
// 5. After a swap, the PDF prints the same status sentence and petition note as the screen.
// 6. A saved swapped plan, checked again, comes back with the same courses in the same terms.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POST } from "../app/api/majors/map/route.js";
import { loadCatalog } from "../lib/catalog/load.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { planningRequirementsNote } from "../lib/catalog/planning-requirements-note.js";
import { planStatusExplanation } from "../lib/planning/plan-display.js";
import { studentDisplayMessages, studentFriendlyUnavailableReason } from "../lib/planning/student-language.js";
import { compactEconomicsPlanForValidation } from "../lib/planning/validation-payload.js";
import { runtimePolicyBundle } from "../lib/policy/compat-normalized.js";

const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
const messages = studentDisplayMessages(runtimePolicyBundle());
const usable = option => ["ALLOWED", "CONDITIONAL"].includes(option.status);
const visibleText = html => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const placements = plan => plan.terms.flatMap(term => term.courses.map(course => `${term.slotId}:${course.requirementId}:${course.course}`)).sort();

async function post(body) {
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: response.status, data: await response.json() };
}
function sophomore(catalogYear) {
  return { planCreationDate: "2026-11-21", academicStanding: "sophomore", majorDeclarationCatalogYear: catalogYear,
    courses: [{ code: "ECO 113", status: "completed" }, { code: "ECO 114", status: "completed" }] };
}
async function plansFor(student) {
  const { status, data } = await post({ student });
  assert.equal(status, 200, JSON.stringify(data).slice(0, 300));
  return data.programs[0];
}
function find(plan, requirementId) {
  const term = plan.terms.find(item => item.courses.some(course => course.requirementId === requirementId));
  return { term, course: term.courses.find(course => course.requirementId === requirementId) };
}
async function swap(student, plan, plans, requirementId, option) {
  const { term, course } = find(plan, requirementId);
  return post({ action: "validate-plan", student, plan, plans, edit: { type: "replace-move", fromTermId: term.slotId,
    toTermId: option.toTermId, courseId: course.requirementId, replacementCourse: option.course } });
}
const petition = plan => (planningRequirementsNote(plan.planningContext, plan)?.details || []).find(detail => /petition/i.test(detail)) || null;

test("Finance: ECO 321 can be swapped for BUSN 323, and only to choices from the policy list", async () => {
  const student = sophomore("2025-2026");
  const economics = await plansFor(student);
  const plan = economics.economicsPlans.find(item => item.id === "balanced");
  const { course } = find(plan, "finance");
  assert.equal(course.course, "ECO 321");
  const catalog = await loadCatalog("2025-2026");
  const financeChoices = catalog.economicsRequirements.requirementSlots.find(slot => slot.id === "finance").options;
  const offered = course.replacementDestinationOptions;
  assert.ok(offered.length > 0, "a Finance swap is offered");
  assert.ok(offered.every(option => financeChoices.includes(option.course) && option.course !== "ECO 321"));
  const choice = offered.find(usable);
  assert.ok(choice, "at least one BUSN 323 term passes the plan checks");
  const before = placements(plan);
  const { status, data } = await swap(student, plan, economics.economicsPlans, "finance", choice);
  assert.equal(status, 200, JSON.stringify(data).slice(0, 300));
  assert.notEqual(data.plan.feasibilityStatus, "NOT_FEASIBLE");
  assert.equal(find(data.plan, "finance").course.course, "BUSN 323");
  const unchanged = list => list.filter(item => !item.includes(":finance:"));
  assert.deepEqual(unchanged(placements(data.plan)), unchanged(before), "every other course stays where it was");
});

test("Finance on the 2024-25 catalog: BUSN 323 brings the petition note and ECO 321 removes it", async () => {
  const student = sophomore("2024-2025");
  const economics = await plansFor(student);
  const plan = economics.economicsPlans.find(item => item.id === "balanced");
  assert.equal(petition(plan), null);
  const toBusn = find(plan, "finance").course.replacementDestinationOptions.find(option => option.course === "BUSN 323" && usable(option));
  const swapped = await swap(student, plan, economics.economicsPlans, "finance", toBusn);
  assert.equal(swapped.status, 200);
  assert.match(petition(swapped.data.plan) || "", /BUSN 323.*2024–25.*petition/);
  // Screen and PDF: the same status sentence (which carries the petition reminder) and the same note.
  const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, swapped.data.plan, economics.economicsPlans);
  const printed = visibleText(renderEconomicsHtml(report, template));
  assert.ok(printed.includes(planStatusExplanation(swapped.data.plan, messages)), "the PDF prints the screen's status sentence");
  assert.ok(printed.includes(petition(swapped.data.plan)), "the PDF prints the petition note");
  const back = find(swapped.data.plan, "finance").course.replacementDestinationOptions.find(option => option.course === "ECO 321" && usable(option));
  assert.ok(back, "ECO 321 is offered again");
  const restored = await swap(student, swapped.data.plan, economics.economicsPlans, "finance", back);
  assert.equal(restored.status, 200);
  assert.equal(petition(restored.data.plan), null);
});

test("Statistics: a swap into ECO 461's term is blocked with a plain reason, and other swaps are checked like any change", async () => {
  const student = sophomore("2025-2026");
  const economics = await plansFor(student);
  const plan = economics.economicsPlans.find(item => item.id === "balanced");
  const { course } = find(plan, "statistics");
  const capstoneTerm = find(plan, "eco-461").term.slotId;
  const blocked = course.replacementDestinationOptions.find(option => option.toTermId === capstoneTerm);
  assert.ok(blocked, "a swap into ECO 461's term is listed");
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.dependentCanMoveLater, false, "a four-year plan has no later Winter for ECO 461");
  assert.equal(studentFriendlyUnavailableReason({ ...blocked, movingCourse: blocked.course }, messages),
    `${blocked.course} must come before ECO 461. Choose an earlier term.`);
  const allowed = course.replacementDestinationOptions.find(usable);
  assert.ok(allowed, "an earlier statistics swap passes");
  const { status, data } = await swap(student, plan, economics.economicsPlans, "statistics", allowed);
  assert.equal(status, 200);
  assert.equal(find(data.plan, "statistics").course.course, allowed.course);
  // Reload: the saved plan, checked again, keeps every course where it is.
  const saved = compactEconomicsPlanForValidation(data.plan);
  const reloaded = await post({ action: "validate-plan", student, plan: saved, plans: economics.economicsPlans });
  assert.equal(reloaded.status, 200);
  assert.deepEqual(placements(reloaded.data.plan), placements(data.plan));
});

test("a fifth-year plan may still be told to move ECO 461 later", async () => {
  const student = { planCreationDate: "2026-11-21", academicStanding: "junior", majorDeclarationCatalogYear: "2025-2026",
    customGraduationEnabled: true, customExpectedGraduationYear: 2029,
    courses: ["ECO 113", "ECO 114", "MAT 121"].map(code => ({ code, status: "completed" })) };
  const plan = (await plansFor(student)).economicsPlans.find(item => item.id === "balanced");
  const capstoneTerm = find(plan, "eco-461").term.slotId;
  const blocked = find(plan, "statistics").course.replacementDestinationOptions.find(option => option.toTermId === capstoneTerm);
  assert.equal(blocked?.dependentCanMoveLater, true);
  assert.equal(studentFriendlyUnavailableReason({ ...blocked, movingCourse: blocked.course }, messages),
    `${blocked.course} must come before ECO 461. Move ECO 461 later first.`);
  // Swapping statistics into the last Winter leaves no later Winter for ECO 461, so moving ECO 461 would not help.
  const lastWinter = plan.terms.filter(term => term.termKey === "Winter").at(-1).slotId;
  assert.notEqual(lastWinter, capstoneTerm);
  const intoLast = find(plan, "statistics").course.replacementDestinationOptions.find(option => option.toTermId === lastWinter);
  assert.equal(intoLast?.status, "BLOCKED");
  assert.equal(intoLast.dependentCanMoveLater, false);
  assert.equal(studentFriendlyUnavailableReason({ ...intoLast, movingCourse: intoLast.course }, messages),
    `${intoLast.course} must come before ECO 461. Choose an earlier term.`);
});

test("a swap never offers a course already taken or being taken, or ECO 321 in an unpublished term", async () => {
  const students = [
    { ...sophomore("2025-2026"), courses: [...sophomore("2025-2026").courses, { code: "PSY 217", status: "in_progress" }] },
    { ...sophomore("2024-2025"), courses: [...sophomore("2024-2025").courses, { code: "BUSN 323", status: "completed" }, { code: "MAT 121", status: "completed" }] },
    sophomore("2025-2026")
  ];
  let checked = 0;
  for (const student of students) {
    const taken = new Set(student.courses.map(course => course.code));
    for (const plan of (await plansFor(student)).economicsPlans) {
      for (const term of plan.terms) for (const course of term.courses) {
        for (const option of course.replacementDestinationOptions || []) {
          checked += 1;
          assert.ok(!taken.has(option.course), `${option.course} is already on the student's record`);
          if (option.course === "ECO 321") assert.match(option.toTermId, /-2027$/, "ECO 321 only in the published 2026–27 year");
        }
      }
    }
  }
  assert.ok(checked > 0);
});

test("every blocked swap gets a plain reason the menu can show", async () => {
  // No sample student today has a choice course with no usable swap or move at all; the menu then shows the first
  // blocked option's reason (app/components/courseEditing.js). So every blocked swap must have a plain reason.
  let checked = 0;
  for (const catalogYear of ["2025-2026", "2024-2025"]) {
    for (const plan of (await plansFor(sophomore(catalogYear))).economicsPlans) {
      for (const requirementId of ["finance", "statistics", "cognate"]) {
        for (const option of find(plan, requirementId).course.replacementDestinationOptions.filter(item => item.status === "BLOCKED")) {
          const reason = studentFriendlyUnavailableReason({ ...option, movingCourse: option.course }, messages);
          assert.ok(reason && !/[A-Z]{3,}_[A-Z]|missing prerequisites/.test(reason), `${plan.id} ${option.course} ${option.toTermId}: ${reason}`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 0, "some swaps are blocked in the sample plans");
});

test("a swap is never offered as a stand-in such as \"Statistics requirement\"", async () => {
  // A published year whose schedule lists no statistics course makes the planner use a stand-in; a swap must not offer it.
  const { economicsReplacementCandidates } = await import("../lib/planning/termSolver.js");
  const catalog = await loadCatalog("2025-2026");
  const destination = { slotId: "winter-2027", term: "Winter 2027", academicYear: "2026-2027", termKey: "Winter", scheduleTerm: "Winter",
    absoluteStandingIndex: 2, isSummer: false, courses: [] };
  const options = economicsReplacementCandidates({ course: { course: "MAT 217", requirementId: "statistics" }, destination,
    mapping: { requirements: catalog.economicsRequirements.requirementSlots, assignments: [] },
    schedule: { academicYear: "2026-2027", terms: {} }, courseCatalog: catalog.economicsCourses, policyBundle: catalog.policyBundle,
    plan: { terms: [destination] } });
  assert.deepEqual(options.filter(option => option.source === "requirement-placeholder"), []);
});

test("Statistics on the 2023-24 catalog: PSY 217 brings the petition note, ECO 257 does not", async () => {
  const student = sophomore("2023-2024");
  const economics = await plansFor(student);
  const plan = economics.economicsPlans.find(item => item.id === "balanced");
  assert.equal(petition(plan), null);
  const options = find(plan, "statistics").course.replacementDestinationOptions.filter(usable);
  const psy = await swap(student, plan, economics.economicsPlans, "statistics", options.find(option => option.course === "PSY 217"));
  assert.equal(psy.status, 200);
  assert.match(petition(psy.data.plan) || "", /PSY 217.*2023–24.*petition/);
  const eco = await swap(student, plan, economics.economicsPlans, "statistics", options.find(option => option.course === "ECO 257"));
  assert.equal(eco.status, 200);
  assert.equal(petition(eco.data.plan), null);
});
