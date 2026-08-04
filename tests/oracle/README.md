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

## Verified schedule snapshot

`verified-schedule-2026-2027.json` is a test-owned, independently reviewed transcription of the repository's source schedule screenshots. It is not generated from `data/normalized/economics/schedule-2026-2027.json`, and the drift test must never rewrite it.

The source filenames do not match their visible contents: `schedule-2026-2027-winter-spring.png` contains the Fall rows, while `schedule-2026-2027-fall.png` visibly contains the Winter and May rows. Reviewers must inspect the image contents rather than trusting the filenames. The screenshots do not visibly supply a verification date, so the snapshot records that field as `null` and lists it in each row's `unknownFields`.

### Row-by-row review and update procedure

1. Obtain the official schedule export or complete, legible screenshots and store the evidence outside the oracle snapshot. Do not begin with production normalized JSON.
2. Open each source artifact and verify its hash. Read every visible row separately, checking academic year, term, course, section, title, units, dates, meeting days and times, availability, and seats/capacity.
3. Record only values visible in authoritative evidence. Set a missing value to `null`, add its field name to `unknownFields`, and retain the exact source path. Use the raw Economics requirements source for a canonical cross-list identity that is not printed in the schedule row.
4. Have an independent reviewer repeat the comparison, then update the snapshot's review date, reviewer, evidence hashes, and rows. Keep unchanged section identities stable.
5. Run `node --test tests/economics-schedule-drift.test.js`. Treat every added, removed, or changed section as a review failure. Investigate the evidence and production data; never copy production values into the oracle merely to make the test pass.
6. If authoritative evidence changes, update the oracle row by row and document the review before any separate production-data correction. Run the policy-manifest test, full test suite, lint, and `git diff --check` afterward.

Task 2 adds schedule evidence only. The independent plan-audit implementation remains a later task.
