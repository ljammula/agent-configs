import 'package:bookmarks_client/bookmarks_client.dart';
import 'package:test/test.dart';

void main() {
  test('Bookmark model round-trips through JSON', () {
    final b = Bookmark(id: '1', url: 'https://example.com', title: 't',
        tags: ['a'], visits: 3);
    final c = Bookmark.fromJson(b.toJson());
    expect(c.id, '1');
    expect(c.url, 'https://example.com');
    expect(c.title, 't');
    expect(c.tags, ['a']);
    expect(c.visits, 3);
  });
}
