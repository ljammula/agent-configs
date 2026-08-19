import 'notes_client.dart';

/// In-memory view-model wrapping a [NotesApiClient] for a UI layer. See
/// spec.md for the exact behavior of each member.
class NotesViewModel {
  NotesViewModel(this.client);

  final NotesApiClient client;

  final List<Note> _notes = [];

  List<Note> get notes {
    final sorted = List<Note>.of(_notes);
    sorted.sort((a, b) => a.priority.compareTo(b.priority));
    return List.unmodifiable(sorted);
  }

  List<Note> get pending => notes.where((n) => !n.done).toList();

  List<Note> get completed => notes.where((n) => n.done).toList();

  Future<void> load() async {
    _notes
      ..clear()
      ..addAll(await client.listNotes());
  }

  Future<Note> addNote({
    required String title,
    String body = '',
    int priority = 3,
  }) async {
    final note = await client.createNote(
      title: title,
      body: body,
      priority: priority,
    );
    _notes.add(note);
    return note;
  }

  Future<void> toggleDone(String id) async {
    final index = _notes.indexWhere((n) => n.id == id);
    if (index == -1) {
      throw ArgumentError('no note with id $id');
    }
    final current = _notes[index];
    final updated = await client.updateNote(id, done: !current.done);
    _notes[index] = updated;
  }

  Future<void> remove(String id) async {
    final index = _notes.indexWhere((n) => n.id == id);
    if (index == -1) {
      throw ArgumentError('no note with id $id');
    }
    await client.deleteNote(id);
    _notes.removeAt(index);
  }
}
