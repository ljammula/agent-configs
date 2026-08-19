import 'dart:io';

import 'package:notes_app/notes_app.dart';

/// Entrypoint: `dart run bin/notes_app.dart <command> [args]`.
/// See spec.md for the full command reference (add, list, done, remove,
/// search, sorted) and the notes.json persistence format.
void main(List<String> arguments) {
  final storeFile = File('notes.json');
  final store = NotesStore.load(storeFile);

  if (arguments.isEmpty) {
    stderr.writeln('Usage: dart run bin/notes_app.dart <command> [args]');
    exit(1);
  }

  final command = arguments.first;
  final rest = arguments.sublist(1);

  switch (command) {
    case 'add':
      String title = '';
      String body = '';
      int priority = 3;
      var i = 0;
      while (i < rest.length) {
        final arg = rest[i];
        if (arg == '--body' && i + 1 < rest.length) {
          i++;
          body = rest[i];
        } else if (arg == '--priority' && i + 1 < rest.length) {
          i++;
          priority = int.parse(rest[i]);
        } else if (title.isEmpty) {
          title = arg;
        }
        i++;
      }
      final note = store.add(title: title, body: body, priority: priority);
      store.save(storeFile);
      print('Added note ${note.id}');
      break;
    case 'list':
      String status = 'all';
      for (var i = 0; i < rest.length; i++) {
        if (rest[i] == '--status' && i + 1 < rest.length) {
          status = rest[i + 1];
        } else if (rest[i].startsWith('--status=')) {
          status = rest[i].substring('--status='.length);
        }
      }
      final notes = store.list(status: status);
      if (notes.isEmpty) {
        print('No notes');
      } else {
        for (final n in notes) {
          print(formatNote(n));
        }
      }
      break;
    case 'done':
      final id = int.parse(rest.first);
      if (store.markDone(id)) {
        store.save(storeFile);
        print('Marked note $id as done');
      } else {
        print('Note $id not found');
        exit(1);
      }
      break;
    case 'remove':
      final id = int.parse(rest.first);
      if (store.remove(id)) {
        store.save(storeFile);
        print('Removed note $id');
      } else {
        print('Note $id not found');
        exit(1);
      }
      break;
    case 'search':
      final matches = store.search(rest.join(' '));
      if (matches.isEmpty) {
        print('No notes found');
      } else {
        for (final n in matches) {
          print(formatNote(n));
        }
      }
      break;
    case 'sorted':
      final notes = store.sortedByPriority();
      if (notes.isEmpty) {
        print('No notes');
      } else {
        for (final n in notes) {
          print(formatNote(n));
        }
      }
      break;
    default:
      stderr.writeln('Unknown command: $command');
      exit(1);
  }
}
