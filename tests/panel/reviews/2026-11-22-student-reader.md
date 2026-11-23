# EconPlanner student-facing text: independent reader review

Reviewer: a fresh reviewer who saw only the panel files. Read: all 707 rows of `tests/panel/unique-lines.txt`, `students.json`, and the snapshots needed for context (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 16, 17, 19, 24, 25, 27, 28, 29, 30, 31, 32, 34, 35, 37, 38, 40, 41, 42, 43, 44, 45, 46, 48, 49, 50 in full or in the relevant part. 15, 18, 20, 21, 22, 23, 26, 36, 39, 47 by targeted search).

Citations use `NN.txt:line` = `tests/panel/snapshots/NN.txt`, line number. "UL:n" = `tests/panel/unique-lines.txt` row n.
Anything marked **judgement** is my opinion as a reader. Everything else points to text in the files.

---

## Is the text any good for its purpose? (judgement)

**Verdict: usable with an advisor in the room. Not yet safe to rely on alone.**

- **What works.** Single sentences are mostly short and concrete. They name the course, the term and who to ask (advisor, Registrar, Business Office, Student Academic Assistance Committee). The PDF's "For your advisor" box is a good idea. Notes like "Before taking ECO 213 in Fall 2027, finish ECO 113 and MAT 113." are exactly what a student needs.
- **What does not work.**
  1. **Screen and PDF disagree** in places (which elective counts, which math course counts, in-progress classes). The student and the advisor can be looking at different answers.
  2. **Status labels contradict each other.** Every plan says "Conditional plan", even plans labeled "Ready to plan".
  3. **Pages where no plan fits** often give no reason, or a reason the student cannot act on.
  4. **Too much text and too many repeats.** One plan on screen carries 13 "not confirmed" style warnings (01.txt). The one or two lines that matter get buried.
  5. **Planner jargon leaks through.** Examples: "feasible", "capacity", "allocated", "1.25-unit ceiling", "offering evidence", "eligible term".

Finding counts by group: 1 Wrong or contradictory: 12. 2 Missing information: 10. 3 Jargon and unclear wording: 15. 4 Repetitive or unnecessary: 8. 5 Inconsistent names: 5. 6 Grammar and typos: 12. 7 Test-setup note (not a text defect): 1. **Total 63.**

---

## Group 1. Wrong or contradictory information (fix first)

### 1.1 Screen and PDF name different 100-level electives
- **Text (screen):** "Economics elective 1 ECO 160 ✓ Completed Counts as your one 100-level elective." plus "ECO 161 does not count toward the major because only one 100-level Economics elective can."
- **Text (PDF):** "Economics elective 1" / "ECO 161" / "Completed Counts as your one 100-level elective." plus "ECO 160 does not count toward the major because only one 100-level Economics elective can."
- **Students:** 27, 48
- **Cite:** screen 27.txt:66, 27.txt:72. PDF 27.txt:166–167, 27.txt:179. Screen 48.txt:84, 48.txt:90. PDF 48.txt:295–296, 48.txt:308.
- **Problem:** The student and the advisor are told opposite things about which course counts.
- **Suggested:** Use the same course in both places. "ECO 160 counts as your one 100-level elective. ECO 161 does not count toward the major."

### 1.2 Screen and PDF use different math courses
- **Text:** screen "Mathematics MAT 113 … ✓ Completed". PDF "Mathematics" / "MAT 121" / "Completed".
- **Students:** 49 (completed both MAT 113 and MAT 121)
- **Cite:** 49.txt:76 (screen), 49.txt:270 (PDF). Same in Explore plan, 49.txt:167 and 49.txt:389.
- **Problem:** The advisor's copy shows a different course than the student's screen.
- **Suggested:** Show the same course on screen and in the PDF. "Mathematics: MAT 121 (completed)."

