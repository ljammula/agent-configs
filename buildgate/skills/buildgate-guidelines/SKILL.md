---
name: buildgate-guidelines
description: Coding discipline for unattended buildgate build rounds. Use when writing or changing code for a ticket - make surgical changes, keep it minimal, state assumptions instead of asking, and define verifiable success.
---

# Buildgate guidelines

Adapted from the Karpathy guidelines (karpathy-guidelines) for an unattended run: nobody can answer a question until the round ends.

## 1. Think before coding

- State your assumptions in your final message. When the ticket is ambiguous, choose the most conservative reading consistent with its text and its `Allowed-Files`, say which reading you chose, and proceed.
- If a simpler approach than the ticket's plan exists and still meets every criterion, prefer it and say why.

## 2. Simplicity first

- No features beyond what the ticket asks. No abstractions for single-use code, no configurability nobody requested, no error handling for impossible cases.
- If 200 lines could be 50, rewrite it.

## 3. Surgical changes

- Touch only what the ticket needs. Do not reformat, rename or refactor adjacent code; match the existing style.
- Remove only what your own change made unused. Leave pre-existing dead code; mention it in your final message instead.
- Every changed line should trace to the ticket.

## 4. Goal-driven execution

- Turn the ticket into checks: "add validation" means tests for invalid input that fail first, then pass; "fix the bug" means a test that reproduces it, then passes.
- Loop until the ticket's `Verify-Command` passes.
