/// A single task tracked by [TaskManager].
class Task {
  final String id;
  String title;
  int priority; // higher = more important
  bool done;

  Task({
    required this.id,
    required this.title,
    this.priority = 0,
    this.done = false,
  });
}

/// Manages a list of [Task]s. See spec.md for the required behavior of each
/// method below.
class TaskManager {
  final List<Task> _tasks = [];
  int _nextId = 1;

  Task _byId(String id) {
    for (final task in _tasks) {
      if (task.id == id) {
        return task;
      }
    }
    throw ArgumentError('No task with id "$id"');
  }

  /// Creates a new [Task] with a unique id, adds it, and returns it.
  Task addTask(String title, {int priority = 0}) {
    final task = Task(id: '$_nextId', title: title, priority: priority);
    _nextId++;
    _tasks.add(task);
    return task;
  }

  /// Marks the task with [id] as done. Throws [ArgumentError] if not found.
  void completeTask(String id) {
    _byId(id).done = true;
  }

  /// Removes the task with [id]. Throws [ArgumentError] if not found.
  void removeTask(String id) {
    _byId(id);
    _tasks.removeWhere((task) => task.id == id);
  }

  /// Returns tasks in insertion order, optionally filtered by [done].
  List<Task> listTasks({bool? done}) {
    if (done == null) {
      return List<Task>.unmodifiable(_tasks);
    }
    return _tasks.where((task) => task.done == done).toList(growable: false);
  }

  /// Returns all tasks sorted by priority descending (stable).
  List<Task> sortedByPriority() {
    final sorted = List<Task>.of(_tasks);
    sorted.sort((a, b) => b.priority.compareTo(a.priority));
    return sorted;
  }

  /// Serializes all tasks to JSON-ready maps in insertion order.
  List<Map<String, dynamic>> toJson() {
    return _tasks
        .map(
          (task) => <String, dynamic>{
            'id': task.id,
            'title': task.title,
            'priority': task.priority,
            'done': task.done,
          },
        )
        .toList(growable: false);
  }

  /// Replaces the current tasks with tasks built from [data].
  void loadJson(List<Map<String, dynamic>> data) {
    _tasks
      ..clear()
      ..addAll(
        data.map(
          (entry) => Task(
            id: entry['id'] as String,
            title: entry['title'] as String,
            priority: entry['priority'] as int,
            done: entry['done'] as bool,
          ),
        ),
      );
    _nextId =
        _tasks
            .map((task) => int.tryParse(task.id))
            .whereType<int>()
            .fold(0, (max, value) => value > max ? value : max) +
        1;
  }
}
