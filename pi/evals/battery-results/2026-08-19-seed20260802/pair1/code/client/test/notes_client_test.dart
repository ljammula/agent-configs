import 'dart:convert';
import 'dart:io';

import 'package:notes_client/notes_client.dart';
import 'package:notes_client/notes_view_model.dart';
import 'package:test/test.dart';

/// A tiny in-memory HTTP server that implements the same contract as the Go
/// notes API from spec.md, used to test the Dart client against.
class FakeNotesServer {
  FakeNotesServer._(this._server);

  final HttpServer _server;
  final List<Map<String, dynamic>> _notes = [];
  int _nextId = 1;
  int requestCount = 0;

  String get baseUrl => 'http://${_server.address.address}:${_server.port}';

  static Future<FakeNotesServer> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final fake = FakeNotesServer._(server);
    fake._serve();
    return fake;
  }

  Future<void> close() => _server.close(force: true);

  void _serve() {
    _server.listen((req) async {
      requestCount++;
      try {
        await _handle(req);
      } catch (_) {
        req.response.statusCode = 500;
        await req.response.close();
      }
    });
  }

  Future<Map<String, dynamic>?> _readJson(HttpRequest req) async {
    final body = await utf8.decoder.bind(req).join();
    if (body.isEmpty) return null;
    return jsonDecode(body) as Map<String, dynamic>;
  }

  Future<void> _respond(HttpRequest req, int status, Object? body) async {
    req.response.statusCode = status;
    if (body != null) {
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(body));
    }
    await req.response.close();
  }

  Future<void> _handle(HttpRequest req) async {
    final segments = req.uri.pathSegments;

    if (req.method == 'POST' && segments.length == 1 && segments[0] == 'notes') {
      final json = await _readJson(req);
      final title = json?['title'];
      if (json == null || title is! String || title.isEmpty) {
        return _respond(req, 400, {'error': 'title is required'});
      }
      var priority = 3;
      if (json.containsKey('priority')) {
        final p = json['priority'];
        if (p is! int || p < 1 || p > 5) {
          return _respond(req, 400, {'error': 'priority must be 1..5'});
        }
        priority = p;
      }
      final note = {
        'id': '${_nextId++}',
        'title': title,
        'body': json['body'] as String? ?? '',
        'priority': priority,
        'done': false,
      };
      _notes.add(note);
      return _respond(req, 201, note);
    }

    if (req.method == 'GET' && segments.length == 1 && segments[0] == 'notes') {
      final sorted = [..._notes];
      sorted.sort((a, b) {
        final p = (a['priority'] as int).compareTo(b['priority'] as int);
        if (p != 0) return p;
        return int.parse(a['id'] as String).compareTo(int.parse(b['id'] as String));
      });
      return _respond(req, 200, sorted);
    }

    if (segments.length == 2 && segments[0] == 'notes') {
      final id = segments[1];
      final idx = _notes.indexWhere((n) => n['id'] == id);

      if (req.method == 'GET') {
        if (idx == -1) return _respond(req, 404, {'error': 'not found'});
        return _respond(req, 200, _notes[idx]);
      }

      if (req.method == 'PATCH') {
        final json = await _readJson(req);
        if (idx == -1) return _respond(req, 404, {'error': 'not found'});
        final note = {..._notes[idx]};
        if (json != null) {
          if (json.containsKey('title')) {
            final t = json['title'];
            if (t is! String || t.isEmpty) {
              return _respond(req, 400, {'error': 'title must be non-empty'});
            }
            note['title'] = t;
          }
          if (json.containsKey('body')) note['body'] = json['body'];
          if (json.containsKey('priority')) {
            final p = json['priority'];
            if (p is! int || p < 1 || p > 5) {
              return _respond(req, 400, {'error': 'priority must be 1..5'});
            }
            note['priority'] = p;
          }
          if (json.containsKey('done')) note['done'] = json['done'];
        }
        _notes[idx] = note;
        return _respond(req, 200, note);
      }

      if (req.method == 'DELETE') {
        if (idx == -1) return _respond(req, 404, {'error': 'not found'});
        _notes.removeAt(idx);
        return _respond(req, 204, null);
      }
    }

    return _respond(req, 404, {'error': 'not found'});
  }
}

