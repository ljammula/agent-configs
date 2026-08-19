import 'dart:collection';

import 'bookmarks_client.dart';

/// In-memory view-model wrapping a [BookmarksApiClient] for a UI layer. See
/// spec.md for the exact behavior of each member.
class BookmarksViewModel {
  BookmarksViewModel(this.client);

  final BookmarksApiClient client;

  final List<Bookmark> _bookmarks = [];

  List<Bookmark> get bookmarks {
    final sorted = List<Bookmark>.from(_bookmarks)
      ..sort((a, b) => b.visits.compareTo(a.visits));
    return UnmodifiableListView(sorted);
  }

  List<String> get allTags {
    final tags = <String>{};
    for (final b in _bookmarks) {
      tags.addAll(b.tags);
    }
    final sorted = tags.toList()..sort();
    return sorted;
  }

  List<Bookmark> byTag(String tag) {
    return bookmarks.where((b) => b.tags.contains(tag)).toList(growable: false);
  }

  Future<void> load() async {
    final list = await client.listBookmarks();
    _bookmarks
      ..clear()
      ..addAll(list);
  }

  Future<Bookmark> addBookmark({
    required String url,
    String title = '',
    List<String> tags = const [],
  }) async {
    final bookmark = await client.createBookmark(
      url: url,
      title: title,
      tags: tags,
    );
    _bookmarks.add(bookmark);
    return bookmark;
  }

  Future<void> visit(String id) async {
    final index = _bookmarks.indexWhere((b) => b.id == id);
    if (index == -1) {
      throw ArgumentError('no bookmark with id $id');
    }
    final updated = await client.visitBookmark(id);
    _bookmarks[index] = updated;
  }

  Future<void> remove(String id) async {
    final index = _bookmarks.indexWhere((b) => b.id == id);
    if (index == -1) {
      throw ArgumentError('no bookmark with id $id');
    }
    await client.deleteBookmark(id);
    _bookmarks.removeAt(index);
  }
}
