import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import { validateCoursePlan } from "../../../lib/validateCoursePlan.js";

export const runtime = "nodejs";

const KNOWLEDGE_FILES = [
  "prompts/econ-advising-instructions.md",
  "rules/core-advising-rules.md",
  "knowledge/major-requirements.md",
  "knowledge/course-offerings.md",
  "knowledge/term-structure.md",
  "knowledge/course-schedule-2026-2027.md"
];

const INITIAL_MODEL = process.env.OPENAI_INITIAL_MODEL || "gpt-5.5-mini";
const REPAIR_MODEL = process.env.OPENAI_REPAIR_MODEL || "gpt-5.5";

const RECOGNIZED_COURSES = new Set([
  "ECO 113", "ECO 114", "ECO 160", "ECO 161", "ECO 213", "ECO 214",
  "ECO 221", "ECO 222", "ECO 223", "ECO 224", "ECO 234", "ECO 257",
  "ECO 260", "ECO 307", "ECO 315", "ECO 316", "ECO 321", "ECO 331",
  "ECO 333", "ECO 335", "ECO 337", "ECO 357", "ECO 360", "ECO 370",
  "ECO 461", "ECO 471", "MAT 112", "MAT 113", "MAT 121", "MAT 217",
  "PSY 217", "BUSN 323"
]);

class ModelOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelOutputError";
  }
}

class KnowledgeLoadError extends Error {
  constructor(file, cause) {
    super(`Could not load knowledge file: ${file}`);
    this.name = "KnowledgeLoadError";
    this.file = file;
    this.cause = cause;
  }
}

function jsonResponse(payload, status = 200) {
  return Response.json(payload, { status });
}

async function readProjectFile(relativePath) {
  const fullPath = path.join(process.cwd(), relativePath);
  return fs.readFile(fullPath, "utf8");
}

async function loadKnowledgeBundle() {
  const files = await Promise.all(
    KNOWLEDGE_FILES.map(async file => {
      let content;
      try {
        content = await readProjectFile(file);
      } catch (error) {
        throw new KnowledgeLoadError(file, error);
      }
      return `\n\n--- FILE: ${file} ---\n${content}`;
    })
  );
  return files.join("\n");
}

function capWords(text, limit = 220) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= limit) return words.join(" ");
  return `${words.slice(0, limit).join(" ")} ...`;
}

const ECO_TITLE_ALIASES = [
  ["ECO 113", ["principles of microeconomics"]],
  ["ECO 114", ["principles of macroeconomics"]],
  ["ECO 213", ["intermediate microeconomics"]],
  ["ECO 214", ["intermediate macroeconomics"]],
  ["ECO 221", ["environmental economics"]],
  ["ECO 222", ["economics of the european union"]],
  ["ECO 223", ["poverty and discrimination", "poverty & discrimination"]],
  ["ECO 224", ["introduction to sustainability"]],
  ["ECO 234", ["rational choices"]],
  ["ECO 257", ["quantitative methods"]],
  ["ECO 321", ["money & financial markets", "money and financial markets"]],
  ["ECO 331", ["labor economics"]],
  ["ECO 333", ["international trade & finance", "international trade and finance"]],
  ["ECO 335", ["managerial economics"]],
  ["ECO 337", ["economic development"]],
  ["ECO 357", ["internship"]],
  ["ECO 461", ["senior seminar", "econometrics"]],
  ["ECO 471", ["senior thesis"]]
];

function extractEcoCodes(value) {
  const text = String(value || "");
  const codes = new Set();
  const matches = text.toUpperCase().matchAll(/\bECO\s*-?\s*(\d{3})\b/g);

  for (const match of matches) {
    codes.add(`ECO ${match[1]}`);
  }

  const lowered = text.toLowerCase();
  for (const [code, aliases] of ECO_TITLE_ALIASES) {
    if (aliases.some(alias => lowered.includes(alias))) codes.add(code);
  }

  return [...codes];
}

function completedRequirementLabel(value, label) {
  const text = String(value || "").toLowerCase();
  if (text.startsWith("completed")) return `Completed ${label}.`;
  if (text.startsWith("currently taking")) return `Currently taking ${label}.`;
  return "";
}

