import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "..");
const TOOLS = join(ROOT, "scripts", "docwriter");
const FIXTURES = join(ROOT, "tests", "fixtures", "docwriter");

function runPython(script: string, args: string[]): string {
  return execFileSync("uv", ["run", "--project", TOOLS, "python", join(TOOLS, script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

test("extracts the document-writer fixtures and builds a DOCX", () => {
  const output = mkdtempSync(join(tmpdir(), "docwriter-test-"));
  const extracted = JSON.parse(runPython("extract_sources.py", [join(FIXTURES, "sources")])) as Array<{ path: string; text: string }>;
  assert.equal(extracted.length, 2);
  assert.ok(extracted.some((source) => source.path.endsWith("review-policy.md")));
  assert.ok(extracted.some((source) => source.text.includes("temporary render images")));

  const markdown = join(output, "draft.md");
  const docx = join(output, "draft.docx");
  writeFileSync(markdown, "# Title\n\n#### Flattened heading\n\nBody.");
  runPython("build_docx.py", [markdown, docx]);
  const documentXml = execFileSync("unzip", ["-p", docx, "word/document.xml"], { encoding: "utf8" });
  assert.match(documentXml, /Heading3/);
  assert.doesNotMatch(documentXml, />#### Flattened heading</);
  assert.ok(readFileSync(docx).length > 0);
});
