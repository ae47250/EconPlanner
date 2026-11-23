import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const panel = path.join(process.cwd(), "tests/panel");

async function plan(studentId) {
  return JSON.parse(await readFile(path.join(panel, "plans", `${studentId}.json`), "utf8"));
}

function placements(result) {
  return result.plans.map(item => ({
    name: item.name,
    status: item.status,
    terms: item.terms.map(term => ({ id: term.termId, courses: term.courses.map(course => course.course) }))
  }));
}

test("study-abroad panel cases reserve Winter and the following May", async () => {
  const [baseline, winterAndMay, winter] = await Promise.all([plan("15"), plan("20"), plan("21")]);
  for (const result of [winterAndMay, winter]) {
    assert.notDeepEqual(placements(result), placements(baseline), `student ${result.studentId} should differ from student 15`);
    for (const item of result.plans) {
      const abroad = item.terms.find(term => term.termId === "winter-2027");
      assert.equal(abroad?.courses.length ?? 0, 0, `student ${result.studentId} has a Winter 2027 course`);
    }
  }
  for (const item of winterAndMay.plans) {
    const may = item.terms.find(term => term.termId === "spring-2027");
    assert.equal(may?.courses.length ?? 0, 0, "student 20 has a May 2027 course");
  }
});
