# Economics test-oracle policy

`economics-policy.v1.json` is the independent policy source for EconPlanner tests. It records only rules supported by the raw Hanover Economics sources named in the manifest. It must not import or copy decisions at runtime from the production planner, normalized production data, or production validators.

The manifest separates confirmed rules from unresolved questions. A review-required entry is not permission for a test oracle to guess an answer or enforce one interpretation. Until written confirmation is available, the future oracle must return the entry's review status and explain what needs confirmation.

## Updating the manifest

1. Check the current Hanover catalog and official Economics material first. Use verified schedule evidence for schedule facts and the department policy record for documented local exceptions.
2. Keep existing `ruleId` values stable. Add a new ID for a genuinely new rule; never reuse an old ID for a different meaning.
3. Change a review-required entry to `CONFIRMED` only after the answer and its authority are documented in a source file.
4. Add or update the source reference, confirmation record, confirmation date, and reviewer for every confirmed rule.
5. Increase `policy.version` for any substantive rule change. Increase `schemaVersion` only when the JSON structure changes.
6. Run `node --test tests/economics-policy-manifest.test.js`, then the full test and lint commands before accepting the update.

Task 1 intentionally contains no verified schedule rows and no independent plan-audit code. Those are separate, later tasks so policy review, schedule review, and oracle behavior can be checked independently.