function buildStudentSummary(studentInput) {
  const sentences = [`Student is a ${studentInput.studentYear}.`];
  const completedEco = extractEcoCodes(studentInput.completedCourses);

  if (completedEco.length) {
    sentences.push(`Completed ECO courses: ${completedEco.join(", ")}.`);
  }

  for (const sentence of [
    completedRequirementLabel(studentInput.mathCognate, "math requirement"),
    completedRequirementLabel(studentInput.statsOption, "statistics requirement"),
    completedRequirementLabel(studentInput.financeOption, "money/finance requirement")
  ]) {
    if (sentence) sentences.push(sentence);
  }

  return sentences.join(" ");
}

function sanitizeStudentInput(body = {}) {
  const input = {
    studentYear: String(body.studentYear || "freshman").slice(0, 80),
    completedCourses: String(body.completedCourses || "").slice(0, 500),
    currentCourses: String(body.currentCourses || "").slice(0, 500),
    mathCognate: String(body.mathCognate || "not completed").slice(0, 120),
    statsOption: String(body.statsOption || "not completed").slice(0, 120),
    financeOption: String(body.financeOption || "not completed").slice(0, 120),
    additionalNotes: String(body.additionalNotes || "").slice(0, 8000)
  };

  return {
    ...input,
    additionalNotesForModel: capWords(input.additionalNotes, 300),
    displaySummaryInstruction: "If additionalNotes is nonempty, summarize it in studentSummary in no more than 200 words. If short, preserve the substance. Do not echo long text verbatim."
  };
}

function preflightStudentInput(studentInput) {
  const errors = [];
  const explanations = [];
  const year = String(studentInput.studentYear || "").toLowerCase();
  const completed = String(studentInput.completedCourses || "").trim();
  const current = String(studentInput.currentCourses || "").trim();

  const isSophomoreOrAbove = /sophomore|junior|senior|2nd|3rd|4th/.test(year);
  if (isSophomoreOrAbove && !completed && !current) {
    explanations.push("Please list completed/current ECO courses, or type \"none\" if the student has not taken any.");
  }

  const courseText = [
    studentInput.completedCourses,
    studentInput.currentCourses,
    studentInput.additionalNotes
  ].join(" ");
  const unknown = [...new Set([...courseText.toUpperCase().matchAll(/\b(ECO|MAT|PSY|BUSN)\s*-?\s*(\d{3})\b/g)]
    .map(match => `${match[1]} ${match[2]}`)
    .filter(code => !RECOGNIZED_COURSES.has(code)))];

  if (unknown.length) {
    errors.push(`Unrecognized course code${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`);
    explanations.push(`I do not recognize ${unknown.join(", ")}. You can remove it if it should be ignored, or clarify/correct the course number.`);
  }

  return { valid: errors.length === 0 && explanations.length === 0, errors, explanations };
}

function hasSpecialCreditWarning(studentInput) {
  const text = [
    studentInput.completedCourses,
    studentInput.currentCourses,
    studentInput.additionalNotes
  ].join(" ");
  return /transfer|ap credit|waiver|substitut|catalog/i.test(text);
}

