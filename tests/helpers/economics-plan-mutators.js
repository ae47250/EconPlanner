const PROJECTED_SOURCE = "projected-offering";

export const ECONOMICS_PLAN_MUTATION_IDS = Object.freeze([
  "PREREQUISITE_AFTER_DEPENDENT",
  "ECO_113_CONCURRENT_WITH_ECO_213",
  "ECO_114_CONCURRENT_WITH_ECO_214",
  "APPROVAL_METADATA_MISSING",
  "APPROVAL_AUTHORITY_WRONG",
  "APPROVAL_COURSE_WRONG",
  "APPROVAL_PREREQUISITE_WRONG",
  "APPROVAL_TERM_WRONG",
  "ECO_461_IN_FALL",
  "ECO_461_BELOW_SENIOR_STANDING",
  "ECO_461_RESIDENCY_CHANGED",
  "STATISTICS_CONCURRENT_WITH_ECO_461",
  "FIFTH_FALL_WINTER_COURSE",
  "SECOND_SPRING_MAY_COURSE",
  "CLOSED_SECTION",
  "DIRECT_MEETING_CONFLICT",
  "FALSIFIED_CANONICAL_MEETING",
  "FALSIFIED_AVAILABILITY",
  "ECO_321_DOUBLE_COUNTED",
  "ECO_257_ASSIGNED_TO_ELECTIVE",
  "ECO_257_ELECTIVE_AFTER_OTHER_STATISTICS",
  "SECOND_100_LEVEL_ELECTIVE",
  "COMPLETED_COURSE_RESCHEDULED",
  "TERM_AFTER_GRADUATION"
]);

function clone(value) {
  return structuredClone(value);
}

function fail(message) {
  throw new Error(`Economics plan mutator: ${message}`);
}

function findTerm(draft, slotId) {
  const term = draft.plan.terms.find(item => item.slotId === slotId);
  if (!term) fail(`missing term ${slotId}`);
  return term;
}

function findCourse(draft, code, requirementId = null) {
  const matches = draft.plan.terms.flatMap(term => (
    term.courses
      .filter(course => course.course === code && (!requirementId || course.requirementId === requirementId))
      .map(course => ({ term, course }))
  ));
  if (matches.length !== 1) {
    fail(`expected one ${code}${requirementId ? `/${requirementId}` : ""}; found ${matches.length}`);
  }
  return matches[0];
}

function removeCourse(draft, code, requirementId = null) {
  const located = findCourse(draft, code, requirementId);
  located.term.courses = located.term.courses.filter(course => course !== located.course);
  return located.course;
}

function projectedPlacement(course) {
  const result = {
    course: course.course,
    requirementId: course.requirementId,
    title: course.title || course.course,
    units: Number.isFinite(course.units) ? course.units : 1,
    source: PROJECTED_SOURCE,
    offeringStatus: "projected",
    verificationStatus: "unverified",
    crossListedAs: [...(course.crossListedAs || [])],
    availability: { status: "unknown" },
    meeting: {
      days: [],
      startTime: null,
      endTime: null,
      startDate: null,
      endDate: null
    }
  };
  if (course.residency) result.residency = course.residency;
  if (course.approvalRequired) result.approvalRequired = clone(course.approvalRequired);
  return result;
}

function moveCourse(draft, code, targetSlotId, { requirementId = null, projected = false } = {}) {
  const course = removeCourse(draft, code, requirementId);
  findTerm(draft, targetSlotId).courses.push(projected ? projectedPlacement(course) : course);
}

function replaceCourse(draft, oldCode, nextCode, requirementId) {
  const located = findCourse(draft, oldCode, requirementId);
  located.course.course = nextCode;
  located.course.title = nextCode;
  located.course.source = PROJECTED_SOURCE;
  located.course.offeringStatus = "projected";
  located.course.verificationStatus = "unverified";
  located.course.crossListedAs = [];
  located.course.availability = { status: "unknown" };
  located.course.meeting = {
    days: [],
    startTime: null,
    endTime: null,
    startDate: null,
    endDate: null
  };
  delete located.course.section;
  delete located.course.provenance;
}

function approvalForCapstone(draft) {
  const { course } = findCourse(draft, "ECO 461", "eco-461");
  if (!Array.isArray(course.approvalRequired) || course.approvalRequired.length !== 1) {
    fail("concurrent capstone baseline must contain exactly one attached approval");
  }
  return course.approvalRequired[0];
}

function replaceVerifiedSection(draft, code, section) {
  const key = `${code}:${section}`;
  const template = draft.verifiedCourseTemplates?.[key];
  if (!template) fail(`missing verified template ${key}`);
  const located = findCourse(draft, code);
  const requirementId = located.course.requirementId;
  const residency = located.course.residency;
  located.term.courses = located.term.courses.map(course => (
    course === located.course
      ? {
          ...clone(template),
          requirementId,
          ...(residency ? { residency } : {})
        }
      : course
  ));
}

