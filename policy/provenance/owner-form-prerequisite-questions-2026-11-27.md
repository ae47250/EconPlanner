# Owner decision: the course form keeps only its prerequisite questions — November 27, 2026

Authority: project owner, explicit choice ("option a") in the clean-up session dated 2026-11-27, on the item "one prerequisite checker instead of two". Effective from 2026-11-27 with no end date. Code clean-up; no change to what students are asked or which plans they get. One visible difference: an empty prerequisite box that used to appear under a course with an approved same-term pairing (for example ECO 213 and MAT 121 both Taking now) no longer appears.

Finding: a full merge is not possible as first described. The form's checker runs in the browser and asks its questions instantly; the server's checker (lib/decision-engine/prerequisites.js) reads rule files from disk, which a browser cannot. Option (b), asking the server on every course click, was not chosen.

Decision (option a): lib/planning/prerequisiteFormValidation.js now only decides which prerequisite questions to show. Removed: its "blocked" path (it always passed), the conflict message that could never appear, its unused approval sentences, the unused `selectedStatus`, and the screen code that depended on them (app/page.js, app/components/plannerSummary.js). Also removed an unused import left in lib/reports/economics-html.js by #97. Whether prerequisites are met is decided once, on the server.

Check: old and new question builders gave identical questions in 960,000 generated course combinations (all 16 prerequisite rules, all three statuses).
