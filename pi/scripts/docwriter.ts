import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Source = { path: string; text: string };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, "scripts", "docwriter");
const HOST = process.env.AI_STACK_HOST || "127.0.0.1";
const BASE_URL = process.env.DOCWRITER_BASE_URL || `http://${HOST}:8080/v1`;

function usage(): never {
  console.error(`Usage:
  npm run docwriter -- run --sources DIR --brief FILE --out-dir DIR
  npm run docwriter -- outline --sources DIR --brief FILE --out FILE
  npm run docwriter -- draft --sources DIR --brief FILE --outline FILE --out FILE
  npm run docwriter -- review --sources DIR --draft FILE --out FILE
  npm run docwriter -- build --input FILE --output FILE
  npm run docwriter -- render --input FILE --output-dir DIR`);
  process.exit(2);
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) usage();
  return args[index + 1];
}

function python(script: string, args: string[]): string {
  return execFileSync("uv", ["run", "--project", TOOLS, "python", join(TOOLS, script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 300_000,
    killSignal: "SIGTERM",
  });
}

function sources(directory: string): Source[] {
  const path = resolve(directory);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`source directory does not exist or is not a directory: ${path}`);
  return JSON.parse(python("extract_sources.py", [path])) as Source[];
}

function sourceContext(items: Source[]): string {
  return items.map((item) => `SOURCE: ${item.path}\n${item.text.slice(0, 12000)}`).join("\n\n---\n\n").slice(0, 44000);
}

async function model(prompt: string, thinkingLevel: string, temperature: number): Promise<string> {
  const modelsResponse = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(10_000) });
  if (!modelsResponse.ok) throw new Error(`model discovery failed: HTTP ${modelsResponse.status}`);
  const models = (await modelsResponse.json()) as { data?: Array<{ id: string }> };
  const modelId = process.env.DOCWRITER_MODEL_ID || models.data?.[0]?.id;
  if (!modelId) throw new Error("model discovery returned no model IDs");
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: modelId,
      temperature,
      max_tokens: 6000,
      ...(process.env.DOCWRITER_SEND_REASONING_EFFORT === "1" ? { reasoning_effort: thinkingLevel } : {}),
      messages: [
        { role: "system", content: "You are a careful technical documentation assistant. Use only supplied sources, mark unknowns explicitly, and return the requested artifact without code fences." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(`model request failed: HTTP ${response.status}: ${payload.error?.message || "unknown error"}`);
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("model returned empty content");
  return content.replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/, "").trim() + "\n";
}

function briefAndSources(briefFile: string, sourceDir: string): string {
  return `BRIEF:\n${readFileSync(resolve(briefFile), "utf8")}\n\nSOURCE MATERIAL:\n${sourceContext(sources(sourceDir))}`;
}

async function outline(briefFile: string, sourceDir: string): Promise<string> {
  return model(`Create a concise Markdown outline with a title, audience, ordered sections, key points, and an Open questions section.\n\n${briefAndSources(briefFile, sourceDir)}`, "medium", 0.25);
}

async function draft(briefFile: string, sourceDir: string, outlineFile: string): Promise<string> {
  return model(`Write the complete Markdown document described by this brief and outline. Use clear headings, short paragraphs, real Markdown lists, and tables only for comparable data. Do not invent missing facts.\n\n${briefAndSources(briefFile, sourceDir)}\n\nOUTLINE:\n${readFileSync(resolve(outlineFile), "utf8")}`, "medium", 0.25);
}

async function review(sourceDir: string, draftFile: string): Promise<string> {
  const thinkingLevel = process.env.DOCWRITER_REVIEW_THINKING_LEVEL || "medium";
  return model(`Review this draft against the source material. Return sections titled Must fix, Should improve, and Verified strengths. Identify unsupported claims, omissions, contradictions, unclear prose, and table/layout risks. Do not rewrite the draft.\n\nSOURCE MATERIAL:\n${sourceContext(sources(sourceDir))}\n\nDRAFT:\n${readFileSync(resolve(draftFile), "utf8")}`, thinkingLevel, 0.15);
}

function write(path: string, content: string): void {
  if (!content.trim()) throw new Error(`refusing to write empty output: ${resolve(path)}`);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), content, "utf8");
}

function build(input: string, output: string): void {
  python("build_docx.py", [resolve(input), resolve(output)]);
}

function render(input: string, outputDir: string): void {
  const renderer = process.env.DOCWRITER_RENDERER || join(TOOLS, "render_docx.py");
  if (!existsSync(renderer)) throw new Error(`renderer not found: ${renderer}; set DOCWRITER_RENDERER to a render_docx.py path`);
  execFileSync("uv", ["run", "--project", TOOLS, "python", renderer, resolve(input), "--output_dir", resolve(outputDir)], { cwd: ROOT, stdio: "inherit" });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();
  if (command === "outline") write(option(args, "--out"), await outline(option(args, "--brief"), option(args, "--sources")));
  else if (command === "draft") write(option(args, "--out"), await draft(option(args, "--brief"), option(args, "--sources"), option(args, "--outline")));
  else if (command === "review") write(option(args, "--out"), await review(option(args, "--sources"), option(args, "--draft")));
  else if (command === "build") build(option(args, "--input"), option(args, "--output"));
  else if (command === "render") render(option(args, "--input"), option(args, "--output-dir"));
  else if (command === "run") {
    const sourceDir = option(args, "--sources");
    const briefFile = option(args, "--brief");
    const outDir = resolve(option(args, "--out-dir"));
    mkdirSync(outDir, { recursive: true });
    const outlineFile = join(outDir, "outline.md");
    const draftFile = join(outDir, "draft.md");
    const reviewFile = join(outDir, "review.md");
    const docxFile = join(outDir, `${basename(briefFile, extname(briefFile))}.docx`);
    write(outlineFile, await outline(briefFile, sourceDir));
    write(draftFile, await draft(briefFile, sourceDir, outlineFile));
    write(reviewFile, await review(sourceDir, draftFile));
    build(draftFile, docxFile);
    console.log(JSON.stringify({ outlineFile, draftFile, reviewFile, docxFile }, null, 2));
  } else usage();
}

await main();
