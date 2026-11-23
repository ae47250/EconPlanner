import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const roots = ["app", "lib", "policy/rules", "templates"];
const excluded = new Set(["policy/messages/en-US.json"]);
const files = [];
async function walk(relative) {
  for (const entry of await readdir(relative, { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) await walk(name);
    else if (/\.(?:js|jsx|mjs|json|html)$/.test(entry.name) && !excluded.has(name)) files.push(name);
  }
}
for (const root of roots) await walk(root);
const sentenceLike = /(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`)|>([^<>{}\n]+)</g;
let total = 0;
for (const file of files.sort()) {
  const source = await readFile(file, "utf8");
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    sentenceLike.lastIndex = 0;
    let match;
    while ((match = sentenceLike.exec(line))) {
      const value = (match[1] || match[2] || match[3] || match[4]).trim();
      const words = value.match(/[\p{L}\p{N}]+(?:[’'/-][\p{L}\p{N}]+)*/gu) || [];
      if (words.length < 4) continue;
      total++;
      console.log(`${file}:${index + 1}: ${value}`);
    }
  }
}
console.log(`Student-facing sentence source candidates: ${total}`);
