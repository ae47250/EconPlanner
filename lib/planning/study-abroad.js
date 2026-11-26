import economicsPlanningConstraints from "../../data/normalized/economics/planning-constraints.json" with { type: "json" };

export function termReservationLimit(slot = {}) {
  const key = slot.termKey === "Spring" ? "May" : slot.termKey;
  const contract = economicsPlanningConstraints.terms?.[key];
  return Math.max(0, Number(contract?.normalCourseUnits ?? contract?.maxTotalCourses ?? 0));
}

export function followingMayId(termId, slots = []) {
  const year = /^winter-(\d{4})$/.exec(String(termId || ""))?.[1];
  const mayId = year ? `spring-${year}` : null;
  return mayId && slots.some(slot => slot.id === mayId) ? mayId : null;
}

export function studyAbroadTermIds(student = {}, slots = []) {
  const termId = student.studyAbroadTerm;
  if (!termId || !slots.some(slot => slot.id === termId)) return [];
  const mayId = student.studyAbroadMayOverlap === true ? followingMayId(termId, slots) : null;
  return mayId ? [termId, mayId] : [termId];
}

export function joinStudyAbroadTerms(labels = []) {
  return labels.map(label => String(label || "").replaceAll("Spring/May", "May")).join(" and ");
}

export function updateStudyAbroadReservation(student, nextTermId, nextMayOverlap, slots) {
  const reservedCourseUnits = { ...(student.reservedCourseUnits || {}) };
  const reservationMemory = { ...(student.reservationMemory || {}) };
  const next = { studyAbroadTerm: nextTermId, studyAbroadMayOverlap: Boolean(nextTermId && nextMayOverlap) };
  const previousMayYear = student.studyAbroadMayOverlap === true
    ? /^winter-(\d{4})$/.exec(String(student.studyAbroadTerm || ""))?.[1] : null;
  const previousIds = [student.studyAbroadTerm, previousMayYear && `spring-${previousMayYear}`].filter(Boolean);
  const nextIds = studyAbroadTermIds(next, slots);
  for (const id of previousIds.filter(id => !nextIds.includes(id))) {
    reservedCourseUnits[id] = Number(reservationMemory[id] || 0);
    delete reservationMemory[id];
  }
  for (const id of nextIds.filter(id => !previousIds.includes(id))) {
    const slot = slots.find(item => item.id === id);
    reservationMemory[id] = Number(reservedCourseUnits[id] || 0);
    reservedCourseUnits[id] = termReservationLimit(slot);
  }
  return { ...student, ...next, reservedCourseUnits, reservationMemory };
}

export function studyAbroadAdvisorContext(student = {}) {
  if (!student.studyAbroadTerm) return [];
  const note = student.studyAbroadAdvisingNote;
  return typeof note === "string" && note.trim() ? [note.trim()] : [];
}
