import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const snapshot = id => readFileSync(new URL(`./snapshots/${id}.txt`, import.meta.url), "utf8");

test("one-year-early course count proves the requested target cannot fit", () => {
  for (const id of ["09", "11"]) {
    const screen = snapshot(id).split("PDF >")[0];
    assert.match(screen, /You cannot finish by May 2027\./);
    assert.doesNotMatch(screen, /Graduate next year:More information needed/);
    assert.doesNotMatch(screen, /A plan may need more than the normal course limit/);
  }
});

test("unused BUSN 323 transfer does not lower plan readiness", () => {
  const screen = snapshot("26").split("PDF >")[0];
  assert.match(screen, /SCREEN > Plan: Balanced\nSTATUS: Ready to plan/);
  assert.doesNotMatch(screen, /Confirm with your advisor that your transfer credit for BUSN 323 counts/);
});

test("student 49 screen and PDF use the same completed math course", () => {
  const text = snapshot("49");
  const screen = text.match(/CHECKLIST ROW: Mathematics (MAT 1(?:13|21)) ✓ Completed/)?.[1];
  const pdf = text.match(/PDF > Plan: Balanced > Checklist[\s\S]*?CHECKLIST CELL: Mathematics\nCHECKLIST CELL: (MAT 1(?:13|21))/)?.[1];
  assert.ok(screen && pdf, "both surfaces must show the Mathematics checklist row");
  assert.equal(screen, pdf);
});
