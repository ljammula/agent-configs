import 'dart:convert';
import 'dart:io';

/// A single note/task. Do not change this class's fields.
class Note {
  final int id;
  final String title;
  final String body;
  final int priority;
  final bool done;

  Note({
    required this.id,
    required this.title,
    this.body = '',
    this.priority = 3,
    this.done = false,
  });

  Note copyWith({String? title, String? body, int? priority, bool? done}) {
    return Note(
      id: id,
      title: title ?? this.title,
      body: body ?? this.body,
      priority: priority ?? this.priority,
      done: done ?? this.done,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'body': body,
        'priority': priority,
        'done': done,
      };

  factory Note.fromJson(Map<String, dynamic> json) => Note(
        id: json['id'] as int,
        title: json['title'] as String,
        body: json['body'] as String? ?? '',
        priority: json['priority'] as int? ?? 3,
        done: json['done'] as bool? ?? false,
      );
}

/// Loads, mutates and persists the notes store backed by a JSON file.
///
/// See spec.md for the exact file format and command behaviors.
class NotesStore {
  int nextId;
  List<Note> notes;

  NotesStore({required this.nextId, required this.notes});

  /// Loads the store from [file]. If the file does not exist, returns an
  /// empty store with nextId = 1.
  factory NotesStore.load(File file) {
    if (!file.existsSync()) {
      return NotesStore(nextId: 1, notes: []);
    }
    final json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    return NotesStore(
      nextId: json['next_id'] as int? ?? 1,
      notes: (json['notes'] as List<dynamic>? ?? [])
          .map((e) => Note.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  /// Writes the store to [file] as JSON (see spec.md for the format).
  void save(File file) {
    file.writeAsStringSync(jsonEncode({
      'next_id': nextId,
      'notes': notes.map((n) => n.toJson()).toList(),
    }));
  }

  /// Adds a new note and returns it. Increments nextId.
  Note add({required String title, String body = '', int priority = 3}) {
    final note = Note(id: nextId, title: title, body: body, priority: priority);
    nextId++;
    notes.add(note);
    return note;
  }

  /// Returns notes filtered by status: 'all', 'pending', or 'done',
  /// in ascending id order.
  List<Note> list({String status = 'all'}) {
    final result = notes.where((n) {
      if (status == 'pending') return !n.done;
      if (status == 'done') return n.done;
      return true;
    }).toList()
      ..sort((a, b) => a.id.compareTo(b.id));
    return result;
  }

  /// Marks the note with the given id as done. Returns true if found,
  /// false otherwise.
  bool markDone(int id) {
    final i = notes.indexWhere((n) => n.id == id);
    if (i == -1) return false;
    notes[i] = notes[i].copyWith(done: true);
    return true;
  }

  /// Removes the note with the given id. Returns true if found and
  /// removed, false otherwise.
  bool remove(int id) {
    final before = notes.length;
    notes.removeWhere((n) => n.id == id);
    return notes.length < before;
  }

  /// Case-insensitive substring search over title and body, in ascending
  /// id order.
  List<Note> search(String query) {
    final q = query.toLowerCase();
    return notes
        .where((n) =>
            n.title.toLowerCase().contains(q) ||
            n.body.toLowerCase().contains(q))
        .toList()
      ..sort((a, b) => a.id.compareTo(b.id));
  }

  /// All notes sorted by priority ascending, ties broken by id ascending
  /// (stable sort).
  List<Note> sortedByPriority() {
    return [...notes]..sort((a, b) {
        final byPriority = a.priority.compareTo(b.priority);
        return byPriority != 0 ? byPriority : a.id.compareTo(b.id);
      });
  }
}

/// Formats a single note line as `<id> [<status>] (p<priority>) <title>`.
String formatNote(Note note) =>
    '${note.id} [${note.done ? 'done' : 'pending'}] (p${note.priority}) ${note.title}';
