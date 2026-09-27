// Presentation only: choices come from compiled requirements supplied by the caller.
export function requirementFormGroups(requirements, courseTitle = code => code) {
  const presentation = [
    { requirementId: 'cognate', id: 'math-requirement', title: 'Required math course' },
    { requirementId: 'statistics', id: 'statistics-requirement', title: 'Choose a statistics course' },
    { requirementId: 'finance', id: 'finance-requirement', title: 'Choose a money and finance course' }
  ];
  return presentation.map(({requirementId, ...display}) => {
    const codes = requirements.requirementSlots.find(slot => slot.id === requirementId)?.options || [];
    return { ...display, code: codes.join(' / '), courseCodes: [...codes], options: codes.map(code => ({code, title: courseTitle(code)})) };
  });
}
