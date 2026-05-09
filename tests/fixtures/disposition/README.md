# Disposition test fixtures

Phase 1 / DISP-01..04 reusable seeds. Workspace-root rather than per-package
because these fixtures cross package boundaries.

## Files

| File                          | Consumed by                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `overlay-valid.yaml`          | DISP-01 schema-validate Job (must accept), DISP-02 cap-issuer narrowing tests (plan 02), DISP-03 projection tests (plan 03) |
| `overlay-missing-tokens.yaml` | DISP-01 schema-validate Job (must reject — missing `attentionBudget.tokensPerDay`)                                          |
| `gateway-usage-rows.json`     | DISP-03 `spentTokensToday` projection unit test (plan 03)                                                                  |

## Numerics

For `gateway-usage-rows.json`, the rows for `researcher-01` sum to:

- `inputTokens`: 12000 + 15000 = 27000
- `outputTokens`: 8000 + 10000 = 18000
- **Total**: 45000 tokens

This is the in-budget base case (under a `tokensPerDay: 50000` budget). DISP-03
tests can mutate the fixture in-memory (e.g. add a row pushing the sum past the
budget) to exercise the over-budget audit-event emission.
