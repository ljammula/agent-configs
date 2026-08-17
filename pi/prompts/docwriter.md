---
description: Run the local LLM document-writing pipeline
argument-hint: "<sources-dir> <brief-file> <output-dir>"
---
Use the document-writer CLI from the Pi harness repository.

The source directory is `$1`.
The brief Markdown file is `$2`.
The output directory is `$3`.

Supported source files are `.md`, `.txt`, `.docx`, and
   text-based `.pdf`; scanned PDFs require OCR first.
Run:

   `npm --prefix /Users/kanna/code/agent-configs/pi run docwriter -- run --sources "$1" --brief "$2" --out-dir "$3"`

Read the generated `outline.md`, `draft.md`, and `review.md`.
Report review findings before treating the DOCX as ready. Model output is
   evidence to inspect, not automatic approval.
If the user asks for visual QA, run the generated DOCX through the `render`
   subcommand and inspect every page image before claiming success.

Do not delete source files or generated review artifacts. Keep the brief,
sources, draft, review, and final DOCX together until the user approves the
document.
