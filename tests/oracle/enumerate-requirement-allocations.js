function matches(slot, course) {
  if (slot.kind === "exact" || slot.kind === "choice" || slot.kind === "course_set") return (slot.options || []).includes(course.code);
  if (slot.kind !== "elective") return false;
  return course.code.startsWith(`${slot.subject || "ECO"} `) && !(slot.excludedCourses || []).includes(course.code);
}

function signature(assignments) {
  return assignments.map(item => `${item.slotId}=${item.code}`).sort().join("|");
}

export function independentlyEnumerateMaximalAllocations(slots = [], courses = []) {
  const orderedSlots = [...slots].sort((left, right) => left.id.localeCompare(right.id));
  const orderedCourses = [...courses].sort((left, right) => left.code.localeCompare(right.code));
  let maximum = -1;
  const found = new Set();

  function visit(index, assignments, used) {
    if (index === orderedSlots.length) {
      if (assignments.length > maximum) {
        maximum = assignments.length;
        found.clear();
      }
      if (assignments.length === maximum) found.add(signature(assignments));
      return;
    }
    const slot = orderedSlots[index];
    visit(index + 1, assignments, used);
    for (const course of orderedCourses) {
      if (used.has(course.code) || !matches(slot, course)) continue;
      if (slot.conditionalCourses?.[course.code]) {
        const condition = slot.conditionalCourses[course.code];
        if (!assignments.some(item => item.slotId === condition.slotId && item.code === condition.assignedCode)) continue;
      }
      assignments.push({ slotId: slot.id, code: course.code });
      used.add(course.code);
      visit(index + 1, assignments, used);
      used.delete(course.code);
      assignments.pop();
    }
  }

  visit(0, [], new Set());
  return [...found].sort();
}
