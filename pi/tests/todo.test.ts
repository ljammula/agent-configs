import assert from "node:assert/strict";
import test from "node:test";
import todo from "../extensions/todo.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

// Minimal stand-in for pi-tui's Theme -- exercises the same `.fg`/`.bold`
// call shape the real renderers use, without needing the real ANSI theme.
const fakeTheme = {
	fg: (_color: string, text: unknown) => String(text),
	bold: (t: string) => t,
} as any;

function getTodoTool(harness: ExtensionHarness) {
	const tool = harness.tools.get("todo");
	if (!tool) throw new Error("todo tool was not registered");
	return tool;
}

test("renderResult falls back to the raw result text for an unrecognized details shape, instead of returning undefined", () => {
	// Live-crashed and root-caused 2026-08-12: a real /goal session against
	// personal-budget-simplifier (OTEL-metrics task) crashed pi's whole TUI
	// process with "Cannot read properties of undefined (reading 'render')"
	// after the model emitted a malformed `todo` call. pi's own tool-argument
	// validator correctly rejected it, producing a result with `details: {}`
	// (a real, truthy object -- not undefined) and `isError: true`. The old
	// `switch (details.action)` had no `default:` case, so it silently fell
	// through and returned `undefined` for this shape; tool-execution.js's
	// success-path `renderContainer.addChild(component)` pushes that
	// unguarded, crashing the next render. See
	// pi-harness-validation-status.md for the full root-cause account,
	// including the live session log this reproduces.
	const harness = new ExtensionHarness();
	todo(harness.api);
	const tool = getTodoTool(harness);

	const rejectedResult = {
		content: [
			{
				type: "text",
				text: 'Validation failed for tool "todo":\n  - action: must have required properties action',
			},
		],
		details: {},
		isError: true,
	};

	const component = tool.renderResult(rejectedResult, { expanded: false }, fakeTheme, {});

	assert.notEqual(component, undefined);
	assert.equal(component.text, rejectedResult.content[0].text);
});

test("renderResult still handles all four real actions correctly", () => {
	const harness = new ExtensionHarness();
	todo(harness.api);
	const tool = getTodoTool(harness);

	const list = tool.renderResult(
		{ content: [{ type: "text", text: "" }], details: { action: "list", todos: [], nextId: 1 } },
		{ expanded: false },
		fakeTheme,
		{},
	);
	assert.notEqual(list, undefined);

	const add = tool.renderResult(
		{
			content: [{ type: "text", text: "" }],
			details: { action: "add", todos: [{ id: 1, text: "a task", done: false }], nextId: 2 },
		},
		{ expanded: false },
		fakeTheme,
		{},
	);
	assert.notEqual(add, undefined);

	const toggle = tool.renderResult(
		{ content: [{ type: "text", text: "Todo #1 completed" }], details: { action: "toggle", todos: [], nextId: 1 } },
		{ expanded: false },
		fakeTheme,
		{},
	);
	assert.notEqual(toggle, undefined);

	const clear = tool.renderResult(
		{ content: [{ type: "text", text: "" }], details: { action: "clear", todos: [], nextId: 1 } },
		{ expanded: false },
		fakeTheme,
		{},
	);
	assert.notEqual(clear, undefined);
});

test("renderResult still handles the explicit-error branch (e.g. toggle on an unknown id)", () => {
	const harness = new ExtensionHarness();
	todo(harness.api);
	const tool = getTodoTool(harness);

	const component = tool.renderResult(
		{
			content: [{ type: "text", text: "Todo #99 not found" }],
			details: { action: "toggle", todos: [], nextId: 1, error: "#99 not found" },
		},
		{ expanded: false },
		fakeTheme,
		{},
	);
	assert.notEqual(component, undefined);
});