### 1.3 Classes the student is already taking are marked "Seat availability not confirmed"
- **Text:** "NOTE: Seat availability not confirmed" under a class marked Taking now
- **Students:** 17, 18, 19, 36
- **Cite:** 17.txt:35–37, 18.txt:35–37, 19.txt:36–40, 36.txt:34–36. The PDF says "Taking now" for 17, 18 and 36 (17.txt:146, 18.txt:144, 36.txt:126). Student 19's PDF repeats the wrong note (19.txt:142, 19.txt:144).
- **Problem:** The student is already sitting in the class, so a seat warning is wrong and alarming.
- **Suggested:** "Taking now"

### 1.4 "More information needed" and "Not feasible" for the same question, on the same page
- **Text:** "Graduate next year:More information needed" and "More information is needed before EconPlanner can determine whether you can graduate next year." Further down: "One Year Early: Not feasible — These courses did not fit before May 2027: …"
- **Students:** 09, 11
- **Cite:** 09.txt:26 vs 09.txt:126. 11.txt:26, 11.txt:31 vs 11.txt:135.
- **Problem:** The page says both "we can't tell" and "no". It also never says what information is missing, so the student cannot supply it.
- **Suggested:** "You cannot graduate in May 2027. Your required classes do not fit before then. The plan below is for May 2028." (This matches what students 10 and 12 already see at 10.txt:26.)

### 1.5 The "Overall status" box contradicts the result below it
- **Text:** "Overall status / Needs advisor attention" (29, 41, 50) or "More information needed" (40), followed by "Balanced: Not feasible"
- **Students:** 29, 40, 41, 50
- **Cite:** 29.txt:21 vs 29.txt:31. 40.txt:21 vs 40.txt:31. 41.txt:21 vs 41.txt:31. 50.txt:21 vs 50.txt:31.
- **Problem:** Students 29 and 50 can fix this themselves by saving less room for other courses (29.txt:27–28), so "Needs advisor attention" points them to the wrong person. For 40 and 41 the top says one thing and the bottom says another.
- **Suggested:** For 29 and 50: "Status: No plan fits your settings yet." For 40 and 41: "Status: No plan found yet." Then replace "Balanced: Not feasible" with "No Balanced plan fits."

### 1.6 "These courses did not fit" lists every option as if all were required, and lists courses that do fit
- **Text (examples):** "These courses did not fit before May 2028: MAT 113, MAT 121, ECO 257, MAT 217, PSY 217, BUSN 323, ECO 321, ECO 213, ECO 214, ECO elective 1, ECO elective 2, ECO elective 3, ECO elective 4, ECO 461." Also "One Year Early: Not feasible — These courses did not fit before May 2027: BUSN 323, ECO 321, ECO 213, ECO 214, …"
- **Students:** 09, 10, 11, 12, 29, 40, 41, 50
- **Cite:** 50.txt:33 and 10.txt:128 list all 3 statistics options and both finance options. 09.txt:126 lists ECO 214, but the Balanced plan places ECO 214 in Winter 2027 (09.txt:40–41). 12.txt:116 lists ECO 321, but the Balanced plan places ECO 321 in Winter 2027 (12.txt:36–39).
- **Problem:** A student reads that they need MAT 113 *and* MAT 121 *and* three statistics courses. That is false, and the list never gives the real reason.
- **Suggested:** "To finish by May 2027 you still need Math, Statistics, Finance, ECO 213, ECO 214, four electives and ECO 461. There are not enough terms left to fit them all."

### 1.7 Student 42: blames "your answers", and says both "we don't know" and "full" about the same seats
- **Text:** "Something in your answers needs your advisor to check it before you rely on these plans." Then "We don't know if there are open seats in MAT 217, ECO 461, and ECO 222." Then "The listed section for MAT 217 was recorded as full."
- **Students:** 42
- **Cite:** 42.txt:21–22, 42.txt:56, 42.txt:58. The PDF has no advisor note at all (42.txt:110–143).
- **Problem:** Nothing in the answers is wrong. The real issue is a full statistics section that this senior needs before ECO 461, and the text offers no fallback.
- **Suggested:** "The MAT 217 section in this plan was full on August 25, 2026. You need statistics before ECO 461 in Winter 2027. Check for open seats now. If it stays full, ask your advisor about another statistics course."

