import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const catalogYear = process.argv[2] || "2025-2026";
const catalogDir = path.join(root, "data/raw/hanover/catalog", catalogYear);
const normalizedDir = path.join(root, "data/normalized/catalogs", catalogYear);
const reviewDir = path.join(root, "data/review");

const html = await readFile(path.join(catalogDir, "catalog.html"), "utf8");
const programs = JSON.parse(await readFile(path.join(normalizedDir, "programs.json"), "utf8"));

function decodeEntities(value) {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&ndash;", "-")
    .replaceAll("&mdash;", "-")
    .replaceAll("&rsquo;", "'")
    .replaceAll("&ldquo;", '"')
    .replaceAll("&rdquo;", '"')
    .replaceAll(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll("â€“", "-")
    .replaceAll("â€”", "-")
    .replaceAll("â€™", "'")
    .replaceAll("â€œ", '"')
    .replaceAll("â€\x9d", '"')
    .replaceAll("â€¦", "...")
    .replaceAll("Â ", " ")
    .replaceAll("Â", "");
}

function textFromHtml(value) {
  return decodeEntities(value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractDocumentFeatures(source) {
  const paragraphs = [
    ...[...source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(item => ({ index: item.index, html: item[1], text: textFromHtml(item[1]), isHeading: false })),
    ...[...source.matchAll(/<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/gi)].map(item => ({ index: item.index, html: item[1], text: textFromHtml(item[1]), isHeading: true }))
  ].sort((left, right) => left.index - right.index);
  const courseTables = [...source.matchAll(/<table\b[^>]*class="courses"[^>]*>([\s\S]*?)<\/table>/gi)].map(tableMatch => {
    const tableHtml = tableMatch[1];
    const caption = textFromHtml(tableHtml.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] || "");
    const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(rowMatch => [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => textFromHtml(cell[1])))
      .filter(cells => cells.length)
      .map(cells => ({ code: cells[0] || "", name: cells[1] || "", units: cells[2] || "", note: cells[3] || "" }));
    return { caption, rows };
  });
  return { paragraphs, courseTables, text: textFromHtml(source) };
}

function extractProgramBlocks(source) {
  const starts = [...source.matchAll(/<div\s+class="program"\s+id="([^"]+)">/gi)];
  return starts.map(match => {
    const start = match.index;
    const tokenPattern = /<\/?div\b[^>]*>/gi;
    tokenPattern.lastIndex = start;
    let depth = 0;
    let end = source.length;
    let token;
    while ((token = tokenPattern.exec(source))) {
      if (/^<div\b/i.test(token[0])) depth += 1;
      else depth -= 1;
      if (depth === 0) {
        end = tokenPattern.lastIndex;
        break;
      }
    }
    const block = source.slice(start, end);
    const header = block.match(/<div class="program_header"><a[^>]*>([^<]+)<\/a>/i)?.[1] || match[1];
    const courseSubject = block.match(/<div class="program_courses"[^>]*id="([A-Z]{2,5})"/i)?.[1] || null;
    const features = extractDocumentFeatures(block);
    return { id: match[1], header: textFromHtml(header), courseSubject, ...features };
  });
}

function fullCourseReferences(text) {
  const stopwords = new Set(["AND", "OR", "THE", "FOR", "WITH", "FROM", "ONE", "TWO", "ANY", "BE", "AS", "IF", "IN", "OF", "TO"]);
  return [...text.matchAll(/\b([A-Z]{2,5})\s*-?\s*(\d{3})\b/gi)]
    .filter(match => !stopwords.has(match[1].toUpperCase()))
    .map(match => `${match[1].toUpperCase()} ${match[2]}`);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizedName(value) {
  return value.toLowerCase().replace(/\band\b/g, "").replace(/[^a-z0-9]/g, "");
}

function sectionLabel(html) {
  return html.match(/<(?:strong|b)>\s*([^<]+?)\s*<\/(?:strong|b)>/i)?.[1]?.trim() || "Catalog requirement text";
}

function isRequirementParagraph(paragraph) {
  const lower = paragraph.text.toLowerCase();
  const hasRequirementLabel = paragraph.isHeading || /<(?:strong|b)>/i.test(paragraph.html);
  return hasRequirementLabel && /\bmajor\b|\bcognate\b|\btrack\b|\bconcentration\b|\bpathway\b|\blicensure\b|\bculminating experience\b/.test(lower) && !/^minor\b/i.test(paragraph.text.trim());
}

function requirementSections(block) {
  return block.paragraphs
    .filter(isRequirementParagraph)
    .map(paragraph => ({
      label: paragraph.isHeading ? paragraph.text : sectionLabel(paragraph.html),
      text: paragraph.text,
      courseReferences: unique(fullCourseReferences(paragraph.text)),
      parserConfidence: fullCourseReferences(paragraph.text).length ? "MEDIUM" : "LOW",
      reviewerStatus: "DRAFT_REVIEW_REQUIRED"
    }));
}

function variantFromLabel(program, block, label, text, index) {
  const normalized = label.replace(/[:\-]/g, " ").replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const degree = /bachelor of science|\bB\.S\.\b/i.test(normalized) ? "BS" : /bachelor of arts|\bB\.A\.\b/i.test(normalized) ? "BA" : null;
  const specificMajor = /\bmajor\b/i.test(normalized) && !/^(major|major in)$/i.test(normalized);
  const overlayType = /concentration/i.test(normalized) ? "concentration" : /track/i.test(normalized) ? "track" : /pathway|licensure|program/i.test(normalized) || specificMajor ? "pathway" : degree ? "degree_variant" : null;
  if (!degree && !overlayType) return null;
  const name = normalized
    .replace(/^(major|major in)\s*/i, "")
    .replace(/\s*:\s*$/, "")
    .trim() || `${program.name} variant`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    id: `${program.id}-${slug || `variant-${index + 1}`}`,
    programId: program.id,
    label: name,
    degree,
    concentration: overlayType === "concentration" ? name : null,
    track: overlayType === "track" ? name : null,
    overlayType,
    sourceStatus: "DRAFT_REVIEW_REQUIRED",
    reviewStatus: "PENDING_ADVISOR_APPROVAL",
    sourceUrl: program.sourceUrl,
    sourceCatalogBlockId: block.id,
    sourceText: text,
    requirementMapping: "draft_requires_advisor_approval"
  };
}

const blocks = extractProgramBlocks(html);
const blocksById = new Map(blocks.map(block => [block.id, block]));
const findBlock = program => blocksById.get(program.id) || blocks.find(block => normalizedName(block.header) === normalizedName(program.name));
const variantRecords = [];
const requirementRecords = [];
const prerequisiteRecords = {};
const auditRows = [];
const sourceConflictRows = [];

async function readProgramPageFeatures(program) {
  try {
    const fileName = path.basename(new URL(program.sourceUrl).pathname);
    return extractDocumentFeatures(await readFile(path.join(catalogDir, fileName), "utf8"));
  } catch {
    return { paragraphs: [], courseTables: [], text: "" };
  }
}

for (const program of programs) {
  const block = findBlock(program);
  const pageFeatures = await readProgramPageFeatures(program);
  const sourceBlock = block ? {
    ...block,
    paragraphs: [...block.paragraphs, ...pageFeatures.paragraphs.filter(paragraph => paragraph.isHeading)],
    courseTables: block.courseTables.length ? block.courseTables : pageFeatures.courseTables
  } : null;
  const sections = sourceBlock ? requirementSections(sourceBlock) : [];
  const requirementText = sections.map(section => `${section.label}: ${section.text}`).join("\n\n");
  const cognateSections = sections.filter(section => /cognate/i.test(`${section.label} ${section.text}`));
  const prerequisiteSections = sourceBlock?.paragraphs.filter(paragraph => /prerequisite|must be taken|admission|permission|passing grade|requires?\b/i.test(paragraph.text)).map(paragraph => ({
    text: paragraph.text,
    courseReferences: unique(fullCourseReferences(paragraph.text)),
    reviewerStatus: "DRAFT_REVIEW_REQUIRED"
  })) || [];

  const baseVariant = {
    id: `${program.id}-base`,
    programId: program.id,
    label: program.name,
    degree: block?.text.match(/Bachelor of Science|Bachelor of Arts/i)?.[0]?.toUpperCase().includes("SCIENCE") ? "BS" : "BA",
    concentration: null,
    track: null,
    overlayType: null,
    sourceStatus: program.id === "economics" ? "APPROVED_LOCAL_SOURCE" : "DRAFT_REVIEW_REQUIRED",
    sourceUrl: program.sourceUrl,
    sourceCatalogBlockId: block?.id || null,
    sourceText: block?.text || null,
    requirementMapping: program.id === "economics" ? "approved_local_economics_map" : "draft_requires_advisor_approval"
  };
  const discoveredVariants = [];
  for (const section of sections) {
    const variant = variantFromLabel(program, block, section.label, section.text, discoveredVariants.length);
    if (variant && !discoveredVariants.some(item => item.id === variant.id)) discoveredVariants.push(variant);
  }
  variantRecords.push(baseVariant, ...discoveredVariants);
  const variantIds = [baseVariant, ...discoveredVariants].map(variant => variant.id);
  requirementRecords.push({
    programId: program.id,
    catalogYear,
    sourceUrl: program.sourceUrl,
    sourceCatalogBlockId: block?.id || null,
    sourceStatus: program.id === "economics" ? "APPROVED_LOCAL_SOURCE" : "DRAFT_REVIEW_REQUIRED",
    reviewStatus: program.id === "economics" ? "ADVISOR_APPROVED_LOCAL_SOURCE" : "PENDING_ADVISOR_APPROVAL",
    requirementTree: null,
    variantIds,
    requirementText,
    requirementSections: sections,
    courseTables: sourceBlock?.courseTables || [],
    cognateSections,
    sourceNote: block ? "Official catalog requirement text normalized into reviewable sections; ambiguous choices remain draft until advisor approval." : "No matching official program block was found in the captured catalog home.",
    catalogBlockFound: Boolean(block)
  });
  prerequisiteRecords[program.id] = {
    sourceStatus: program.id === "economics" ? "APPROVED_LOCAL_SOURCE" : "DRAFT_REVIEW_REQUIRED",
    reviewStatus: program.id === "economics" ? "ADVISOR_APPROVED_LOCAL_SOURCE" : "PENDING_ADVISOR_APPROVAL",
    rules: prerequisiteSections,
    cognates: cognateSections.map(section => ({ label: section.label, text: section.text, courseReferences: section.courseReferences }))
  };

  if (!block) {
    sourceConflictRows.push([
      program.sourceUrl,
      "https://catalog.hanover.edu/",
      "program_requirements",
      `No detailed catalog block matched ${program.name}; retain the captured program page and require advisor review before mapping.`,
      "PENDING_ADVISOR_REVIEW",
      "",
      ""
    ]);
  }

  if (sections.length) {
    for (const section of sections) {
      auditRows.push([program.name, `${program.id}-base`, section.label, section.text, program.sourceUrl, section.parserConfidence, section.reviewerStatus, "", "", ""]);
    }
  } else {
    auditRows.push([program.name, `${program.id}-base`, "", "", program.sourceUrl, "LOW", "DRAFT_REVIEW_REQUIRED", "No major requirement section parsed", "", ""]);
  }
}

const normalizedPrograms = programs.map(program => {
  const programVariants = variantRecords.filter(variant => variant.programId === program.id);
  const block = findBlock(program);
  return {
    ...program,
    sourceCatalogBlockId: block?.id || null,
    catalogBlockFound: Boolean(block),
    variants: programVariants.map(variant => variant.id),
    variantCount: programVariants.length,
    requirementMapping: program.id === "economics" ? "approved_local_economics_map" : "not_published_until_review"
  };
});

function csv(value) {
  return `"${String(value ?? "").replaceAll('"', '""').replaceAll("\r", " ").replaceAll("\n", " ")}"`;
}

const csvHeader = ["program", "program_variant", "requirement_id", "normalized_rule", "source_url", "parser_confidence", "reviewer_status", "conflict_note", "approved_by", "approval_date"];
const conflictHeader = ["source_a", "source_b", "field", "conflict_note", "status", "reviewer", "review_date"];
await writeFile(path.join(normalizedDir, "program-variants.json"), `${JSON.stringify(variantRecords, null, 2)}\n`, "utf8");
await writeFile(path.join(normalizedDir, "programs.json"), `${JSON.stringify(normalizedPrograms, null, 2)}\n`, "utf8");
await writeFile(path.join(normalizedDir, "requirements.json"), `${JSON.stringify(requirementRecords, null, 2)}\n`, "utf8");
await writeFile(path.join(normalizedDir, "prerequisites.json"), `${JSON.stringify(prerequisiteRecords, null, 2)}\n`, "utf8");
await writeFile(path.join(reviewDir, `hanover_catalog_${catalogYear}_audit.csv`), `${csvHeader.map(csv).join(",")}\n${auditRows.map(row => row.map(csv).join(",")).join("\n")}\n`, "utf8");
await writeFile(path.join(reviewDir, "source_conflicts.csv"), `${conflictHeader.map(csv).join(",")}\n${sourceConflictRows.map(row => row.map(csv).join(",")).join("\n")}${sourceConflictRows.length ? "\n" : ""}`, "utf8");

console.log(`Normalized ${programs.length} Hanover major inventory records from ${blocks.length} official catalog blocks; generated ${variantRecords.length} reviewable variants.`);
