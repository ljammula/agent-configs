import 'dart:convert';

import 'package:http/http.dart' as http;

/// A single note. Mirrors the JSON shape returned by the Go notes API.
class Note {
  final String id;
  String title;
  String body;
  int priority;
  bool done;

  Note({
    required this.id,
    required this.title,
    this.body = '',
    this.priority = 3,
    this.done = false,
  });

  factory Note.fromJson(Map<String, dynamic> json) {
    return Note(
      id: json['id'] as String,
      title: json['title'] as String,
      body: (json['body'] as String?) ?? '',
      priority: (json['priority'] as num?)?.toInt() ?? 3,
      done: (json['done'] as bool?) ?? false,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'body': body,
      'priority': priority,
      'done': done,
    };
  }
}

/// Thrown by [NotesApiClient] when the server responds with a non-success
/// status code. Already defined — do not change.
class NotesApiException implements Exception {
  final int statusCode;
  final String message;
  NotesApiException(this.statusCode, this.message);

  @override
  String toString() => 'NotesApiException($statusCode, $message)';
}

/// Talks to the Go notes API server over HTTP. See spec.md for the exact
/// request/response contract for each method.
class NotesApiClient {
  NotesApiClient(this.baseUrl, {http.Client? httpClient})
      : httpClient = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client httpClient;

  String _errorMessage(http.Response response) {
    final dynamic decoded;
    try {
      decoded = jsonDecode(response.body);
    } on FormatException {
      return response.body;
    }
    if (decoded is Map<String, dynamic> && decoded['error'] is String) {
      return decoded['error'] as String;
    }
    return response.body;
  }

  Future<Note> createNote({
    required String title,
    String body = '',
    int priority = 3,
  }) async {
    final response = await httpClient.post(
      Uri.parse('$baseUrl/notes'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'title': title, 'body': body, 'priority': priority}),
    );
    if (response.statusCode != 201) {
      throw NotesApiException(response.statusCode, _errorMessage(response));
    }
    return Note.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<List<Note>> listNotes() async {
    final response = await httpClient.get(Uri.parse('$baseUrl/notes'));
    if (response.statusCode != 200) {
      throw NotesApiException(response.statusCode, _errorMessage(response));
    }
    final dynamic decoded = jsonDecode(response.body);
    return (decoded as List)
        .map((e) => Note.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<Note> getNote(String id) async {
    final response = await httpClient.get(Uri.parse('$baseUrl/notes/$id'));
    if (response.statusCode != 200) {
      throw NotesApiException(response.statusCode, _errorMessage(response));
    }
    return Note.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<Note> updateNote(
    String id, {
    String? title,
    String? body,
    int? priority,
    bool? done,
  }) async {
    final payload = <String, dynamic>{};
    if (title != null) payload['title'] = title;
    if (body != null) payload['body'] = body;
    if (priority != null) payload['priority'] = priority;
    if (done != null) payload['done'] = done;
    final response = await httpClient.patch(
      Uri.parse('$baseUrl/notes/$id'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode(payload),
    );
    if (response.statusCode != 200) {
      throw NotesApiException(response.statusCode, _errorMessage(response));
    }
    return Note.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<void> deleteNote(String id) async {
    final response = await httpClient.delete(Uri.parse('$baseUrl/notes/$id'));
    if (response.statusCode != 204) {
      throw NotesApiException(response.statusCode, _errorMessage(response));
    }
  }
}