### 1.8 Student 30: "This term would have 5 courses" while the plan shows 3
- **Text:** "This term would have 5 courses. The normal limit is 4. Advisor approval and no academic probation are recorded." In the PDF: "Why an advisor should review this plan: This term would have 5 courses. …"
- **Students:** 30
- **Cite:** 30.txt:61 and 30.txt:121. The Winter 2027 grid lists only ECO 214, ECO 221 and ECO 461 (30.txt:34–43). The other 2 are the student's saved room (students.json:37, reserveWinter 2), and the text never says so.
- **Problem:** The count does not match what the student sees. It does not name the term. The "reason to review" is already resolved, since approval is recorded.
- **Suggested:** "Winter 2027 would have 5 courses. That is these 3 Economics courses plus the 2 you saved room for. The normal limit is 4. You said your advisor approved this." Drop it from "Why an advisor should review this plan".

### 1.9 Student 19: vague and alarming wording about a class in progress
- **Text:** "Why: ECO 213's earlier course requirements need review." Also "ECO 213 — Taking now ◐ In progress Ask an advisor whether this class counts". Also "Your answers do not show either MAT 113 or MAT 121 completed before ECO 213." and "MAT 121 is marked "Taking now.""
- **Students:** 19
- **Cite:** 19.txt:23, 19.txt:88, 19.txt:80–81
- **Problem:** The text never says plainly that the student is taking the math class and ECO 213 at the same time. "Whether this class counts" sounds like the student may lose the course, but it doesn't say counts toward what.
- **Suggested:** "You are taking ECO 213 and MAT 121 at the same time. MAT 121 normally comes before ECO 213. Ask your advisor if ECO 213 will still count for the major."

### 1.10 "Ready to plan" and "Conditional plan" shown together on every plan
- **Text:** "Student readiness / Ready to plan / These plans meet the major rules." Next to it: "Plan feasibility: Conditional plan / Some future classes, seats, or approvals still need confirmation."
- **Students:** All 36 students who get a plan (UL:534 lists 36 IDs)
- **Cite:** 01.txt:20–22, 01.txt:28, 01.txt:31–32. "Your feasible plan" also appears above plans labeled "Needs advisor attention" (16.txt:21, 16.txt:24).
- **Problem:** Every plan says "Conditional plan", so the label tells the student nothing. It also clashes with "Ready to plan".
- **Suggested:** Keep one status per plan. "Status: Ready. Seats are not confirmed yet." or "Status: Needs your advisor." Drop "Plan feasibility: Conditional plan".

### 1.11 "Graduating one year early" next to a standard graduation date
- **Text:** "Junior (graduating one year early)" with "Graduation target: May 2028". In the PDF: "Class standing: Junior (graduating one year early)" and "Graduation goal: Spring/May 2028". For student 02: "Graduation target: May 2030 (one year early: May 2029)".
- **Students:** 09, 10, 11, 12 (and 02, 08 for the double date)
- **Cite:** 09.txt:7, 09.txt:9. PDF 09.txt:133, 09.txt:137. 02.txt:9.
- **Problem:** The student and advisor can't tell which date the plan aims at. The PDF never says the early date was checked and failed.
- **Suggested:** Screen: "Graduation target: May 2028. You asked about May 2027, but it does not fit." PDF: "One year early (May 2027): does not fit. This plan is for May 2028."

### 1.12 A "same term" warning shown when the classes are in different terms
- **Text:** "Take MAT 113 before ECO 213. Taking both in one term needs the ECO 213 instructor's approval." (and the same for ECO 214)
- **Students:** 02
- **Cite:** 02.txt:309–310. The plan puts MAT 113 in Winter 2027 (02.txt:249), ECO 213 in Fall 2027 (02.txt:255) and ECO 214 in Winter 2028 (02.txt:259).
- **Problem:** It warns about something this plan does not do, which makes the student worry for no reason.
- **Suggested:** Show it only when the two classes share a term. Otherwise remove it.

---

## Group 2. Missing information the student needs to act