function buildSystemPrompt(knowledgeBundle) {
  return `You are the backend planning engine for a web-based economics major course planner.

You must follow the project files below. The model proposes a plan, but JavaScript validation will verify it before display. Accuracy is more important than brevity.

Return only valid JSON. Do not use Markdown outside JSON.

${knowledgeBundle}

Critical reminders:
- Use spaced course codes, e.g. ECO 113.
- Term-cell values must be course codes only, with alternatives allowed as "ECO 213 or ECO 214".
- Keep notes brief and student-friendly.
- Do not repeat completed/current courses.
- In completed/current ECO fields, bare numbers such as 213 or 214 mean ECO 213 or ECO 214.
- In completed/current ECO fields, course names such as Intermediate Microeconomics, Intermediate Macroeconomics, Money & Financial Markets, and Quantitative Methods should be interpreted as their matching course codes.
- Treat "not completed" as not done. Treat "currently taking" as in progress and do not schedule that requirement again.
- If ECO 213 is completed/current, do not schedule ECO 113. If ECO 214 is completed/current, do not schedule ECO 114.
- 2026/2027 ECO placement must follow the current schedule file exactly.
- For academic years after 2026/2027, do not name specific ECO electives such as ECO 221 or ECO 333 unless the student provides current offering information. Use ECO elective instead.
- For academic years after 2026/2027, do not display only ECO 213 or only ECO 214. Use "ECO 213 or ECO 214" and later "ECO 214 or ECO 213" because the exact future schedule is unknown.
- Schedule ECO 213 and ECO 214 as soon as feasible after MAT 113 or MAT 121 and the appropriate introductory courses are complete.
- For freshman plans, schedule MAT 113 or MAT 121 no later than the end of sophomore year. Do not rely on concurrent math enrollment with ECO 213 or ECO 214 unless no better plan is feasible.
- If MAT 113 or MAT 121 is current/in progress and ECO 213 cannot be placed in its correct known 2026/2027 Fall term, do not move ECO 213 to Winter 2026/2027. Wait and use the future-year alternative wording instead.
- Prefer no more than two economics courses in Fall or Winter. Use three only when needed for timely major completion. Use four only if three cannot make completion on time possible. Never schedule more than four economics courses in Fall or Winter.
- Do not schedule more than one ECO elective in any term unless the student explicitly asks for a heavier economics load or it is needed to finish the major on time.
- Prefer no more than one ECO elective in senior year, but allow additional senior-year ECO electives when needed to complete the major by graduation. Still respect the term load limits and May Term limits.
- When the statistics requirement is not completed, write the requirement group as MAT 217 / ECO 257 / PSY 217. Do not write ECO 257 by itself.
- When the money/finance requirement is not completed, write the requirement group as ECO 321 / BUSN 323. Do not write ECO 321 by itself unless using the known 2026/2027 schedule specifically.
- A returned plan must show every remaining major requirement, including four ECO electives, the math cognate, statistics option, money/finance option, ECO 213, ECO 214, and ECO 461.
- If the remaining requirements cannot fit under the rules, return the closest valid JSON plan and explain the constraint briefly in notes; do not invent offerings or place courses in invalid terms.
- For freshman and sophomore standard plans, do not accelerate the economics major to finish before senior year unless the student explicitly asks for that.
- For freshman and sophomore standard plans, aim for 2-3 ECO courses per full academic year when feasible.
- ECO 461 requires senior standing and may only be scheduled in senior Winter.
- Do not schedule or mention ECO 471 in standard plans. Include ECO 471 only if the student explicitly asks for Senior Thesis.
- ECO 471 requires senior standing and may only be scheduled in senior year.
- The statistics option must be completed no later than Fall senior year and is recommended by the end of junior year.
- Completing ECO 213 and ECO 214 by the end of junior year is recommended when feasible, not stated as mandatory.
- Always include a global note that offerings should be confirmed with the official schedule and that the student can keep chatting with EconMapper (me) about the plan.`;
}

function buildUserPrompt(studentInput) {
  return `Build a possible economics major course plan from this structured intake.

Student intake:
${JSON.stringify(studentInput, null, 2)}

Return JSON exactly in this general shape:
{
  "assumptions": "short student-facing summary; do not start with 'I assumed'",
  "studentSummary": "short summary of additional notes, or empty string",
  "years": [
    {
      "label": "1st Year",
      "academicYear": "2026/2027",
      "terms": {
        "Fall": ["ECO 113"],
        "Winter": ["ECO 114"],
        "May": ["—"]
      },
      "notes": []
    }
  ],
  "advisorChecks": [],
  "globalNotes": ["Offerings should be confirmed with the official schedule. You can keep chatting with EconMapper (me) about your plan."]
}`;
}

function extractJson(text) {
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  }
}

async function callPlannerModel(client, messages, model) {
  const completion = await client.chat.completions.create({
    model,
    max_completion_tokens: 6000,
    response_format: { type: "json_object" },
    messages
  });

  const text = completion.choices?.[0]?.message?.content || "";
  const parsed = extractJson(text);
  if (!parsed) {
    throw new ModelOutputError("Model response was not valid JSON.");
  }
  return { plan: parsed, usage: completion.usage || null };
}

function mergeAdvisorChecks(plan, validation) {
  return {
    ...plan,
    advisorChecks: []
  };
}

function explainValidationError(error) {
  const text = String(error || "");
  if (/not listed in .*2026\/2027/i.test(text)) {
    return "A course was placed in a 2026/2027 term where the known schedule does not offer it.";
  }
  if (/already completed or in progress/i.test(text)) {
    return "The draft repeated a course the student has already completed or is currently taking.";
  }
  if (/requires .* before/i.test(text)) {
    return "The draft put a course before its prerequisite was completed.";
  }
  if (/four ECO electives/i.test(text)) {
    return "The draft did not include the four ECO electives required for the major.";
  }
  if (/must include the .* requirement/i.test(text)) {
    return "The draft left out a required part of the economics major.";
  }
  if (/senior standing/i.test(text)) {
    return "The draft placed a senior-only course before senior year.";
  }
  if (/Senior year should include no more than one ECO elective/i.test(text)) {
    return "The draft overloaded senior year with too many ECO electives.";
  }
  if (/should be written as ECO elective/i.test(text)) {
    return "The draft named a specific future ECO elective even though that future schedule is not known.";
  }
  if (/ECO 213.*or ECO 214|ECO 214.*or ECO 213/i.test(text)) {
    return "The draft named ECO 213 or ECO 214 too specifically in a future year where the exact schedule is unknown.";
  }
  return text;
}

