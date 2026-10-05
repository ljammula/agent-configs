# Coverage: note-tags

| criterion | ticket | tests |
|---|---|---|
| 1 | 001 | test_strips_lowercases_dedupes_sorts |
| 2 | 001 | test_rejects_non_list, test_rejects_non_string_elements, test_rejects_invalid_tags, test_limits_ten_distinct_tags |
| 3 | 001 | test_set_tags_replaces_and_returns_normalised, test_set_tags_leaves_other_notes_and_note_fields |
| 4 | 001 | test_set_tags_validates_before_note_lookup |
| 5 | 001 | test_get_tags |
| 6 | 001 | test_note_ids_with_tag |
| 7 | 001 | test_delete_tags |
| 8 | 002 | test_get_tags_empty_and_sorted |
| 9 | 002 | test_put_tags_replaces_and_is_not_an_edit |
| 10 | 002 | test_put_invalid_json |
| 11 | 002 | test_put_invalid_tags |
| 12 | 002 | test_unknown_or_malformed_id |
| 13 | 002 | test_delete_removes_tags_and_duplicate_does_not_copy |
| 14 | 002 | test_put_then_get_over_http |
| 15 | 003 | test_tag_filters_with_normal_order, test_items_keep_list_shape, test_tag_and_query_both_apply, test_absent_or_blank_tag_is_unfiltered, test_unknown_tag_gives_empty_list |
