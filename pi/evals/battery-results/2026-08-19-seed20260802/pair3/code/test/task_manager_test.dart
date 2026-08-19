import 'package:task_manager/task_manager.dart';
import 'package:test/test.dart';

void main() {
  test('addTask assigns unique ids and stores tasks', () {
    final m = TaskManager();
    final a = m.addTask('write spec');
    final b = m.addTask('build runner', priority: 5);

    expect(a.id, isNot(equals(b.id)));
    expect(a.title, 'write spec');
    expect(a.done, isFalse);
    expect(b.priority, 5);
    expect(m.listTasks().length, 2);
  });

  test('completeTask marks a task done and throws for unknown id', () {
    final m = TaskManager();
    final a = m.addTask('write spec');

    m.completeTask(a.id);
    expect(m.listTasks().single.done, isTrue);

    expect(() => m.completeTask('does-not-exist'), throwsArgumentError);
  });

  test('removeTask removes a task and throws for unknown id', () {
    final m = TaskManager();
    final a = m.addTask('write spec');
    final b = m.addTask('build runner');

    m.removeTask(a.id);
    expect(m.listTasks().map((t) => t.id), [b.id]);

    expect(() => m.removeTask(a.id), throwsArgumentError);
  });

  test('listTasks filters by done status and preserves insertion order', () {
    final m = TaskManager();
    final a = m.addTask('first');
    final b = m.addTask('second');
    final c = m.addTask('third');
    m.completeTask(b.id);

    expect(m.listTasks().map((t) => t.title), ['first', 'second', 'third']);
    expect(m.listTasks(done: true).map((t) => t.title), ['second']);
    expect(m.listTasks(done: false).map((t) => t.title), ['first', 'third']);
    expect(a.title, 'first');
    expect(c.title, 'third');
  });

  test('sortedByPriority sorts descending and is stable for ties', () {
    final m = TaskManager();
    m.addTask('low', priority: 1);
    m.addTask('high-a', priority: 5);
    m.addTask('mid', priority: 3);
    m.addTask('high-b', priority: 5);

    expect(
      m.sortedByPriority().map((t) => t.title),
      ['high-a', 'high-b', 'mid', 'low'],
    );
  });

  test('toJson/loadJson round-trip preserves tasks and order', () {
    final m = TaskManager();
    m.addTask('first', priority: 2);
    final b = m.addTask('second', priority: 7);
    m.completeTask(b.id);

    final json = m.toJson();
    expect(json.length, 2);

    final m2 = TaskManager();
    m2.loadJson(json);

    expect(m2.listTasks().map((t) => t.title), ['first', 'second']);
    expect(m2.listTasks().map((t) => t.priority), [2, 7]);
    expect(m2.listTasks().map((t) => t.done), [false, true]);

    // addTask after loadJson must not collide with loaded ids.
    final c = m2.addTask('third');
    final ids = m2.listTasks().map((t) => t.id).toList();
    expect(ids.toSet().length, ids.length);
    expect(c.title, 'third');
  });
}