function buildValidationExplanations(validation) {
  return [...new Set((validation.errors || []).map(explainValidationError))].slice(0, 4);
}

function modelFailurePayload(error) {
  const status = Number(error?.status);
  const code = String(error?.code || error?.cause?.code || "");
  const message = String(error?.message || "");

  if (status === 429 || /rate.?limit/i.test(message)) {
    return {
      status: 503,
      error: "EconMapper (me) is temporarily rate-limited. Please try again in a minute.",
      explanation: "The OpenAI API returned a rate-limit response."
    };
  }

  if (status === 401 || status === 403) {
    return {
      status: 503,
      error: "EconMapper (me) cannot connect because the API key or model access needs attention.",
      explanation: "The OpenAI API rejected the request."
    };
  }

  if (/timeout|timed? out/i.test(message) || code === "ETIMEDOUT") {
    return {
      status: 504,
      error: "EconMapper (me) took too long to respond. Please try again.",
      explanation: "The OpenAI API request timed out."
    };
  }

  if (/Connection error|fetch failed|network/i.test(message) || ["EACCES", "ECONNRESET", "ENOTFOUND", "ECONNREFUSED"].includes(code)) {
    return {
      status: 503,
      error: "EconMapper (me) could not reach the planning model. Please try again.",
      explanation: "The backend could not connect to the OpenAI API."
    };
  }

  return null;
}

function isSeniorStudent(studentInput) {
  return /senior|4th/i.test(String(studentInput.studentYear || ""));
}

function canReturnClosestPlan(studentInput, validation) {
  if (!isSeniorStudent(studentInput)) return false;
  const errors = validation.errors || [];
  if (!errors.length) return false;
  const hasSeniorDeadlineError = errors.some(error => /Senior plans may not extend beyond Senior Year/i.test(error));

  const unsafePatterns = [
    /not listed in/i,
    /requires .* before/i,
    /may not be scheduled in May Term/i,
    /more than two economics courses/i,
    /more than four economics courses/i,
    /more than one total course/i,
    /not listed as a valid ECO course/i,
    /already completed or in progress/i,
    /ECO 213 and ECO 214 should not both/i,
    /must be scheduled only in Winter/i,
    /should be written as/i
  ];

  return !errors.some(error => {
    if (hasSeniorDeadlineError && /senior standing/i.test(error)) return false;
    return unsafePatterns.some(pattern => pattern.test(error));
  });
}

function finalizePlan(plan, validation, studentInput, extraNotes = []) {
  const output = normalizeOrText(mergeAdvisorChecks(plan, validation));
  output.assumptions = buildStudentSummary(studentInput);

  if (!Array.isArray(output.globalNotes)) output.globalNotes = [];
  const requiredGlobalNote = "Offerings should be confirmed with the official schedule. You can keep chatting with EconMapper (me) about your plan.";
  if (!output.globalNotes.some(note => String(note).includes("official schedule"))) {
    output.globalNotes.push(requiredGlobalNote);
  }
  if (hasSpecialCreditWarning(studentInput)) {
    output.globalNotes.push("Advisor review is needed to confirm whether AP, transfer, waiver, or substitution credit applies at Hanover.");
  }
  for (const note of extraNotes) output.globalNotes.push(note);
  output.globalNotes = [...new Set(output.globalNotes)];

  return output;
}

function normalizeOrText(value) {
  if (typeof value === "string") return value.replace(/\bOR\b/g, "or");
  if (Array.isArray(value)) return value.map(normalizeOrText);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeOrText(nestedValue)])
    );
  }
  return value;
}

