import 'bookmarks_client.dart';

/// In-memory view-model wrapping a [BookmarksApiClient] for a UI layer. See
/// spec.md for the exact behavior of each member.
class BookmarksViewModel {
  BookmarksViewModel(this.client);

  final BookmarksApiClient client;

  final List<Bookmark> _bookmarks = [];

  List<Bookmark> get bookmarks {
    final order = List<int>.generate(_bookmarks.length, (i) => i);
    order.sort((a, b) {
      final byVisits = _bookmarks[b].visits.compareTo(_bookmarks[a].visits);
      return byVisits != 0 ? byVisits : a.compareTo(b);
    });
    return List.unmodifiable(order.map((i) => _bookmarks[i]));
  }

  List<String> get allTags {
    final tags = <String>{};
    for (final bm in _bookmarks) {
      tags.addAll(bm.tags);
    }
    final sorted = tags.toList()..sort();
    return List.unmodifiable(sorted);
  }

  List<Bookmark> byTag(String tag) {
    return bookmarks.where((bm) => bm.tags.contains(tag)).toList();
  }

  Future<void> load() async {
    _bookmarks
      ..clear()
      ..addAll(await client.listBookmarks());
  }

  Future<Bookmark> addBookmark({
    required String url,
    String title = '',
    List<String> tags = const [],
  }) async {
    final bm = await client.createBookmark(url: url, title: title, tags: tags);
    _bookmarks.add(bm);
    return bm;
  }

  Future<void> visit(String id) async {
    final index = _bookmarks.indexWhere((bm) => bm.id == id);
    if (index < 0) {
      throw ArgumentError('no bookmark with id $id');
    }
    _bookmarks[index] = await client.visitBookmark(id);
  }

  Future<void> remove(String id) async {
    final index = _bookmarks.indexWhere((bm) => bm.id == id);
    if (index < 0) {
      throw ArgumentError('no bookmark with id $id');
    }
    await client.deleteBookmark(id);
    _bookmarks.removeAt(index);
  }
}