### 2.1 The screen does not say which section to take when one section clashes
- **Text:** screen grid "ECO 113 ▾ | Principles of Microeconomics" (no section). PDF grid "ECO 113-K".
- **Students:** 13 (possibly 03, see 03.txt:386)
- **Cite:** 13.txt:35 (screen) vs 13.txt:144 (PDF). ECO 113 Section J meets "Tue/Thu, 10:00–11:45 a.m." (13.txt:99). ECO 214, planned in the same term, meets "Tue/Thu, 10:00–11:45 a.m." (13.txt:105).
- **Problem:** A student registering from the screen could pick Section J and end up with a time clash.
- **Suggested:** "ECO 113: register for Section K. Section J meets at the same time as ECO 214."

### 2.2 "Lower that number" with no number on screen
- **Text:** "No plan fits while you leave room for other courses in these terms: Winter 2027. Lower that number and try again."
- **Students:** 29, 50
- **Cite:** 29.txt:27, 50.txt:27
- **Problem:** "That number" points to nothing the student can see.
- **Suggested:** "You saved room for 2 other courses in Winter 2027. That leaves too little room for your major. Save room for fewer courses and try again."

### 2.3 Approval needed, but no word on who to ask or where to record it
- **Text:** "Taking ECO 213 and ECO 461 together in Winter 2028 needs approval from the Economics Department. No approval is recorded yet."
- **Students:** 10, 11, 14, 15, 20, 21, 28, 30, 32
- **Cite:** 10.txt:75, 28.txt:58, 32.txt:66–67
- **Problem:** "Recorded" where? The student doesn't know whom to ask or how to make the warning go away.
- **Suggested:** "Ask the Economics Department for approval before you register." If students can enter approvals in the app, add one sentence that says where.

### 2.4 Student 34: no reason given
- **Text:** "We couldn't find a complete plan that meets the Finance requirement by your planned graduation date."
- **Students:** 34
- **Cite:** 34.txt:31
- **Problem:** A senior is told "not possible" with no reason. Other failure pages give one (compare 37.txt:31). **Judgement on the cause:** ECO 321 (the Finance course) meets at the same time as ECO 161 in Winter 2027 (02.txt:463, 02.txt:466). That clash is likely what blocks the plan.
- **Suggested:** "To finish by May 2027 you need ECO 321 for Finance and more electives. They do not all fit in Winter and May 2027. Bring this page to your advisor."

### 2.5 Students 40 and 41: no usable reason or next step
- **Text (40):** "Course offering evidence is incomplete for this graduation target. This result does not establish that major completion is impossible." **Text (41):** "This planning result needs advisor attention before we can show a complete schedule." "Your answers are saved."
- **Students:** 40, 41
- **Cite:** 40.txt:26–27, 41.txt:26–27
- **Problem:** Neither tells the student what is missing or what to do, beyond a generic button ("Review my answers", 40.txt:28 and 41.txt:28).
- **Suggested (40):** "We do not have enough schedule information to plan May 2027 yet. This does not mean you cannot finish. Ask your advisor which classes will be offered." **Suggested (41):** "We could not fit 4 electives and ECO 461 before May 2026. Bring this page to your advisor."

### 2.6 Tuition warning does not say whether this plan crosses the line
- **Text:** "More than 5.5 courses in Winter and Spring/May may add tuition. Check with the Business Office."
- **Students:** 30, 32
- **Cite:** 30.txt:59, 32.txt:69. Both plans have 5 courses in Winter plus 1 in May (32.txt:35–53, 30.txt:61).
- **Problem:** The student has to do the sum, and "5.5 courses" is hard to picture.
- **Suggested:** "This plan has 6 courses in Winter and May 2027 together. More than 5.5 may cost extra tuition. Ask the Business Office."

### 2.7 A 100-level course fills an elective slot without saying why it is allowed
- **Text:** "Economics elective 1 ECO 161 — Winter 2027 ○ Planned". The other slots read "ECO elective (200+)".
- **Students:** 11, 13, 14, 16, 39
- **Cite:** 13.txt:84 vs 13.txt:86. Also 14.txt:81, 39.txt:68.
- **Problem:** The page says electives are "200 level or higher", then fills one with a 100-level course. The note that explains this appears only for completed ECO 160 (27.txt:66).
- **Suggested:** Add to the row: "Counts as your one 100-level elective."