function retargetOnlyTerm(draft, {
  academicYear,
  term,
  termKey,
  slotId,
  absoluteStandingIndex
}) {
  if (draft.plan.terms.length !== 1) fail("expected a single-term capstone baseline");
  const target = draft.plan.terms[0];
  target.academicYear = academicYear;
  target.term = term;
  target.displayTerm = termKey;
  target.termKey = termKey;
  target.scheduleTerm = termKey;
  target.slotId = slotId;
  target.absoluteStandingIndex = absoluteStandingIndex;
}

const MUTATORS = Object.freeze({
  PREREQUISITE_AFTER_DEPENDENT(draft) {
    moveCourse(draft, "ECO 113", "winter-2029", { projected: true });
  },

  ECO_113_CONCURRENT_WITH_ECO_213(draft) {
    moveCourse(draft, "ECO 113", "fall-2028", { projected: true });
  },

  ECO_114_CONCURRENT_WITH_ECO_214(draft) {
    moveCourse(draft, "ECO 114", "winter-2028", { projected: true });
  },

  APPROVAL_METADATA_MISSING(draft) {
    const { course } = findCourse(draft, "ECO 461", "eco-461");
    delete course.approvalRequired;
  },

  APPROVAL_AUTHORITY_WRONG(draft) {
    approvalForCapstone(draft).authority = "Registrar";
  },

  APPROVAL_COURSE_WRONG(draft) {
    approvalForCapstone(draft).course = "ECO 214";
  },

  APPROVAL_PREREQUISITE_WRONG(draft) {
    approvalForCapstone(draft).prerequisite = "ECO 213";
  },

  APPROVAL_TERM_WRONG(draft) {
    approvalForCapstone(draft).term = "Fall 2026";
  },

  ECO_461_IN_FALL(draft) {
    retargetOnlyTerm(draft, {
      academicYear: "2027/2028",
      term: "Fall 2027",
      termKey: "Fall",
      slotId: "fall-2027",
      absoluteStandingIndex: 3
    });
  },

  ECO_461_BELOW_SENIOR_STANDING(draft) {
    retargetOnlyTerm(draft, {
      academicYear: "2027/2028",
      term: "Winter 2028",
      termKey: "Winter",
      slotId: "winter-2028",
      absoluteStandingIndex: 2
    });
  },

  ECO_461_RESIDENCY_CHANGED(draft) {
    findCourse(draft, "ECO 461", "eco-461").course.residency = "transfer";
  },

  STATISTICS_CONCURRENT_WITH_ECO_461(draft) {
    moveCourse(draft, "MAT 217", "winter-2029");
  },

  FIFTH_FALL_WINTER_COURSE(draft) {
    moveCourse(draft, "ECO 234", "fall-2028", { projected: true });
  },

  SECOND_SPRING_MAY_COURSE(draft) {
    moveCourse(draft, "ECO 260", "spring-2028");
  },

  CLOSED_SECTION(draft) {
    replaceVerifiedSection(draft, "ECO 114", "A");
  },

  DIRECT_MEETING_CONFLICT(draft) {
    replaceVerifiedSection(draft, "ECO 114", "B");
  },

  FALSIFIED_CANONICAL_MEETING(draft) {
    const meeting = findCourse(draft, "ECO 114", "eco-114").course.meeting;
    meeting.startTime = "1:00 PM";
    meeting.startMinutes = 780;
  },

  FALSIFIED_AVAILABILITY(draft) {
    const availability = findCourse(draft, "ECO 114", "eco-114").course.availability;
    availability.seatsOpen = Number(availability.seatsOpen || 0) + 7;
  },

  ECO_321_DOUBLE_COUNTED(draft) {
    replaceCourse(draft, "BUSN 323", "ECO 321", "finance");
    replaceCourse(draft, "ECO 337", "ECO 321", "eco-elective-4");
  },

  ECO_257_ASSIGNED_TO_ELECTIVE(draft) {
    replaceCourse(draft, "ECO 337", "ECO 257", "eco-elective-4");
  },

  ECO_257_ELECTIVE_AFTER_OTHER_STATISTICS(draft) {
    replaceCourse(draft, "ECO 257", "MAT 217", "statistics");
    replaceCourse(draft, "ECO 337", "ECO 257", "eco-elective-4");
  },

  SECOND_100_LEVEL_ELECTIVE(draft) {
    replaceCourse(draft, "ECO 337", "ECO 160", "eco-elective-4");
  },

  COMPLETED_COURSE_RESCHEDULED(draft) {
    const completed = draft.student.courses.filter(course => course.code === "ECO 260");
    if (completed.length !== 1) fail(`expected one completed ECO 260; found ${completed.length}`);
    completed[0].code = "ECO 234";
  },

  TERM_AFTER_GRADUATION(draft) {
    retargetOnlyTerm(draft, {
      academicYear: "2028/2029",
      term: "Winter 2029",
      termKey: "Winter",
      slotId: "winter-2029",
      absoluteStandingIndex: 4
    });
  }
});

export function mutateEconomicsPlanCase(baseCase, mutationId) {
  const mutate = MUTATORS[mutationId];
  if (!mutate) fail(`unknown mutation ${mutationId}`);
  const draft = clone(baseCase);
  mutate(draft);
  draft.plan.id = `${baseCase.plan.id}--${mutationId.toLowerCase()}`;
  return draft;
}
