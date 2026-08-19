import 'dart:convert';

import 'package:http/http.dart' as http;

/// A single bookmark. Mirrors the JSON shape returned by the Go bookmarks
/// API.
class Bookmark {
  final String id;
  String url;
  String title;
  List<String> tags;
  int visits;

  Bookmark({
    required this.id,
    required this.url,
    this.title = '',
    this.tags = const [],
    this.visits = 0,
  });

  factory Bookmark.fromJson(Map<String, dynamic> json) {
    return Bookmark(
      id: json['id'] as String,
      url: json['url'] as String,
      title: (json['title'] as String?) ?? '',
      tags: (json['tags'] as List<dynamic>? ?? const [])
          .map((e) => e as String)
          .toList(),
      visits: (json['visits'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'url': url,
      'title': title,
      'tags': tags,
      'visits': visits,
    };
  }
}

/// Thrown by [BookmarksApiClient] when the server responds with a
/// non-success status code. Already defined — do not change.
class BookmarksApiException implements Exception {
  final int statusCode;
  final String message;
  BookmarksApiException(this.statusCode, this.message);

  @override
  String toString() => 'BookmarksApiException($statusCode, $message)';
}

/// Talks to the Go bookmarks API server over HTTP. See spec.md for the
/// exact request/response contract for each method.
class BookmarksApiClient {
  BookmarksApiClient(this.baseUrl, {http.Client? httpClient})
    : httpClient = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client httpClient;

  Future<Bookmark> createBookmark({
    required String url,
    String title = '',
    List<String> tags = const [],
  }) async {
    final res = await httpClient.post(
      Uri.parse('$baseUrl/bookmarks'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'url': url, 'title': title, 'tags': tags}),
    );
    if (res.statusCode != 201) {
      throw _exception(res);
    }
    return Bookmark.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  Future<List<Bookmark>> listBookmarks() async {
    final res = await httpClient.get(Uri.parse('$baseUrl/bookmarks'));
    if (res.statusCode != 200) {
      throw _exception(res);
    }
    final list = jsonDecode(res.body) as List<dynamic>;
    return list
        .map((e) => Bookmark.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<Bookmark> getBookmark(String id) async {
    final res = await httpClient.get(Uri.parse('$baseUrl/bookmarks/$id'));
    if (res.statusCode != 200) {
      throw _exception(res);
    }
    return Bookmark.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  Future<Bookmark> visitBookmark(String id) async {
    final res = await httpClient.post(
      Uri.parse('$baseUrl/bookmarks/$id/visit'),
      headers: {'Content-Type': 'application/json'},
    );
    if (res.statusCode != 200) {
      throw _exception(res);
    }
    return Bookmark.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  Future<Bookmark> updateBookmark(
    String id, {
    String? title,
    List<String>? tags,
  }) async {
    final body = <String, dynamic>{};
    if (title != null) {
      body['title'] = title;
    }
    if (tags != null) {
      body['tags'] = tags;
    }
    final res = await httpClient.patch(
      Uri.parse('$baseUrl/bookmarks/$id'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode(body),
    );
    if (res.statusCode != 200) {
      throw _exception(res);
    }
    return Bookmark.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  Future<void> deleteBookmark(String id) async {
    final res = await httpClient.delete(Uri.parse('$baseUrl/bookmarks/$id'));
    if (res.statusCode != 204) {
      throw _exception(res);
    }
  }

  BookmarksApiException _exception(http.Response res) {
    String message = res.body;
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic> && decoded['error'] != null) {
        message = decoded['error'] as String;
      }
    } on FormatException {
      // keep raw body as the message
    }
    return BookmarksApiException(res.statusCode, message);
  }
}