### 2.8 "Senior standing" is never explained
- **Text:** "ECO 461 requires senior standing and is offered only in Winter. With this graduation year you will not have senior standing in any Winter term before you graduate."
- **Students:** 04, 06 (and 02, 03, 07, 08, who see "Ask an advisor to confirm senior standing")
- **Cite:** 06.txt:27, 07.txt:33
- **Problem (judgement):** A sophomore aiming for May 2027 will think "I'll be a senior in my last year." The text never says what senior standing depends on.
- **Suggested:** "ECO 461 needs senior standing. That depends on credits earned, not just your graduation year." Add the credit rule from policy.

### 2.9 "Your advisor will check it" suggests the advisor is told automatically
- **Text:** "Otherwise your advisor will check it."
- **Students:** 16, 17, 18, 32
- **Cite:** 16.txt:23, 17.txt:23, 32.txt:23
- **Problem (judgement):** Nothing in the files shows the advisor gets notified, so the student may do nothing.
- **Suggested:** "Otherwise, download the PDF and show it to your advisor."

### 2.10 Student 44: Winter 2027 classes planned, but no Winter 2027 schedule shown
- **Text:** "Published schedules as of the plan date (January 12, 2027)" followed only by "May 2027:" courses
- **Students:** 44
- **Cite:** 44.txt:78–85. The plan places ECO 221 and ECO 461 in Winter 2027 (44.txt:34–37). It still says "Check the registration system before you register" (44.txt:52).
- **Problem (judgement):** On January 12 the Winter term has likely started. The student gets no class times and possibly an out-of-date instruction.
- **Suggested:** If Winter is open: list its class times. If it has started: "Winter 2027 has started. Mark the classes you are taking now."

---

## Group 3. Jargon and unclear wording

| # | Exact text | Students | Cite | Problem | Suggested |
|---|---|---|---|---|---|
| 3.1 | "Plan feasibility: Conditional plan" / "Your feasible plan" / "Balanced: Not feasible" | All with plans, 09–12, 29, 40, 41, 50 | 01.txt:31, 07.txt:23, 29.txt:31, 09.txt:126 | "Feasible" is planner talk, not student talk. | "Your plan" / "Does not fit" |
| 3.2 | "ECO 321 must fill finance … After finance is allocated, no remaining eligible elective is offered in Winter 2027. … two exceed both the normal 1-unit load and the advisor-approved 1.25-unit ceiling. …" | 37, 38 | 37.txt:31, 38.txt:31 | Five or six sentences of jargon ("allocated", "distinct", "eligible", "unit ceiling") for a senior getting bad news. | "You still need 2 more Economics electives. ECO 321 is used for Finance, so it cannot also be an elective. Winter 2027 has no other elective you can take. May allows only one course, so the second elective does not fit." |
| 3.3 | "Course offering evidence is incomplete for this graduation target. This result does not establish that major completion is impossible." | 40 | 40.txt:27 | Reads like a lab report. | See 2.5. |
| 3.4 | "…under the current requirements, course timing, and selected term capacity." / "No complete plan fits this graduation target with the available course timing and capacity." | 12. 31, 33, 34, 35, 37, 38, 43, 45 | 12.txt:27, 37.txt:26 | "Capacity" and "course timing" are vague. | "Your remaining classes do not fit in the terms left before May 2027." |
| 3.5 | "Senior-year Winter only · no other eligible term in this plan" | All with plans | 01.txt:62 | "Eligible term" is jargon. It also repeats "ECO 461 is offered only in Winter." | "Offered only in Winter. This is your last Winter before you graduate." |
| 3.6 | "Economics elective (200 level or higher) — Eligible ECO elective (future offering to verify)" | All PDFs with open electives | 01.txt:276 | Awkward and repetitive. | "Economics elective (200 level or higher). Pick one when the schedule comes out." |
| 3.7 | "Advisor approval and no academic probation are recorded." / "this term uses an advisor-approved overload" | 30, 32 | 30.txt:61, 32.txt:70 | Odd grammar, and "overload" is jargon. | "You said your advisor approved the extra course and you are not on academic probation." |
| 3.8 | "Your available terms start in Winter 2027. ECO 461 must be taken in Winter 2027 … Check your statistics answer or ask your advisor about a later graduation date." | 10, 35, 43 | 10.txt:27, 35.txt:31 | Four sentences, about 70 words, opening with jargon. For student 10, statistics is only one of many missing classes (10.txt:128), so the reason is incomplete. | "ECO 461 is offered only in Winter. To finish by May 2027 you must take it in Winter 2027. You need statistics first, and there is no earlier term left." |
| 3.9 | "Your reserved room leaves too little space for the major courses." / "Change room for other courses" | 29, 50 | 29.txt:26, 29.txt:28 | "Reserved room" is app jargon. | "You saved too much room for non-major courses." / button "Save less room" |
| 3.10 | "Student readiness" / "Ready to plan" | All with plans | 01.txt:20–21 | The plan is already made, so "Ready to plan" reads like a to-do. "Student readiness" sounds like it is grading the student. | "Plan status: Ready" |
| 3.11 | "Something in your answers needs your advisor to check it…" / "Why: Confirm with your advisor that your AP credit for ECO 113 and MAT 121 counts." | 05, 26, 46, 47 | 05.txt:22–23, 46.txt:22–23 | The answers are not wrong, and "Why:" is followed by an instruction, not a reason. | "Your advisor needs to confirm that your AP credit for ECO 113 and MAT 121 counts toward the major." |
| 3.12 | "Check this class's enrollment status" | 42 | 42.txt:37 | Vague. It means "the section was full". | "This section was full. Check for open seats." |
| 3.13 | "No major course assigned" | 08, 46, 47, 48, 49 | 46.txt:42, 08.txt:36 | Reads like an error message. | "No Economics course this term" |
| 3.14 | "This plan uses the current Economics major requirements." (standing alone under "Check with your advisor") | 09, 10, 12, 14, 15, 18, 20, 21 | 09.txt:74, 12.txt:64 | Listed as something to check, but there is nothing to do. | Remove it when no catalog note follows. |
| 3.15 | "If you finished one or are taking it now, mark it." | 17 | 17.txt:23 | "One" is unclear. | "If you finished ECO 114 or are taking it now, mark it in Your courses." |

