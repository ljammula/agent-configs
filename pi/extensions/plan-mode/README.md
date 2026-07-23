# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Built-in write tools disabled**: Disables bash/edit/write while preserving native read-only tools
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Progress tracking**: Widget shows completion status during execution
- **[DONE:n] markers**: Explicit step completion tracking
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan mode
- `/plan-todos` - Show current plan progress
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Choose "Execute the plan" when prompted
5. During execution, the agent marks steps complete with `[DONE:n]` tags
6. Progress widget shows completion status

## How It Works

### Plan Mode (Read-Only)
- Built-in bash/edit/write tools disabled
- Native read-only tools (`read`, `grep`, `find`, `ls`) remain available
- Agent creates a plan without making changes

### Execution Mode
- Full tool access restored
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress

### Available Inspection Tools

Plan mode keeps PI's native read-only tools enabled:
- `read` for file contents
- `grep` for content search
- `find` for file discovery
- `ls` for directory listings

It disables `bash`, `edit`, and `write`. Shell command allowlists are not a
reliable read-only boundary because shell composition can execute writes.