export async function POST(request) {
  if (!process.env.OPENAI_API_KEY) {
    return jsonResponse({ error: "Missing OPENAI_API_KEY." }, 500);
  }

  try {
    const body = await request.json();
    const studentInput = sanitizeStudentInput(body);
    const preflight = preflightStudentInput(studentInput);
    if (!preflight.valid) {
      return jsonResponse({
        error: preflight.explanations.join(" "),
        validation: {
          valid: false,
          errors: preflight.errors,
          warnings: [],
          explanations: preflight.explanations
        }
      }, 400);
    }

    const knowledgeBundle = await loadKnowledgeBundle();
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const systemPrompt = buildSystemPrompt(knowledgeBundle);
    const userPrompt = buildUserPrompt(studentInput);

    let repairUsed = false;
    const modelUsage = {};
    const initialResult = await callPlannerModel(client, [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], INITIAL_MODEL);
    let plan = initialResult.plan;
    modelUsage.initial = initialResult.usage;

    let validation = validateCoursePlan(plan, { studentInput });

    if (!validation.valid) {
      repairUsed = true;
      const revisionPrompt = `The plan failed backend validation. Revise the JSON plan only. Keep the same student intake and project rules. Revise only the identified issues; do not change valid parts of the plan unless needed to fix the listed errors.

Validation errors:
${validation.errors.map(error => `- ${error}`).join("\n")}

Validation warnings to consider:
${validation.warnings.map(warning => `- ${warning}`).join("\n")}

Original student intake:
${JSON.stringify(studentInput, null, 2)}

Invalid plan:
${JSON.stringify(plan, null, 2)}`;

      const repairResult = await callPlannerModel(client, [
        { role: "system", content: systemPrompt },
        { role: "user", content: revisionPrompt }
      ], REPAIR_MODEL);
      plan = repairResult.plan;
      modelUsage.repair = repairResult.usage;

      validation = validateCoursePlan(plan, { studentInput });
    }

    if (!validation.valid) {
      if (canReturnClosestPlan(studentInput, validation)) {
        const explanations = buildValidationExplanations(validation);
        const closestPlan = finalizePlan(plan, validation, studentInput, [
          "Warning: based on the current constraints, the economics major cannot be completed by the end of senior year in this plan."
        ]);
        return jsonResponse({
          plan: closestPlan,
          validation: {
            valid: false,
            errors: validation.errors,
            warnings: validation.warnings,
            explanations
          },
          model: repairUsed ? REPAIR_MODEL : INITIAL_MODEL,
          models: {
            initial: INITIAL_MODEL,
            repair: REPAIR_MODEL,
            repairUsed,
            usage: modelUsage
          }
        });
      }

      const explanations = buildValidationExplanations(validation);
      return jsonResponse({
        error: `Planner could not produce a valid course plan. ${explanations.length ? `Why: ${explanations.join(" ")}` : "Please adjust the intake or ask an advisor to review the constraints."}`,
        validation: {
          valid: validation.valid,
          errors: validation.errors,
          warnings: validation.warnings,
          explanations
        }
      }, 422);
    }

    plan = finalizePlan(plan, validation, studentInput);

    return jsonResponse({
      plan,
      validation: {
        valid: validation.valid,
        errors: validation.errors,
        warnings: validation.warnings,
        explanations: []
      },
      model: repairUsed ? REPAIR_MODEL : INITIAL_MODEL,
      models: {
        initial: INITIAL_MODEL,
        repair: REPAIR_MODEL,
        repairUsed,
        usage: modelUsage
      }
    });
  } catch (error) {
    console.error(error);
    if (error instanceof SyntaxError) {
      return jsonResponse({ error: "The request body must be valid JSON." }, 400);
    }
    if (error instanceof KnowledgeLoadError) {
      return jsonResponse({
        error: "Planner configuration is missing or unreadable. Please ask an advisor or administrator to check the advising files.",
        validation: {
          valid: false,
          errors: [error.message],
          warnings: [],
          explanations: [`Missing or unreadable file: ${error.file}`]
        }
      }, 500);
    }
    if (error instanceof ModelOutputError) {
      return jsonResponse({
        error: "EconMapper (me) seems to be off today, maybe getting the flu. Please try again.",
        validation: {
          valid: false,
          errors: ["Model response was not valid JSON."],
          warnings: [],
          explanations: ["EconMapper did not return a valid structured plan."]
        }
      }, 502);
    }
    const modelFailure = modelFailurePayload(error);
    if (modelFailure) {
      return jsonResponse({
        error: modelFailure.error,
        validation: {
          valid: false,
          errors: [modelFailure.explanation],
          warnings: [],
          explanations: [modelFailure.explanation]
        }
      }, modelFailure.status);
    }
    return jsonResponse({ error: "Planner failed. Please try again or ask an advisor to review the constraints." }, 500);
  }
}