Extra item in this group, **judgement:** "Plans a lighter course load in the first year than Balanced." (Explore the Major. Students 01, 02, 03, 05, 19, 46, 47, 48, 49. Cite 05.txt:128.) For sophomores, "first year" sounds like their freshman year, which is over. Suggested: "Takes fewer major classes this year than Balanced. Classes that need another class first come later."

(The 15 table rows plus this item are counted as 15 in the totals. The extra item is a judgement call.)

---

## Group 4. Repetitive or unnecessary text

### 4.1 About 13 "not confirmed" warnings in one plan
- **Text:** "Seat availability not confirmed" (on each class), "Future offering unconfirmed" (on each elective), "Some future classes, seats, or approvals still need confirmation.", "We don't know if there are open seats in …", "Future schedules can change.", "Actual offerings may differ.", "Its future offering is not confirmed.", plus the summary line.
- **Students:** All with plans
- **Cite:** 01.txt:22, 32, 37, 39, 42, 49, 54, 57, 65, 79, 96, 126, 127 (Balanced plan only)
- **Problem (judgement):** The warnings drown out the one or two items the student must act on.
- **Suggested:** One line per plan: "Seats and future classes are not confirmed. Check the registration system before you register." Use a small icon on each row in place of the repeated text.

### 4.2 The same long "check your answers" message appears 4 to 6 times
- **Text:** "You marked ECO 213 completed, but ECO 113, which comes before it, is not marked completed. If you finished ECO 113 or have transfer/AP credit for it, mark it. Otherwise your advisor will check it."
- **Students:** 16, 17, 18, 32
- **Cite:** 16.txt:23, 16.txt:38, 16.txt:70, 16.txt:78. PDF 16.txt:133, 16.txt:176.
- **Problem:** Repeating it makes the page longer, not clearer.
- **Suggested:** Show the full message once at the top. Elsewhere use a short tag: "See the note at the top."

