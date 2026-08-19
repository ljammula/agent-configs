# notes_app

A small command-line notes/task app in Dart. State is persisted in
`notes.json` in the current working directory.

## Build / run

```sh
dart pub get
dart run bin/notes_app.dart <command> [args]
```

Commands: `add <title> [--body <text>] [--priority <n>]`,
`list [--status pending|done|all]`, `done <id>`, `remove <id>`,
`search <query>`, `sorted`.

## Test

```sh
dart test
```

`make verify` (or `make test` / `make lint`) runs the same check.
