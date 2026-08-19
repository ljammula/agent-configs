import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:notes_client/notes_client.dart';
import 'package:notes_client/notes_view_model.dart';
import 'package:test/test.dart';

/// A fake [http.Client] that simulates the Go notes API in memory,
/// recording outgoing requests for assertions.
class FakeNotesServer extends http.BaseClient {
  final Map<String, Note> store = {};
  int nextId = 1;
  final List<String> requests = [];
  String? lastBody;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add('${request.method} ${request.url.path}');
    lastBody = request is http.Request ? request.body : null;
    final path = request.url.path;
    final idMatch = RegExp(r'^/notes/(\d+)$').firstMatch(path);

    Future<http.StreamedResponse> respond(int status, [Object? body]) async {
      final bytes = body == null ? <int>[] : utf8.encode(jsonEncode(body));
      return http.StreamedResponse(
        Stream.value(bytes),
        status,
        headers: {'content-type': 'application/json'},
      );
    }

    if (path == '/notes' && request.method == 'POST') {
      final map =
          jsonDecode((request as http.Request).body) as Map<String, dynamic>;
      final title = map['title'];
      if (title is! String || title.isEmpty) {
        return respond(400, {'error': 'title is required'});
      }
      final priority = map['priority'] as int? ?? 3;
      if (priority < 1 || priority > 5) {
        return respond(400, {'error': 'bad priority'});
      }
      final note = Note(
        id: '${nextId++}',
        title: title,
        body: (map['body'] as String?) ?? '',
        priority: priority,
      );
      store[note.id] = note;
      return respond(201, note.toJson());
    }
    if (path == '/notes' && request.method == 'GET') {
      final notes = store.values.toList()
        ..sort((a, b) {
          final c = a.priority.compareTo(b.priority);
          return c != 0 ? c : int.parse(a.id).compareTo(int.parse(b.id));
        });
      return respond(200, notes.map((n) => n.toJson()).toList());
    }
    if (idMatch != null) {
      final id = idMatch.group(1)!;
      final note = store[id];
      if (note == null) {
        return respond(404, {'error': 'note not found'});
      }
      switch (request.method) {
        case 'GET':
          return respond(200, note.toJson());
        case 'PATCH':
          final map = jsonDecode((request as http.Request).body)
              as Map<String, dynamic>;
          if (map.containsKey('title')) note.title = map['title'] as String;
          if (map.containsKey('body')) note.body = map['body'] as String;
          if (map.containsKey('priority')) {
            note.priority = map['priority'] as int;
          }
          if (map.containsKey('done')) note.done = map['done'] as bool;
          return respond(200, note.toJson());
        case 'DELETE':
          store.remove(id);
          return respond(204);
      }
    }
    return respond(404, {'error': 'not found'});
  }
}

void main() {
  group('Note', () {
    test('fromJson/toJson round trip', () {
      final note = Note.fromJson({
        'id': '7',
        'title': 't',
        'body': 'b',
        'priority': 2,
        'done': true,
      });
      expect(note.id, '7');
      expect(note.title, 't');
      expect(note.body, 'b');
      expect(note.priority, 2);
      expect(note.done, true);
      expect(note.toJson(),
          {'id': '7', 'title': 't', 'body': 'b', 'priority': 2, 'done': true});
    });

    test('toJson has exactly the five keys', () {
      final note = Note(id: '1', title: 'x');
      expect(note.toJson().keys.toSet(),
          {'id', 'title', 'body', 'priority', 'done'});
    });
  });

  group('NotesApiClient', () {
    late FakeNotesServer server;
    late NotesApiClient client;

    setUp(() {
      server = FakeNotesServer();
      client = NotesApiClient('http://example.test',
          httpClient: server as http.Client);
    });

    test('createNote posts title/body/priority and returns note', () async {
      final note = await client.createNote(title: 'a', body: 'b', priority: 1);
      expect(note.id, '1');
      expect(note.title, 'a');
      expect(note.body, 'b');
      expect(note.priority, 1);
      expect(note.done, false);
      expect(server.lastBody, '{"title":"a","body":"b","priority":1}');
    });

    test('listNotes preserves server order', () async {
      await client.createNote(title: 'low', priority: 5);
      await client.createNote(title: 'high', priority: 1);
      await client.createNote(title: 'mid');
      final notes = await client.listNotes();
      expect(notes.map((n) => n.title).toList(), ['high', 'mid', 'low']);
    });

    test('getNote returns note / throws on 404', () async {
      final created = await client.createNote(title: 'a');
      final got = await client.getNote(created.id);
      expect(got.title, 'a');
      expect(
          () => client.getNote('999'),
          throwsA(isA<NotesApiException>()
              .having((e) => e.statusCode, 'statusCode', 404)
              .having((e) => e.message, 'message', 'note not found')));
    });

    test('updateNote sends only non-null fields', () async {
      await client.createNote(title: 'a', body: 'orig');
      final updated = await client.updateNote('1', done: true);
      expect(updated.done, true);
      expect(server.lastBody, '{"done":true}');
      final updated2 = await client.updateNote('1', title: 'b', priority: 4);
      expect(updated2.title, 'b');
      expect(updated2.priority, 4);
      expect(server.lastBody, '{"title":"b","priority":4}');
    });

    test('deleteNote returns on 204, throws on 404', () async {
      await client.createNote(title: 'a');
      await client.deleteNote('1');
      expect(server.store.isEmpty, isTrue);
      expect(
          () => client.deleteNote('1'),
          throwsA(isA<NotesApiException>()
              .having((e) => e.statusCode, 'statusCode', 404)));
    });

    test('error message falls back to raw body without error field', () async {
      final raw = MockClient((request) async => http.Response(
          'plain text failure', 500,
          headers: {'content-type': 'text/plain'}));
      final c = NotesApiClient('http://example.test', httpClient: raw);
      Object? caught;
      try {
        await c.listNotes();
      } catch (e) {
        caught = e;
      }
      final e = caught as NotesApiException;
      expect(e.statusCode, 500);
      expect(e.message, 'plain text failure');
    });
  });

  group('NotesViewModel', () {
    late FakeNotesServer server;
    late NotesViewModel vm;

    setUp(() {
      server = FakeNotesServer();
      vm = NotesViewModel(NotesApiClient('http://example.test',
          httpClient: server as http.Client));
    });

    test('notes is empty before load and unmodifiable', () {
      expect(vm.notes, isEmpty);
      expect(() => vm.notes.add(Note(id: 'x', title: 'y')),
          throwsUnsupportedError);
    });

    test('load/addNote/pending/completed', () async {
      final a = await vm.addNote(title: 'a', priority: 5);
      final b = await vm.addNote(title: 'b', priority: 1);
      expect(vm.notes.map((n) => n.id).toList(), [b.id, a.id]);
      expect(vm.pending.map((n) => n.id).toList(), [b.id, a.id]);
      expect(vm.completed, isEmpty);

      await vm.toggleDone(a.id);
      expect(vm.completed.map((n) => n.id).toList(), [a.id]);
      expect(vm.pending.map((n) => n.id).toList(), [b.id]);

      await vm.load();
      expect(vm.notes.map((n) => n.title).toList(), ['b', 'a']);

      await vm.remove(a.id);
      expect(vm.notes.map((n) => n.id).toList(), [b.id]);
    });

    test('toggleDone/remove throw ArgumentError without API call', () async {
      final before = server.requests.length;
      await expectLater(vm.toggleDone('nope'), throwsArgumentError);
      await expectLater(vm.remove('nope'), throwsArgumentError);
      expect(server.requests.length, before);
    });
  });
}
