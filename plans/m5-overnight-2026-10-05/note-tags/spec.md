# Spec

## Problem

notes-app can search notes by text (`GET /api/notes?q=`) and pin them, but
cannot group them. Users want to label notes ("work", "recipes") and list
only the notes with one label.

## Scope

Note tags in the Python backend:

- Table `note_tags (note_id, tag, PRIMARY KEY (note_id, tag))` — already
  added to `SCHEMA` in `app/db.py`.
- `app/tags.py` (stub exists with final signatures): `normalize_tags`,
  `TagStore` (`set_tags`, `get_tags`, `note_ids_with_tag`, `delete_tags`),
  `MAX_TAGS = 10`, `INVALID_TAGS_MESSAGE`. Errors are the existing
  `app.domain.ValidationError` and `app.domain.NotFoundError`.
- `GET /api/notes/{id}/tags` and `PUT /api/notes/{id}/tags`:
  `NotesRequestHandler.handle_get_tags` / `handle_put_tags` in
  `app/handlers.py` (stubs exist; routes already wired in `app/main.py`;
  `NotesRequestHandler.tags` is already a `TagStore` on the API's connection).
- `GET /api/notes?tag=<tag>` filter: `NotesRequestHandler.handle_list(query, tag)`
  (already called with the `tag` parameter by `app/main.py`) and
  `NotesAPI.list_notes`.

A tag is **normalised** by removing surrounding whitespace and lower-casing.
A normalised tag is **valid** when it matches `^[a-z0-9][a-z0-9-]{0,31}$`
(1-32 characters, starts with a letter or digit). The error shape is the
contract's: `{"error": {"code": ..., "message": ...}}`.

## Non-goals

- Tag rename, tag listing across notes, tag counts.
- Tags in the full-note or list-item JSON shapes (they stay exactly as in
  `spec/contract.md`).
- Frontend changes.
- Copying tags when a note is duplicated.

## Affected services and packages

- app/tags.py
- app/handlers.py
- app/main.py and app/db.py (wiring already done in the bundle commit)

## Acceptance criteria

1. `normalize_tags(raw)` returns the tags stripped, lower-cased, de-duplicated and sorted ascending: `[" Work", "urgent", "WORK "]` gives `["urgent", "work"]`; `[]` gives `[]`.
2. `normalize_tags` raises `ValidationError` when `raw` is not a list (`None`, a string, a dict, a number); when an element is not a string (number, `None`, list, `True`); when a normalised tag is not valid (empty, whitespace-only, 33 characters, leading `-`, inner space, `_`, non-ASCII letters such as `é`); or when more than 10 distinct tags remain after de-duplication. Exactly 10 tags, a 32-character tag, and 11 entries that de-duplicate to 10 are accepted.
3. `TagStore.set_tags(note_id, raw)` replaces the note's whole tag set with `normalize_tags(raw)` and returns that list; `[]` clears the set; other notes' tags do not change; the note's title, body, `created_at`, `updated_at` and `is_pinned` do not change.
4. `set_tags` validates `raw` before looking up the note: an invalid `raw` raises `ValidationError` even for an unknown note; a valid `raw` for an unknown note raises `NotFoundError` and stores nothing.
5. `TagStore.get_tags(note_id)` returns the note's tags sorted ascending, `[]` for a note without tags, and raises `NotFoundError` for an unknown note.
6. `TagStore.note_ids_with_tag(tag)` returns the set of ids of notes carrying `tag.strip().lower()`; it returns an empty set (no error) when no note has it, including for strings that are not valid tags.
7. `TagStore.delete_tags(note_id)` removes all of the note's tags and does not raise when it has none.
8. `GET /api/notes/{id}/tags` returns 200 `{"tags": [<sorted tags>]}` (`{"tags": []}` when none).
9. `PUT /api/notes/{id}/tags` with body `{"tags": [...]}` replaces the tags and returns 200 `{"tags": [<normalised, sorted>]}`; the note's `updated_at` and `is_pinned` are unchanged (tagging is not an edit). Other keys in the body are ignored.
10. A `PUT` body that is not valid JSON, not UTF-8, or not a JSON object returns 400 `invalid_json` / `request body must be valid JSON`.
11. A `PUT` body whose `tags` is missing or invalid per criterion 2 returns 400 `invalid_tags` / `tags must be a list of at most 10 tags, each 1-32 characters of a-z, 0-9 or -`; body checks come before the id, so a malformed or unknown id with an invalid body is still 400. A rejected `PUT` changes no tags.
12. `GET` or `PUT` on an unknown or malformed (non-integer) id returns 404 `not_found` / `note not found`.
13. `DELETE /api/notes/{id}` also removes the note's tags (no `note_tags` rows remain for that id); `POST /api/notes/{id}/duplicate` creates a note without tags.
14. Over HTTP, `GET` and `PUT /api/notes/{id}/tags` reach these handlers and answer with `Content-Type: application/json`.
15. `GET /api/notes?tag=<tag>` returns only notes carrying `tag.strip().lower()`, with the same list-item shape and order as the unfiltered list; combined with `q`, a note must match both. An absent or whitespace-only `tag` leaves the list unfiltered; a tag no note carries gives `{"notes": []}`.

## Risks

- `sqlite3` rows: the connection uses `sqlite3.Row`; one shared connection
  is used from server threads (existing pattern).
- Python versions: the sandbox runs Python 3.13, the contract says 3.9+;
  use only 3.9 syntax (`typing.List`/`typing.Set`, as `app/tags.py` does).
- Element checks must use `isinstance(x, str)`; `True` and numbers are not
  tags.

## Open questions

None.
