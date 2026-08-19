# sequential_runner

A small Dart package exposing `SequentialRunner.runAll`, which runs a list of
async tasks one at a time, in order — each task is awaited to completion
before the next one starts — and returns their results in input order.

## Usage

```dart
import 'package:sequential_runner/sequential_runner.dart';

final results = await SequentialRunner.runAll<int>([
  () async => 1,
  () async => 2,
]);
```

## Build, run, and test

Requires the Dart SDK (>= 3.0.0).

```sh
dart pub get      # fetch dependencies
dart analyze      # static analysis
dart test         # run the test suite
```

`make verify` is the canonical check; it runs `dart test` (the `test` and
`lint` targets run the same command, since the project has no separate lint
step).
