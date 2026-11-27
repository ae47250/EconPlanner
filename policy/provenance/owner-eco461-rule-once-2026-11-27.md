# Owner decision: the ECO 461 rule lives in one place — November 27, 2026

Authority: project owner, explicit approval ("Go") of the clean-up outline in the session dated 2026-11-27. Effective from 2026-11-27 with no end date. Code clean-up; the academic rule itself is unchanged (see owner-eco461-completed-2026-11-25.md).

Change: the course form (app/page.js) had its own copy of the ECO 461 rule (seniors only; "Taking now" only during a Winter term). It now calls `hanoverOnlyStatusAllowed` in lib/planning/hanover-only-courses.js, the same rule the server applies. The form's copy was deleted.

One difference: when a saved file holds an invalid plan date (not possible by typing; the date field only accepts real dates), the form no longer offers "Completed" for ECO 461. The server already dropped that mark, so the form now matches the server.

Check: old form rule, new shared rule and server compared in 6,888 cases; the only differences are the invalid-date cases above.
