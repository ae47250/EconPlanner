# Economics policy maintenance

Maintain current academic meaning here. Raw evidence and dated review documents are sources, not additional live rulebooks. Runtime consumes generated bundles, not knowledge Markdown.

| Fact | Maintained source |
| --- | --- |
| Course identity and cross-lists | [Course registry](courses/economics.json) |
| Requirements and prerequisites | [Requirements](requirements/economics-2025-2026.json), [prerequisites](rules/prerequisites.json), [allocation](rules/requirement-allocation.json) |
| May projections and independent capstone restrictions | [Term rules](rules/terms-load-graduation.json) |
| Intermediate pair and named recurring evidence | [Offering patterns](offering-patterns/economics.json) |
| Future schedule flexibility | [Planning flexibility](rules/planning-flexibility.json), referencing the term rules |
| Verified and preliminary schedule facts | [Exact release](schedules/2026-2027.json), [preliminary releases](schedules/preliminary.json) |
| Historical observations and approval thresholds | [Historical contract](historical-offerings/economics.json) |
| Authority, dates and supersession | [Source registry](provenance/sources.json), [September 26 consolidation](provenance/offering-policy-2026-09-26.md) |

Each fact has one maintained definition. Regenerate derived data with `pnpm run compile:policy` and `pnpm run compile:catalog-policy`; never update compiled or normalized mirrors by hand. Confirm the same decision in generation, cards, direct edits, saved-plan validation and reports, and independently in the Oracle. Historical frequency alone creates no exclusion or promise of availability.

The [September 26 submitted-slot contract](provenance/plan-slot-contract-2026-09-26.md) governs declared elective assignments per plan; it does not change academic eligibility.

The [September 27 owner decisions](provenance/canonical-consumption-2026-09-27.md) supersede the blanket current-term exclusion and accelerated-standing confirmation gate. `PREREQ-ECO-461` alone owns statistics timing; the retired record remains marked `SUPERSEDED` for provenance.

`rules/planning-flexibility.json` selects the active flexibility release. The catalog compiler writes the version named by `policyVersion`, updates `data/compiled/policy/planning-flexibility/active.json`, and removes older versioned flexibility folders. Browser eligibility, server readers, fingerprints and diagnostic artifact references use the active selection.

Only the current flexibility release remains as compiled output with its provenance source; provenance versions 3 through 15 have been removed. Old raw department evidence remains historical. Catalog releases and their original comparison-baseline hash are unchanged; that recorded hash is not a runtime policy pin.
