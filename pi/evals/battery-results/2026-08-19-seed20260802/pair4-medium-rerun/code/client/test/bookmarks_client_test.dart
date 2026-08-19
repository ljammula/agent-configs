import 'dart:convert';
import 'dart:io';

import 'package:bookmarks_client/bookmarks_client.dart';
import 'package:bookmarks_client/bookmarks_view_model.dart';
import 'package:test/test.dart';

/// A tiny in-memory HTTP server that implements the same contract as the Go
/// bookmarks API from spec.md, used to test the Dart client against.
class FakeBookmarksServer {
  FakeBookmarksServer._(this._server);

  final HttpServer _server;
  final List<Map<String, dynamic>> _bookmarks = [];
  int _nextId = 1;
  int requestCount = 0;

  String get baseUrl => 'http://${_server.address.address}:${_server.port}';

  static Future<FakeBookmarksServer> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final fake = FakeBookmarksServer._(server);
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

    if (req.method == 'POST' && segments.length == 1 && segments[0] == 'bookmarks') {
      final json = await _readJson(req);
      final url = json?['url'];
      if (json == null || url is! String || url.isEmpty) {
        return _respond(req, 400, {'error': 'url is required'});
      }
      var tags = <String>[];
      if (json.containsKey('tags')) {
        final t = json['tags'];
        if (t is! List || t.any((e) => e is! String)) {
          return _respond(req, 400, {'error': 'tags must be a list of strings'});
        }
        tags = t.cast<String>();
      }
      final bookmark = {
        'id': '${_nextId++}',
        'url': url,
        'title': json['title'] as String? ?? '',
        'tags': tags,
        'visits': 0,
      };
      _bookmarks.add(bookmark);
      return _respond(req, 201, bookmark);
    }

    if (req.method == 'GET' && segments.length == 1 && segments[0] == 'bookmarks') {
      final sorted = [..._bookmarks];
      sorted.sort((a, b) {
        final v = (b['visits'] as int).compareTo(a['visits'] as int);
        if (v != 0) return v;
        return int.parse(a['id'] as String).compareTo(int.parse(b['id'] as String));
      });
      return _respond(req, 200, sorted);
    }

    if (segments.length == 2 && segments[0] == 'bookmarks') {
      final id = segments[1];
      final idx = _bookmarks.indexWhere((b) => b['id'] == id);

      if (req.method == 'GET') {
        if (idx == -1) return _respond(req, 404, {'error': 'not found'});
        return _respond(req, 200, _bookmarks[idx]);
      }

      if (req.method == 'PATCH') {
        final json = await _readJson(req);
        if (idx == -1) return _respond(req, 404, {'error': 'not found'});
        final bookmark = {..._bookmarks[idx]};
        if (json != null) {
          if (json.containsKey('title')) {
            final t = json['title'];
            if (t is! String || t.isEmpty) {
              return _respond(req, 400, {'error': 'title must be non-empty'});
            }
            bookmark['title'] = t;
          }
          if (json.containsKey('tags')) {
            final t = json['tags'];
            if (t is! List || t.any((e) => e is! String)) {
              return _respond(req, 400, {'error': 'tags must be a list of strings'});
            }
            bookmark['tags'] = t.cast<String>();
          }
        }
        _bookmarks[idx] = bookmark;
        return _respond(req, 200, bookmark);
      }

      if (req.method == 'DELETE') {
        if (idx == -1) return _respond(req, 404, {'error': 'not found'});
        _bookmarks.removeAt(idx);
        return _respond(req, 204, null);
      }
    }

    if (segments.length == 3 &&
        segments[0] == 'bookmarks' &&
        segments[2] == 'visit' &&
        req.method == 'POST') {
      final id = segments[1];
      final idx = _bookmarks.indexWhere((b) => b['id'] == id);
      if (idx == -1) return _respond(req, 404, {'error': 'not found'});
      final bookmark = {..._bookmarks[idx]};
      bookmark['visits'] = (bookmark['visits'] as int) + 1;
      _bookmarks[idx] = bookmark;
      return _respond(req, 200, bookmark);
    }

    return _respond(req, 404, {'error': 'not found'});
  }
}

