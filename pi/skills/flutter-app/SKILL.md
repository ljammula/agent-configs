---
name: flutter-app
description: Generic Flutter application development. Use for pubspec.yaml projects and Dart UI, state, service, widget, golden, or integration changes. Do not inject product-specific localization or state-management conventions.
---

# Flutter app

Read `pubspec.yaml`, analysis options, repository instructions, and CI first.

- Keep logic/unit, widget, golden, and integration tests distinct.
- Run the narrowest useful test after each change, then project-wide analyzer and tests at completion.
- Add integration coverage for important multi-widget or service flows.
- Refresh goldens only after visually confirming the intended change.
- Follow project localization and state-management rules; this generic skill does not choose them.
