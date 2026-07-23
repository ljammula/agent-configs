#!/usr/bin/env bash
# Given a feature name in any case, emit all common name variants for grep searches.
# Usage: ./name-variants.sh speech_to_text
# Output: one variant per line

input="${1:?Usage: $0 <feature_name>}"

# Normalize to lowercase words (split on _ - space)
words=$(echo "$input" | tr '_-' '  ' | tr '[:upper:]' '[:lower:]')

# snake_case
snake=$(echo "$words" | tr ' ' '_')
# SCREAMING_SNAKE
screaming=$(echo "$snake" | tr '[:lower:]' '[:upper:]')
# camelCase
camel=$(echo "$words" | awk '{for(i=1;i<=NF;i++){if(i==1)printf tolower($i);else printf toupper(substr($i,1,1)) tolower(substr($i,2))}print ""}')
# PascalCase
pascal=$(echo "$words" | awk '{for(i=1;i<=NF;i++) printf toupper(substr($i,1,1)) tolower(substr($i,2)); print ""}')
# getter: camelCaseEnabled
getter="${camel}Enabled"
# constant: FeaturePascalCase
constant="Feature${pascal}"

printf '%s\n' "$snake" "$camel" "$pascal" "$screaming" "$getter" "$constant"