void main() {
  group('Bookmark', () {
    test('fromJson / toJson roundtrip', () {
      final json = {
        'id': '1',
        'url': 'https://example.com',
        'title': 'Example',
        'tags': ['a', 'b'],
        'visits': 3,
      };
      final bookmark = Bookmark.fromJson(json);
      expect(bookmark.id, '1');
      expect(bookmark.url, 'https://example.com');
      expect(bookmark.title, 'Example');
      expect(bookmark.tags, ['a', 'b']);
      expect(bookmark.visits, 3);
      expect(bookmark.toJson(), json);
    });
  });

  group('BookmarksApiClient', () {
    late FakeBookmarksServer fake;
    late BookmarksApiClient client;

    setUp(() async {
      fake = await FakeBookmarksServer.start();
      client = BookmarksApiClient(fake.baseUrl);
    });

    tearDown(() => fake.close());

    test('createBookmark returns the created bookmark', () async {
      final bookmark = await client.createBookmark(url: 'https://x', title: 'X', tags: ['a']);
      expect(bookmark.id, '1');
      expect(bookmark.url, 'https://x');
      expect(bookmark.title, 'X');
      expect(bookmark.tags, ['a']);
      expect(bookmark.visits, 0);
    });

    test('createBookmark defaults', () async {
      final bookmark = await client.createBookmark(url: 'https://plain');
      expect(bookmark.title, '');
      expect(bookmark.tags, isEmpty);
    });

    test('createBookmark validation error throws BookmarksApiException', () async {
      await expectLater(
        client.createBookmark(url: ''),
        throwsA(isA<BookmarksApiException>().having((e) => e.statusCode, 'statusCode', 400)),
      );
    });

    test('listBookmarks returns bookmarks sorted by visits then id', () async {
      final a = await client.createBookmark(url: 'https://a');
      final b = await client.createBookmark(url: 'https://b');
      await client.createBookmark(url: 'https://c');

      await client.visitBookmark(b.id);
      await client.visitBookmark(a.id);
      await client.visitBookmark(a.id);

      final bookmarks = await client.listBookmarks();
      expect(bookmarks.map((x) => x.id).toList(), ['1', '2', '3']);
    });

    test('getBookmark returns the bookmark, throws on missing id', () async {
      final created = await client.createBookmark(url: 'https://x');
      final fetched = await client.getBookmark(created.id);
      expect(fetched.url, 'https://x');

      await expectLater(
        client.getBookmark('999'),
        throwsA(isA<BookmarksApiException>().having((e) => e.statusCode, 'statusCode', 404)),
      );
    });

    test('visitBookmark increments visits', () async {
      final created = await client.createBookmark(url: 'https://x');
      final visited = await client.visitBookmark(created.id);
      expect(visited.visits, 1);

      final visited2 = await client.visitBookmark(created.id);
      expect(visited2.visits, 2);

      await expectLater(
        client.visitBookmark('999'),
        throwsA(isA<BookmarksApiException>().having((e) => e.statusCode, 'statusCode', 404)),
      );
    });

    test('updateBookmark patches only given fields', () async {
      final created = await client.createBookmark(url: 'https://x', title: 'orig', tags: ['a']);

      final updated = await client.updateBookmark(created.id, title: 'new');
      expect(updated.title, 'new');
      expect(updated.tags, ['a']);

      final updated2 = await client.updateBookmark(created.id, tags: ['x', 'y']);
      expect(updated2.title, 'new');
      expect(updated2.tags, ['x', 'y']);
    });

    test('deleteBookmark removes the bookmark, throws on missing id', () async {
      final created = await client.createBookmark(url: 'https://x');
      await client.deleteBookmark(created.id);

      await expectLater(
        client.getBookmark(created.id),
        throwsA(isA<BookmarksApiException>()),
      );

      await expectLater(
        client.deleteBookmark('999'),
        throwsA(isA<BookmarksApiException>().having((e) => e.statusCode, 'statusCode', 404)),
      );
    });
  });

  group('BookmarksViewModel', () {
    late FakeBookmarksServer fake;
    late BookmarksApiClient client;
    late BookmarksViewModel vm;

    setUp(() async {
      fake = await FakeBookmarksServer.start();
      client = BookmarksApiClient(fake.baseUrl);
      vm = BookmarksViewModel(client);
    });

    tearDown(() => fake.close());

    test('bookmarks is empty before load', () {
      expect(vm.bookmarks, isEmpty);
    });

    test('load populates bookmarks sorted by visits descending', () async {
      final a = await client.createBookmark(url: 'https://a');
      final b = await client.createBookmark(url: 'https://b');
      await client.visitBookmark(b.id);

      await vm.load();
      expect(vm.bookmarks.map((x) => x.id).toList(), [b.id, a.id]);
    });

    test('addBookmark appends and is reflected in bookmarks', () async {
      await vm.load();
      final added = await vm.addBookmark(url: 'https://new', tags: ['x']);
      expect(added.url, 'https://new');
      expect(vm.bookmarks.map((b) => b.id).toList(), [added.id]);
    });

    test('allTags and byTag reflect in-memory bookmarks', () async {
      await vm.addBookmark(url: 'https://a', tags: ['news', 'tech']);
      await vm.addBookmark(url: 'https://b', tags: ['tech']);
      await vm.addBookmark(url: 'https://c', tags: ['cooking']);

      expect(vm.allTags, ['cooking', 'news', 'tech']);
      expect(vm.byTag('tech').map((b) => b.url).toList(), ['https://a', 'https://b']);
      expect(vm.byTag('cooking').map((b) => b.url).toList(), ['https://c']);
      expect(vm.byTag('unknown'), isEmpty);
    });

    test('visit increments visits via the API and reorders bookmarks', () async {
      final a = await vm.addBookmark(url: 'https://a');
      final b = await vm.addBookmark(url: 'https://b');

      await vm.visit(b.id);
      expect(vm.bookmarks.firstWhere((x) => x.id == b.id).visits, 1);
      expect(vm.bookmarks.map((x) => x.id).toList(), [b.id, a.id]);

      await vm.visit(a.id);
      await vm.visit(a.id);
      expect(vm.bookmarks.map((x) => x.id).toList(), [a.id, b.id]);
    });

    test('visit on unknown id throws without an API call', () async {
      await vm.load();
      final before = fake.requestCount;
      await expectLater(vm.visit('999'), throwsArgumentError);
      expect(fake.requestCount, before);
    });

    test('remove deletes the bookmark', () async {
      final a = await vm.addBookmark(url: 'https://a');
      final b = await vm.addBookmark(url: 'https://b');

      await vm.remove(a.id);
      expect(vm.bookmarks.map((x) => x.id).toList(), [b.id]);
    });

    test('remove on unknown id throws without an API call', () async {
      await vm.load();
      final before = fake.requestCount;
      await expectLater(vm.remove('999'), throwsArgumentError);
      expect(fake.requestCount, before);
    });
  });
}
