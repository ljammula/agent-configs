# Local LLM `.docx` Writing Workflow

## Goal

Use the Pi harness on this workstation to draft, review, and produce professional
`.docx` documents with the local inference service on `kannasmacstudio.lan`.

The model should handle planning, prose, and critique. Deterministic local
scripts should handle document formatting, rendering, and structural checks.

## Implemented MVP

The Pi repository now contains `scripts/docwriter.ts`, which accepts a source
folder containing `.md`, `.txt`, `.docx`, and text-based `.pdf` files. It uses
the configured LAN model for outline, draft, and review calls, then builds a
`.docx` with the isolated Python tools in `scripts/docwriter/`.

Run the complete pipeline with:

```bash
npm run docwriter -- run \\
  --sources ./sources \\
  --brief ./brief.md \\
  --out-dir ./output
```

The output directory contains `outline.md`, `draft.md`, `review.md`, and the
generated `.docx`. Individual `outline`, `draft`, `review`, `build`, and
`render` subcommands are also available. The default raw API requests omit the
Qwen-specific `reasoning_effort` field for compatibility; Pi itself continues
to use its configured `defaultThinkingLevel`. Set
`DOCWRITER_SEND_REASONING_EFFORT=1` only after validating that field against a
current server route.

Set `DOCWRITER_MODEL_ID` when the server exposes more than one model. A
malformed or unreadable source is reported as a warning while other valid
sources continue through the pipeline; the pipeline still fails when no usable
sources remain. Python helper calls have a five-minute timeout.

DOCX/PDF extraction uses the locked `uv` environment in
`scripts/docwriter/`. Scanned or image-only PDFs still require OCR. Visual QA
uses the bundled `scripts/docwriter/render_docx.py` renderer, with
`DOCWRITER_RENDERER` as an override when a different renderer is required.

## Recommended architecture

```text
brief + source files
        |
        v
Pi / Qwen on :8080  --->  outline  --->  Markdown draft
        |                                      |
        |                                      v
        +------------------------------> review findings
                                               |
                                               v
                                  deterministic DOCX builder
                                               |
                                               v
                                  render to page images
                                               |
                                               v
                                      human approval
```

The current Pi provider is configured in `extensions/ai-stack-local.ts` and
uses the live-served `Qwen3.8-27B-8bit` model on port `8080`. The model ID is
statically declared in Pi,
so it must be updated if the served checkpoint changes. Shell clients should
query `GET /v1/models` immediately before making a request and use the exact
returned ID.

## Workflow

### 1. Create a brief

For each document, capture:

- title and audience
- purpose and desired length
- source files
- tone and terminology
- required sections
- citation or evidence requirements
- output filename

Keep the brief in Markdown or YAML so it can be reviewed and reused.

### 2. Normalize source material

Extract text from PDFs, Markdown, existing Word files, or other references.
Preserve filenames and section markers. For large sources, summarize or chunk
them before sending them to the model.

The model must distinguish supplied facts, reasonable inferences, and missing
information. It must not invent names, dates, statistics, quotations, or links.

### 3. Generate and approve an outline

Ask Qwen for a structured outline containing section headings, each section's
purpose, key points, and open questions. Review the outline before generating
the full draft. This is the cheapest point to correct scope or structure.

### 4. Generate a Markdown draft

Use Markdown as the source of truth. Require the draft prompt to specify:

- audience and tone
- allowed source material
- required sections
- citation behavior
- explicit markers for unsupported or unresolved claims
- appropriate use of prose, lists, callouts, and tables

Do not ask the model to generate raw Word XML or rely on it to control page
layout.

### 5. Run a review pass

Use a second Pi request to review the draft for:

- unsupported or contradictory claims
- missing requirements
- unclear or repetitive prose
- terminology drift
- citation problems
- layout risks such as oversized tables or dense sections

The review is evidence for the human author, not an automatic source of truth.
Apply changes only when they are supported by the source material or the brief.

The current `cross-model-review.ts` route is configured for the Gemma reviewer
on port `8081`, but Pi's primary provider currently exposes only Qwen on
`8080`. Until a separate Gemma provider is added, label the review accurately
as a blind self-review rather than an independent review.

### 6. Build the `.docx`

Use a local builder such as `python-docx` or an equivalent deterministic helper.
This repository's Pi harness is a Node.js/TypeScript application, but the DOCX
builder may be a separate Python utility if that produces better Word support.
Keep its dependencies explicit and invoke it from a Pi command or script.
The builder should own:

- page size and margins
- Word styles for title, headings, body text, and lists
- real numbered and bulleted lists
- explicit table widths and cell padding
- headers, footers, and page numbers
- consistent typography and restrained color use

Choose one document design preset per document type. Do not mix formatting
systems or rely on Word defaults for important layout values.

### 7. Render and verify

Render every generated `.docx` to page PNGs using LibreOffice in headless mode,
followed by a PDF-to-image converter such as Poppler's `pdftoppm`, or use the
canonical `render_docx.py` helper from the document tooling. `python-docx` alone
cannot render a Word document. Inspect
all pages for clipping, overlap, broken tables, awkward page breaks, missing
glyphs, inconsistent spacing, and excessive density.

If anything is wrong, fix the Markdown or builder, regenerate the document, and
render it again. A successful text extraction is not sufficient evidence that a
Word document is visually correct.

### 8. Final approval

Before delivery:

- verify names, dates, links, citations, and numbers against the sources
- remove draft notes and review annotations
- run accessibility checks
- optionally scrub sensitive metadata
- deliver only the final `.docx`

## Suggested project layout

```text
doc-writer/
  briefs/
  sources/
  drafts/
  reviews/
  output/
  qa/
  prompts/
  build_docx.py
  run_pipeline.py
```

Useful first commands could be:

```text
docwriter outline briefs/project.md
docwriter draft briefs/project.md
docwriter review drafts/project.md
docwriter build drafts/project.md --output output/project.docx
docwriter render output/project.docx --output-dir qa/project
```

## Implementation order

1. Confirm Pi can reach the model discovery endpoint
   `http://kannasmacstudio.lan:8080/v1/models`.
2. Add a reusable document-writing prompt.
3. Implement outline generation.
4. Implement Markdown drafting and review.
5. Implement Markdown-to-DOCX conversion.
6. Add render-and-inspect QA.
7. Add accessibility, metadata, and reusable template support.
8. Add a second Pi provider for port `8081` if independent review is valuable.

## Security and reliability

- Keep ports `8080` and `8081` restricted to trusted LAN devices.
- Do not expose the inference endpoints through router port forwarding.
- The current endpoints use HTTP, so prompts and source text are not encrypted
  on the LAN. Use TLS, a trusted isolated LAN, or a VPN/tunnel before sending
  sensitive documents.
- Avoid logging sensitive source text or prompts unnecessarily.
- Use request timeouts (for example, 120 seconds), bounded context sizes, and
  limited exponential-backoff retries.
- Save briefs, drafts, reviews, and final outputs separately for reproducibility.
- Treat local-model output as a draft or review signal; perform human approval
  for factual or consequential documents.

## Success criteria

The workflow is ready when it can:

1. Produce a coherent Markdown draft from a brief and source files.
2. Identify unsupported claims during review.
3. Produce a readable `.docx` with consistent styles.
4. Render every page without layout defects.
5. Rebuild the document reproducibly from the Markdown source.
