import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

late String exePath;

Future<ProcessResult> run(List<String> args, String cwd) {
  return Process.run(exePath, args, workingDirectory: cwd);
}

void main() {
  setUpAll(() async {
    final buildDir = Directory.systemTemp.createTempSync('notes_app_build_');
    exePath = '${buildDir.path}/notes_app';
    final result = await Process.run(
      'dart',
      ['compile', 'exe', 'bin/notes_app.dart', '-o', exePath],
    );
    if (result.exitCode != 0) {
      fail('failed to compile notes_app:\n${result.stdout}\n${result.stderr}');
    }
  });

  late Directory workDir;

  setUp(() {
    workDir = Directory.systemTemp.createTempSync('notes_app_test_');
  });

  tearDown(() {
    workDir.deleteSync(recursive: true);
  });

  test('add prints the assigned id and persists the note', () async {
    final r1 =
        await run(['add', 'Buy milk', '--priority', '2'], workDir.path);
    expect(r1.stdout.toString().trim(), 'Added note 1');

    final r2 = await run([
      'add',
      'Write report',
      '--body',
      'due Friday',
      '--priority',
      '1'
    ], workDir.path);
    expect(r2.stdout.toString().trim(), 'Added note 2');

    final file = File('${workDir.path}/notes.json');
    expect(file.existsSync(), isTrue);
    final json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    expect(json['next_id'], 3);
    final notes = json['notes'] as List;
    expect(notes.length, 2);
    expect(notes[0]['title'], 'Buy milk');
    expect(notes[0]['priority'], 2);
    expect(notes[0]['done'], false);
    expect(notes[1]['body'], 'due Friday');
  });

  test('add defaults body to empty string and priority to 3', () async {
    await run(['add', 'Simple task'], workDir.path);
    final json = jsonDecode(File('${workDir.path}/notes.json').readAsStringSync())
        as Map<String, dynamic>;
    final note = (json['notes'] as List).single as Map<String, dynamic>;
    expect(note['body'], '');
    expect(note['priority'], 3);
  });

  test('list shows all notes in id order with status and priority', () async {
    await run(['add', 'Task A', '--priority', '2'], workDir.path);
    await run(['add', 'Task B', '--priority', '1'], workDir.path);
    await run(['done', '1'], workDir.path);

    final r = await run(['list'], workDir.path);
    final lines = const LineSplitter().convert(r.stdout.toString().trim());
    expect(lines, [
      '1 [done] (p2) Task A',
      '2 [pending] (p1) Task B',
    ]);
  });

  test('list with no notes prints "No notes"', () async {
    final r = await run(['list'], workDir.path);
    expect(r.stdout.toString().trim(), 'No notes');
  });

  test('list filters by status', () async {
    await run(['add', 'Task A'], workDir.path);
    await run(['add', 'Task B'], workDir.path);
    await run(['done', '1'], workDir.path);

    final pending = await run(['list', '--status', 'pending'], workDir.path);
    expect(pending.stdout.toString().trim(), '2 [pending] (p3) Task B');

    final done = await run(['list', '--status', 'done'], workDir.path);
    expect(done.stdout.toString().trim(), '1 [done] (p3) Task A');
  });

  test('done marks a note complete and reports unknown ids', () async {
    await run(['add', 'Task A'], workDir.path);

    final ok = await run(['done', '1'], workDir.path);
    expect(ok.stdout.toString().trim(), 'Marked note 1 as done');

    final missing = await run(['done', '99'], workDir.path);
    expect(missing.stdout.toString().trim(), 'Note 99 not found');
    expect(missing.exitCode, 1);
  });

  test('remove deletes a note and reports unknown ids', () async {
    await run(['add', 'Task A'], workDir.path);
    await run(['add', 'Task B'], workDir.path);

    final ok = await run(['remove', '1'], workDir.path);
    expect(ok.stdout.toString().trim(), 'Removed note 1');

    final list = await run(['list'], workDir.path);
    expect(list.stdout.toString().trim(), '2 [pending] (p3) Task B');

    final missing = await run(['remove', '1'], workDir.path);
    expect(missing.stdout.toString().trim(), 'Note 1 not found');
    expect(missing.exitCode, 1);
  });

  test('ids are never reused after removal', () async {
    await run(['add', 'Task A'], workDir.path);
    await run(['add', 'Task B'], workDir.path);
    await run(['remove', '1'], workDir.path);

    final r = await run(['add', 'Task C'], workDir.path);
    expect(r.stdout.toString().trim(), 'Added note 3');
  });

  test('search is case-insensitive and matches title or body', () async {
    await run(['add', 'Buy milk', '--body', 'from the store'], workDir.path);
    await run(['add', 'Write report', '--body', 'due Friday'], workDir.path);

    final r = await run(['search', 'MILK'], workDir.path);
    expect(r.stdout.toString().trim(), '1 [pending] (p3) Buy milk');

    final r2 = await run(['search', 'friday'], workDir.path);
    expect(r2.stdout.toString().trim(), '2 [pending] (p3) Write report');

    final r3 = await run(['search', 'nope'], workDir.path);
    expect(r3.stdout.toString().trim(), 'No notes found');
  });

  test('sorted orders by priority then id, stable for ties', () async {
    await run(['add', 'Task A', '--priority', '3'], workDir.path);
    await run(['add', 'Task B', '--priority', '1'], workDir.path);
    await run(['add', 'Task C', '--priority', '3'], workDir.path);
    await run(['add', 'Task D', '--priority', '2'], workDir.path);

    final r = await run(['sorted'], workDir.path);
    final lines = const LineSplitter().convert(r.stdout.toString().trim());
    expect(lines, [
      '2 [pending] (p1) Task B',
      '4 [pending] (p2) Task D',
      '1 [pending] (p3) Task A',
      '3 [pending] (p3) Task C',
    ]);
  });

  test('sorted with no notes prints "No notes"', () async {
    final r = await run(['sorted'], workDir.path);
    expect(r.stdout.toString().trim(), 'No notes');
  });

  test('full workflow persists state across separate invocations', () async {
    await run(['add', 'Plan trip', '--priority', '2'], workDir.path);
    await run(['add', 'Pack bags', '--priority', '1'], workDir.path);
    await run(['done', '1'], workDir.path);
    await run(['add', 'Buy snacks', '--priority', '3'], workDir.path);
    await run(['remove', '2'], workDir.path);

    final r = await run(['list'], workDir.path);
    final lines = const LineSplitter().convert(r.stdout.toString().trim());
    expect(lines, [
      '1 [done] (p2) Plan trip',
      '3 [pending] (p3) Buy snacks',
    ]);
  });
}