### 4.3 The same paragraph shown twice in a row
- **Text:** "ECO 461 requires senior standing and is offered only in Winter. With this graduation year you will not have senior standing …"
- **Students:** 04, 06
- **Cite:** 04.txt:27 and 04.txt:31. 06.txt:27 and 06.txt:31.
- **Problem:** Duplicate text.
- **Suggested:** Show it once, under "Why am I seeing this result?"

### 4.4 One approval stated four times
- **Text:** "Approval needed" (grid), "Taking ECO 214 and ECO 461 in the same term requires approval…" (grid), "Taking ECO 214 and ECO 461 together in Winter 2027 needs approval… No approval is recorded yet." (notes), "Approval needed" (checklist, twice)
- **Students:** 10, 11, 14, 15, 20, 21, 28, 30, 32
- **Cite:** 28.txt:41–42, 28.txt:58, 28.txt:68, 28.txt:71
- **Problem:** Repetition.
- **Suggested:** One note under "Check with your advisor". Grid and checklist show only "Approval needed".

### 4.5 Requirement choices repeated in every row and again below the table
- **Text:** "Requirement options: MAT 113 / MAT 121" (every Math, Statistics and Finance row) plus "Math choices: MAT 113 or MAT 121. Statistics choices: … Finance choices: …". Rows also read "ECO 113 ECO 113 — Winter 2027".
- **Students:** All with plans
- **Cite:** 01.txt:85, 01.txt:329, 02.txt:83
- **Problem:** The same information twice per table.
- **Suggested:** Keep the one "choices" line under the table. Drop "Requirement options" from the rows.

### 4.6 "Previously offered" on classes already on the published schedule
- **Text:** "ECO 214 — Intermediate Macroeconomics Previously offered in Fall and Winter."
- **Students:** All PDFs
- **Cite:** 09.txt:159–161. These courses are on the published Winter 2027 schedule (09.txt:239–241).
- **Problem:** History is pointless when the real schedule is known.
- **Suggested:** Drop the "Previously offered" note when the course is on a published schedule for that term.

### 4.7 Filler lines
- **Text:** "Review this result and the next step below." / "Your answers are saved." / "Classes marked Planned are not completed yet." / PDF heading "Plan Notes" followed only by the repeated header line
- **Students:** 14 failure-page students / 41 / all with plans / all PDFs
- **Cite:** 04.txt:23, 41.txt:27, 01.txt:96, 02.txt:445–446
- **Problem:** These add length but no information.
- **Suggested:** Remove them.

### 4.8 The paperwork pointer appears for some petition students and not others
- **Text:** "See the notes below for paperwork to file."
- **Students:** Shown to 08 (Balanced PDF only), 13, 23, 24, 27, 36, 39, 44. Missing for 07, 11, 16, 17, 28, 30, 42, who all have a petition note.
- **Cite:** 08.txt:203, 13.txt:22. Petition note without pointer at 07.txt:56, 42.txt:59.
- **Problem:** Inconsistent. The students who don't get the pointer may miss the petition.
- **Suggested:** Show it to every student with a petition note: "You have a petition to file. See Check with your advisor."

---

## Group 5. Inconsistent names for the same thing

| # | Text | Cite | Problem | Suggested |
|---|---|---|---|---|
| 5.1 | One term has four names: "2026/2027 May", "May 2027", "Spring/May 2027", "May 2027:". Also "2026/2027 Fall 2026" vs "2026/2027 Fall". | 02.txt:40, 02.txt:88, 02.txt:421, 02.txt:118. 17.txt:35 vs 42.txt:34 | A student may think these are different terms. | "May 2027" and "Fall 2026" everywhere |
| 5.2 | "Graduation target" (screen) vs "Graduation goal" (PDF) | 02.txt:14, 02.txt:351 | Two names for the same thing. | "Graduation target" |
| 5.3 | "Overall status" (no-plan pages) vs "Student readiness" (plan pages) | 04.txt:20, 01.txt:20 | Same box, two labels. | "Status" |
| 5.4 | "ECO elective (200+)" (screen) vs "Economics elective (200 level or higher)" (PDF) | 01.txt:48, 02.txt:370 | Two labels. | "Economics elective (200 level or higher)" |
| 5.5 | "1-unit load", "1.25-unit ceiling" vs "The normal limit is 4" (courses) and "5.5 courses" | 37.txt:31, 30.txt:61, 30.txt:59 | Mixes units and courses. | Use "courses" throughout |

