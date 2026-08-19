import 'package:sequential_runner/sequential_runner.dart';
import 'package:test/test.dart';

void main() {
  test('runs tasks one at a time, in order', () async {
    final log = <String>[];

    final tasks = <Future<int> Function()>[
      () async {
        await Future.delayed(const Duration(milliseconds: 50));
        log.add('A');
        return 1;
      },
      () async {
        log.add('B');
        return 2;
      },
    ];

    final results = await SequentialRunner.runAll(tasks);

    expect(log, equals(['A', 'B']));
    expect(results, equals([1, 2]));
  });

  test('returns results in input order for synchronous-ish tasks', () async {
    final tasks = <Future<String> Function()>[
      () async => 'first',
      () async => 'second',
      () async => 'third',
    ];

    final results = await SequentialRunner.runAll(tasks);

    expect(results, equals(['first', 'second', 'third']));
  });
}
