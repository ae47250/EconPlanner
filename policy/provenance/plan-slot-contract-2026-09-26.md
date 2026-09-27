# Submitted elective-slot contract — September 26, 2026

## Authority and scope

The project owner explicitly adopted this software plan contract in the September 26, 2026 repair task: “within each submitted plan, each elective slot has at most one assigned course. Two courses claiming eco-elective-1 are malformed even if another allocation works.”

This is task authorization for the submitted-plan representation, not a new academic rule or an attribution to the college or department. It takes effect for plan validation on September 26, 2026. The four-elective requirement, eligibility, completeness, and course/placeholder no-double-count rules are unchanged.

## Contract

Each declared elective requirement slot in a submitted plan may be assigned at most once across that plan's terms. Independently valid alternatives may reuse the same slot IDs. Unlabeled raw course history is not a submitted slot assignment and is outside this uniqueness check. Swapping distinct slot assignments while retaining all courses and terms is permitted when the existing academic rules remain satisfied.

An auditor must report a duplicate declared assignment; finding some other valid allocation does not repair the submitted plan. The Oracle must check this contract independently, while retaining its independent allocation/completeness and no-double-count checks.

## Supersession

This resolves the previously recorded production/Oracle disagreement about duplicate elective requirement IDs. It supersedes the interpretation that an auditor may silently treat duplicate declared slot IDs as interchangeable. It does not supersede any academic eligibility rule or schedule evidence.