---

## Group 6. Grammar and typos

| # | Exact text | Students | Cite | Suggested |
|---|---|---|---|---|
| 6.1 | "Your 2023–24 catalog does not accept they." | 24 | 24.txt:54, 24.txt:135 | "Your 2023–24 catalog does not accept them." |
| 6.2 | "…confirm whether ECO 113 were completed before ECO 213." (also "either MAT 113 or MAT 121 were completed") | 16, 17, 18, 19, 32 | 16.txt:176, 17.txt:182, 19.txt:298 | "…confirm whether ECO 113 was completed before ECO 213." |
| 6.3 | "You have 3 required courses left and 1 terms before May 2027." | 45 | 45.txt:31 | "You have 3 required courses left and only 1 term left (May 2027)." |
| 6.4 | "Graduate next year:More information needed" | 09, 11 | 09.txt:26, 11.txt:26 | Missing space. See 1.4 for the full rewrite. |
| 6.5 | "Confirm ECO 214 instructor approval for ECO 214 in Winter 2027." | 32 (PDF, advisor) | 32.txt:172 | "Confirm the ECO 214 instructor approves taking MAT 113 and ECO 214 together in Winter 2027." |
| 6.6 | "This planner does not apply that credit; discuss the petition with your advisor." | 25 | 25.txt:55, 25.txt:138 | "This plan does not count it yet. Talk with your advisor about the petition." |
| 6.7 | "AP credit AP/exam credit." / "Transfer credit Transfer credit." | 05, 46 / 47 | 05.txt:79, 47.txt:79 | "AP credit. Confirm with your advisor that it counts." |
| 6.8 | "The Spring/May 2027 options are ECO 222, ECO 224, ECO 234." | 37, 38 | 37.txt:31 | "The May 2027 options are ECO 222, ECO 224 and ECO 234." |
| 6.9 | "Before taking ECO 221 in Winter 2027 and ECO 321 in Winter 2027, finish ECO 113." | 18 | 18.txt:67 | "Before taking ECO 221 and ECO 321 in Winter 2027, finish ECO 113." |
| 6.10 | "These plans work only if… Check each plan's conditions." shown above a single plan | 07, 10, 11, 14, 15, 20, 21, 28, 30 | 07.txt:22–23 | "This plan works only if the conditions shown on it are met." |
| 6.11 | "…because only one 100-level Economics elective can." | 27, 48 | 48.txt:90 | "…because only one 100-level Economics elective can count." |
| 6.12 | "Check the student's earlier…" (curly apostrophe) then "The student's answers…" (straight) in the same sentence | 18, 19 | 18.txt:178 | Use one apostrophe style |

---

## Group 7. Test-setup note (not a student-text defect)

### 7.1 Study-abroad students 20 and 21 were not actually tested
- **What the files show:** The snapshots for 20 and 21 differ from student 15's only in the name line (`diff 15.txt 20.txt` shows only lines 127 and 222). No line mentions study abroad. Both plans place ECO 221, ECO 321 and MAT 217 in Winter 2027 and ECO 222 in May 2027 (20.txt:34–42), the terms the students said they would be abroad (students.json:27–28).
- **Likely cause:** The panel script passes `"2027-WINTER"` (scripts/panel/run.mjs:91). The planner only accepts IDs like `"winter-2027"` (lib/planning/study-abroad.js:15–17, lib/planning/mcp-tools.js:88). The same script converts the overload term (run.mjs:107) but not the abroad term. So the abroad answer never reached the planner.
- **Effect:** No study-abroad wording was captured, so none of it has been reviewed.
- **Remedy:** Convert the abroad term the same way as the overload term, then re-capture and review the abroad wording. Per AGENTS.md, `scripts/panel/` changes need the owner's explicit request.
