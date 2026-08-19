# task_manager

A small Dart task manager library. `lib/task_manager.dart` provides a `Task`
class and a `TaskManager` with add/complete/remove, ordered and
priority-sorted listing, and JSON persistence (`toJson`/`loadJson`).

## Build / Run / Test

```sh
dart pub get      # install dependencies
dart test         # run the test suite (canonical check)
make verify       # same, via the Makefile
```
