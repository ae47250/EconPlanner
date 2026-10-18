// Placement and alternative identities are academic inputs. Editing controls
// and previous validation results are derived output, rebuilt by the server.
// Do not send/copy their large decision trees through every validation request.
export function compactEconomicsPlanForValidation(plan) {
  if (!plan || !Array.isArray(plan.terms)) return plan;
  const { validation: _validation, ...input } = plan;
  return { ...input, terms: plan.terms.map(term => ({ ...term,
    courses: (term.courses || []).map(course => {
      const { replacementDestinationOptions: _replacements, offeringInformation: _offeringInformation, moveDestinationOptions: _moves, moveDestinationIds: _ids,
        moveNoAlternativeNotice: _moveNotice, moveGuidance: _guidance,
        replacementNotice: _replacement, ...placement } = course;
      if (Array.isArray(placement.alternativeOptions)) placement.alternativeOptions = placement.alternativeOptions.map(option => {
        const { loadDecision: _load, tuitionAdvisories: _tuition, message: _message,
          status: _status, ruleId: _rule, sourceRefs: _refs, ...alternative } = option;
        return alternative;
      });
      return placement;
    })
  })) };
}
