---
name: daytrix-wiring-verify
description: DayTrix multi-point wiring overlay. Use only for ljammula/personal-assistant when feature grants, routes, middleware, handlers, Flutter controllers, widgets, migrations, or localization are added. Never load in unrelated repositories.
---

# DayTrix wiring overlay

Use the portable `wiring-verify` workflow, then derive the exact checklist from the repository's `AGENTS.md`, architecture docs, and feature spec. Verify every named backend constant/route/middleware/handler/service/repository point and every frontend model/controller/widget/localization point with file-and-line evidence. Run `make verify` after correcting any missing wiring.