void main() {
  group('Note', () {
    test('fromJson / toJson roundtrip', () {
      final json = {
        'id': '1',
        'title': 'Buy milk',
        'body': '2%',
        'priority': 2,
        'done': true,
      };
      final note = Note.fromJson(json);
      expect(note.id, '1');
      expect(note.title, 'Buy milk');
      expect(note.body, '2%');
      expect(note.priority, 2);
      expect(note.done, true);
      expect(note.toJson(), json);
    });
  });

  group('NotesApiClient', () {
    late FakeNotesServer fake;
    late NotesApiClient client;

    setUp(() async {
      fake = await FakeNotesServer.start();
      client = NotesApiClient(fake.baseUrl);
    });

    tearDown(() => fake.close());

    test('createNote returns the created note', () async {
      final note = await client.createNote(title: 'Buy milk', body: '2%', priority: 1);
      expect(note.id, '1');
      expect(note.title, 'Buy milk');
      expect(note.body, '2%');
      expect(note.priority, 1);
      expect(note.done, false);
    });

    test('createNote defaults', () async {
      final note = await client.createNote(title: 'Plain');
      expect(note.body, '');
      expect(note.priority, 3);
    });

    test('createNote validation error throws NotesApiException', () async {
      await expectLater(
        client.createNote(title: ''),
        throwsA(isA<NotesApiException>().having((e) => e.statusCode, 'statusCode', 400)),
      );
    });

    test('listNotes returns notes sorted by priority then id', () async {
      await client.createNote(title: 'a', priority: 3);
      await client.createNote(title: 'b', priority: 1);
      await client.createNote(title: 'c', priority: 1);

      final notes = await client.listNotes();
      expect(notes.map((n) => n.id).toList(), ['2', '3', '1']);
    });

    test('getNote returns the note, throws on missing id', () async {
      final created = await client.createNote(title: 'x');
      final fetched = await client.getNote(created.id);
      expect(fetched.title, 'x');

      await expectLater(
        client.getNote('999'),
        throwsA(isA<NotesApiException>().having((e) => e.statusCode, 'statusCode', 404)),
      );
    });

    test('updateNote patches only given fields', () async {
      final created = await client.createNote(title: 'x', body: 'b', priority: 3);

      final updated = await client.updateNote(created.id, done: true);
      expect(updated.title, 'x');
      expect(updated.body, 'b');
      expect(updated.priority, 3);
      expect(updated.done, true);

      final updated2 = await client.updateNote(created.id, title: 'y', priority: 1);
      expect(updated2.title, 'y');
      expect(updated2.priority, 1);
      expect(updated2.done, true);
    });

    test('deleteNote removes the note, throws on missing id', () async {
      final created = await client.createNote(title: 'x');
      await client.deleteNote(created.id);

      await expectLater(
        client.getNote(created.id),
        throwsA(isA<NotesApiException>()),
      );

      await expectLater(
        client.deleteNote('999'),
        throwsA(isA<NotesApiException>().having((e) => e.statusCode, 'statusCode', 404)),
      );
    });
  });

  group('NotesViewModel', () {
    late FakeNotesServer fake;
    late NotesApiClient client;
    late NotesViewModel vm;

    setUp(() async {
      fake = await FakeNotesServer.start();
      client = NotesApiClient(fake.baseUrl);
      vm = NotesViewModel(client);
    });

    tearDown(() => fake.close());

    test('notes is empty before load', () {
      expect(vm.notes, isEmpty);
    });

    test('load populates notes sorted by priority', () async {
      await client.createNote(title: 'a', priority: 3);
      await client.createNote(title: 'b', priority: 1);

      await vm.load();
      expect(vm.notes.map((n) => n.title).toList(), ['b', 'a']);
    });

    test('addNote appends and is reflected in notes', () async {
      await vm.load();
      final added = await vm.addNote(title: 'new', priority: 2);
      expect(added.title, 'new');
      expect(vm.notes.map((n) => n.id).toList(), [added.id]);
    });

    test('pending and completed partition notes', () async {
      await vm.addNote(title: 'a');
      final b = await vm.addNote(title: 'b');
      await vm.toggleDone(b.id);

      expect(vm.pending.map((n) => n.title).toList(), ['a']);
      expect(vm.completed.map((n) => n.title).toList(), ['b']);
    });

    test('toggleDone flips done via the API', () async {
      final a = await vm.addNote(title: 'a');
      expect(a.done, false);

      await vm.toggleDone(a.id);
      expect(vm.notes.firstWhere((n) => n.id == a.id).done, true);

      await vm.toggleDone(a.id);
      expect(vm.notes.firstWhere((n) => n.id == a.id).done, false);
    });

    test('toggleDone on unknown id throws without an API call', () async {
      await vm.load();
      final before = fake.requestCount;
      await expectLater(vm.toggleDone('999'), throwsArgumentError);
      expect(fake.requestCount, before);
    });

    test('remove deletes the note', () async {
      final a = await vm.addNote(title: 'a');
      final b = await vm.addNote(title: 'b');

      await vm.remove(a.id);
      expect(vm.notes.map((n) => n.id).toList(), [b.id]);
    });

    test('remove on unknown id throws without an API call', () async {
      await vm.load();
      final before = fake.requestCount;
      await expectLater(vm.remove('999'), throwsArgumentError);
      expect(fake.requestCount, before);
    });
  });
}
