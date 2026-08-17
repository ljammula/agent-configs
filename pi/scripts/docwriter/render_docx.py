"""Render DOCX pages through LibreOffice and Poppler."""

from __future__ import annotations

import argparse
import subprocess
import tempfile
from pathlib import Path

from pdf2image import convert_from_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_docx", type=Path)
    parser.add_argument("--output_dir", required=True, type=Path)
    args = parser.parse_args()
    if not args.input_docx.is_file():
        raise SystemExit(f"input DOCX not found: {args.input_docx}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="docwriter-render-") as temp:
        profile = Path(temp) / "lo-profile"
        pdf_dir = Path(temp) / "pdf"
        profile.mkdir()
        pdf_dir.mkdir()
        subprocess.run(
            [
                "soffice",
                "--headless",
                f"-env:UserInstallation=file://{profile}",
                "--convert-to",
                "pdf",
                "--outdir",
                str(pdf_dir),
                str(args.input_docx),
            ],
            check=True,
            timeout=120,
        )
        pdf_path = pdf_dir / f"{args.input_docx.stem}.pdf"
        pages = convert_from_path(str(pdf_path), dpi=150)
        for index, page in enumerate(pages, 1):
            page.save(args.output_dir / f"page-{index}.png")
    print(f"Pages rendered to {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
