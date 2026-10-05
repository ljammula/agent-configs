# Coverage: merchant-rules

| criterion | ticket | tests |
|---|---|---|
| 1 | 001 | TestNormalizeMerchant |
| 2 | 001 | TestCreateMerchantRuleStoresNormalizedRule |
| 3 | 001 | TestCreateMerchantRuleRecategorizesMatchingTransactions, TestCreateMerchantRuleNoMatchesAppliesToZero |
| 4 | 001 | TestCreateMerchantRuleEmptyMerchant |
| 5 | 001 | TestCreateMerchantRuleUnknownCategory |
| 6 | 001 | TestCreateMerchantRuleDuplicate |
| 7 | 001 | TestListMerchantRulesOrderAndEmpty |
| 8 | 001 | TestDeleteMerchantRule |
| 9 | 001 | TestCategoryForMerchant |
| 10 | 002 | TestPostMerchantRuleCreatesAndApplies |
| 11 | 002 | TestPostMerchantRuleInvalidJSON |
| 12 | 002 | TestPostMerchantRuleMerchantRequired |
| 13 | 002 | TestPostMerchantRuleCategoryRequired |
| 14 | 002 | TestPostMerchantRuleUnknownCategory |
| 15 | 002 | TestPostMerchantRuleDuplicate, TestPostMerchantRuleStoreError |
| 16 | 002 | TestListMerchantRulesAPI |
| 17 | 002 | TestDeleteMerchantRuleAPI |
| 18 | 003 | TestImportAppliesMerchantRule |
| 19 | 003 | TestImportAfterRuleDeletedUsesKeywords |
