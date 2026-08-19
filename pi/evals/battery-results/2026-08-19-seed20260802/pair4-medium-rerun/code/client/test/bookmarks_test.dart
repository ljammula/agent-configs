import 'dart:convert';

import 'package:bookmarks_client/bookmarks_client.dart';
import 'package:bookmarks_client/bookmarks_view_model.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

class _Recorder {
  final List<http.Request> requests = [];
}

http.Client _mockClient(
  _Recorder rec,
  (int, String) Function(http.Request req) responses,
) {
  return MockClient((req) async {
    rec.requests.add(req);
    final (status, body) = responses(req);
    return http.Response(body, status);
  });
}

void main() {
  group('Bookmark', () {
    test('fromJson/toJson round trip', () {
      final json = {
        'id': '7',
        'url': 'http://example.com',
        'title': 'Example',
        'tags': ['a', 'b'],
        'visits': 3,
      };
      final bm = Bookmark.fromJson(json);
      expect(bm.id, '7');
      expect(bm.url, 'http://example.com');
      expect(bm.title, 'Example');
      expect(bm.tags, ['a', 'b']);
      expect(bm.visits, 3);
      expect(bm.toJson(), json);
      expect(
          bm.toJson().keys.toSet(), {'id', 'url', 'title', 'tags', 'visits'});
    });

    test('fromJson defaults for missing optional fields', () {
      final bm = Bookmark.fromJson({'id': '1', 'url': 'u'});
      expect(bm.title, '');
      expect(bm.tags, isEmpty);
      expect(bm.visits, 0);
    });
  });

  group('BookmarksApiClient', () {
    late _Recorder rec;
    late BookmarksApiClient client;

    test('createBookmark posts json and returns 201 body', () async {
      rec = _Recorder();
      client = BookmarksApiClient(
        'http://test',
        httpClient: _mockClient(
            rec,
            (req) => (
                  201,
                  '{"id":"1","url":"http://a","title":"t","tags":["x"],"visits":0}'
                )),
      );
      final bm = await client.createBookmark(
        url: 'http://a',
        title: 't',
        tags: ['x'],
      );
      expect(bm.id, '1');
      final req = rec.requests.single;
      expect(req.method, 'POST');
      expect(req.url.toString(), 'http://test/bookmarks');
      expect(req.headers['content-type'], 'application/json');
      expect(jsonDecode(req.body), {
        'url': 'http://a',
        'title': 't',
        'tags': ['x']
      });
    });

    test('listBookmarks preserves server order', () async {
      rec = _Recorder();
      client = BookmarksApiClient(
        'http://test',
        httpClient: _mockClient(
            rec, (req) => (200, '[{"id":"2","url":"b"},{"id":"1","url":"a"}]')),
      );
      final list = await client.listBookmarks();
      expect(list.map((b) => b.id).toList(), ['2', '1']);
    });

    test('getBookmark returns 200 body', () async {
      client = BookmarksApiClient(
        'http://test',
        httpClient: _mockClient(
            _Recorder(),
            (req) =>
                (200, '{"id":"3","url":"c","title":"","tags":[],"visits":1}')),
      );
      final bm = await client.getBookmark('3');
      expect(bm.id, '3');
      expect(bm.visits, 1);
    });

    test('visitBookmark posts to /visit', () async {
      rec = _Recorder();
      client = BookmarksApiClient(
        'http://test',
        httpClient: _mockClient(
            rec,
            (req) =>
                (200, '{"id":"3","url":"c","title":"","tags":[],"visits":2}')),
      );
      final bm = await client.visitBookmark('3');
      expect(bm.visits, 2);
      final req = rec.requests.single;
      expect(req.method, 'POST');
      expect(req.url.toString(), 'http://test/bookmarks/3/visit');
    });

    test('updateBookmark omits null fields from the body', () async {
      rec = _Recorder();
      client = BookmarksApiClient(
        'http://test',
        httpClient: _mockClient(
            rec,
            (req) => (
                  200,
                  '{"id":"3","url":"c","title":"New","tags":[],"visits":2}'
                )),
      );
      await client.updateBookmark('3', title: 'New');
      final req = rec.requests.single;
      expect(req.method, 'PATCH');
      expect(req.url.toString(), 'http://test/bookmarks/3');
      expect(jsonDecode(req.body), {'title': 'New'});
    });

    test('deleteBookmark returns on 204', () async {
      rec = _Recorder();
      client = BookmarksApiClient(
        'http://test',
        httpClient: _mockClient(rec, (req) => (204, '')),
      );
      await client.deleteBookmark('3');
      final req = rec.requests.single;
      expect(req.method, 'DELETE');
      expect(req.url.toString(), 'http://test/bookmarks/3');
    });

    test('error responses throw with the error field message', () async {
      client = BookmarksApiClient(
        'http://test',
        httpClient:
            _mockClient(_Recorder(), (req) => (404, '{"error":"nope"}')),
      );
      Object? e;
      try {
        await client.getBookmark('99');
      } catch (o) {
        e = o;
      }
      expect(e, isA<BookmarksApiException>());
      final ex = e! as BookmarksApiException;
      expect(ex.statusCode, 404);
      expect(ex.message, 'nope');
    });

    test('error responses without an error field use the raw body', () async {
      client = BookmarksApiClient(
        'http://test',
        httpClient: _mockClient(_Recorder(), (req) => (500, 'boom')),
      );
      Object? e;
      try {
        await client.listBookmarks();
      } catch (o) {
        e = o;
      }
      final ex = e! as BookmarksApiException;
      expect(ex.statusCode, 500);
      expect(ex.message, 'boom');
    });
  });

  group('BookmarksViewModel', () {
    BookmarksViewModel _vmWith(List<Bookmark> initial) {
      final rec = _Recorder();
      final client = BookmarksApiClient(
        'http://test',
        httpClient: _mockClient(rec, (req) {
          if (req.method == 'GET' && req.url.path == '/bookmarks') {
            return (200, jsonEncode(initial.map((b) => b.toJson()).toList()));
          }
          if (req.method == 'POST' && req.url.path == '/bookmarks') {
            return (201, jsonEncode(initial.last.toJson()));
          }
          if (req.url.path.endsWith('/visit')) {
            final id = req.url.path.split('/')[2];
            final bm = initial.firstWhere((b) => b.id == id);
            return (200, jsonEncode({...bm.toJson(), 'visits': bm.visits + 1}));
          }
          if (req.method == 'DELETE') {
            return (204, '');
          }
          return (404, '{"error":"not found"}');
        }),
      );
      return BookmarksViewModel(client);
    }

    Bookmark bm(String id, int visits, [List<String> tags = const []]) =>
        Bookmark(id: id, url: 'http://$id', tags: tags, visits: visits);

    test('bookmarks is empty before load', () {
      final vm = _vmWith([]);
      expect(vm.bookmarks, isEmpty);
      expect(vm.allTags, isEmpty);
    });

    test('bookmarks sorted by visits desc, stable on ties', () async {
      final vm = _vmWith([bm('1', 1), bm('2', 3), bm('3', 1), bm('4', 3)]);
      await vm.load();
      expect(vm.bookmarks.map((b) => b.id).toList(), ['2', '4', '1', '3']);
    });

    test('bookmarks is unmodifiable', () async {
      final vm = _vmWith([bm('1', 0)]);
      await vm.load();
      expect(() => vm.bookmarks.add(bm('9', 0)), throwsUnsupportedError);
    });

    test('allTags is distinct and sorted', () async {
      final vm = _vmWith([
        bm('1', 0, ['z', 'a']),
        bm('2', 0, ['a', 'm']),
      ]);
      await vm.load();
      expect(vm.allTags, ['a', 'm', 'z']);
    });

    test('byTag filters in sorted order', () async {
      final vm = _vmWith([
        bm('1', 1, ['x']),
        bm('2', 5, ['x', 'y']),
        bm('3', 9, ['y']),
      ]);
      await vm.load();
      expect(vm.byTag('x').map((b) => b.id).toList(), ['2', '1']);
      expect(vm.byTag('missing'), isEmpty);
    });

    test('addBookmark appends and returns the created bookmark', () async {
      final vm = _vmWith([bm('1', 0)]);
      await vm.load();
      final created = await vm.addBookmark(url: 'http://new');
      expect(created.id, '1');
      expect(vm.bookmarks.length, 2);
    });

    test('visit replaces the in-memory bookmark', () async {
      final vm = _vmWith([bm('1', 0)]);
      await vm.load();
      await vm.visit('1');
      expect(vm.bookmarks.single.visits, 1);
    });

    test('visit throws ArgumentError without API call for unknown id',
        () async {
      final vm = _vmWith([bm('1', 0)]);
      await vm.load();
      expect(() => vm.visit('99'), throwsArgumentError);
    });

    test('remove deletes the in-memory bookmark', () async {
      final vm = _vmWith([bm('1', 0)]);
      await vm.load();
      await vm.remove('1');
      expect(vm.bookmarks, isEmpty);
    });

    test('remove throws ArgumentError for unknown id', () async {
      final vm = _vmWith([bm('1', 0)]);
      await vm.load();
      expect(() => vm.remove('99'), throwsArgumentError);
    });
  });
}
