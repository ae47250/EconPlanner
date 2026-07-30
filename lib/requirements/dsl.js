const NODE_TYPES = new Set([
  "ALL_OF",
  "ANY_OF",
  "CHOOSE_N",
  "EXACT_COURSE",
  "COURSE_SET",
  "MINIMUM_UNITS",
  "LEVEL_RESTRICTION",
  "SUBJECT_FILTER",
  "EXCLUSION",
  "COGNATE",
  "CAPSTONE",
  "GRADE_RULE",
  "RESIDENCY_RULE",
  "NON_COURSE_MILESTONE",
  "PERMISSION_REQUIREMENT",
  "ELECTIVE"
]);

function combinations(items, count) {
  if (count === 0) return [[]];
  if (count > items.length) return [];
  const output = [];
  function visit(start, selected) {
    if (selected.length === count) {
      output.push([...selected]);
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      selected.push(items[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  }
  visit(0, []);
  return output;
}

function cartesian(parts) {
  return parts.reduce((all, choices) => all.flatMap(prefix => choices.map(choice => [...prefix, ...choice])), [[]]);
}

function codeOptions(node) {
  return (node.options || node.courses || node.courseCodes || [node.code])
    .filter(Boolean)
    .map(value => String(value).toUpperCase().replace(/^(\w+)\s*-?\s*(\d{3})$/, "$1 $2"));
}

function leafSlot(node, id) {
  const type = String(node.type || "").toUpperCase();
  const options = codeOptions(node);
  const slot = {
    id: node.id || id,
    label: node.label || node.name || options.join(" / ") || type,
    kind: type === "EXACT_COURSE" ? "exact" : type === "COURSE_SET" || type === "COGNATE" ? "choice" : type === "NON_COURSE_MILESTONE" || type === "PERMISSION_REQUIREMENT" ? "milestone" : "elective",
    options,
    units: Number(node.units ?? node.minimumUnits ?? 1),
    sourceRefs: node.sourceRefs || [],
    allowOverlap: Boolean(node.allowOverlap),
    excludedCourses: node.excludedCourses || node.exclusions || [],
    preferredOptions: node.preferredOptions || [],
    conditionalCourses: node.conditionalCourses || {},
    subject: node.subject,
    minLevel: node.minLevel,
    maxLevel: node.maxLevel,
    maxLevel100: node.maxLevel100,
    minGrade: node.minGrade,
    residency: node.residency,
    requiresApproval: Boolean(node.requiresApproval || type === "PERMISSION_REQUIREMENT"),
    milestone: type === "NON_COURSE_MILESTONE" || type === "PERMISSION_REQUIREMENT"
  };

  if (type === "MINIMUM_UNITS" && options.length && slot.units > 1) {
    slot.kind = "course_set";
  }
  if (type === "GRADE_RULE" || type === "RESIDENCY_RULE" || type === "LEVEL_RESTRICTION" || type === "SUBJECT_FILTER" || type === "EXCLUSION") {
    slot.kind = "elective";
  }
  return slot;
}

export function expandRequirementExpression(expression, prefix = "requirement") {
  if (!expression || typeof expression !== "object") return [];
  const type = String(expression.type || "").toUpperCase();
  if (!NODE_TYPES.has(type)) throw new Error(`Unsupported requirement expression type: ${type || "unknown"}`);

  if (type === "ALL_OF") return cartesian((expression.children || []).map((child, index) => expandRequirementExpression(child, `${prefix}-${index + 1}`)));
  if (type === "ANY_OF") return (expression.children || []).flatMap((child, index) => expandRequirementExpression(child, `${prefix}-choice-${index + 1}`));
  if (type === "CHOOSE_N") {
    const children = expression.children || [];
    return combinations(children, Number(expression.n)).flatMap((chosen, choiceIndex) => {
      return cartesian(chosen.map((child, childIndex) => expandRequirementExpression(child, `${prefix}-choose-${choiceIndex + 1}-${childIndex + 1}`)));
    });
  }
  return [[leafSlot(expression, prefix)]];
}

export function normalizeRequirementConfig(config = {}) {
  if (Array.isArray(config.requirementPlans) && config.requirementPlans.length) return config;
  if (Array.isArray(config.requirementSlots) && config.requirementSlots.length) {
    return { ...config, requirementPlans: [config.requirementSlots] };
  }
  const plans = expandRequirementExpression(config.requirementTree || config.expression, config.id || "requirement");
  return { ...config, requirementPlans: plans, requirementSlots: plans[0] || [] };
}
