# quota-axi v5 fixtures

Sanitized captures of the real quota-axi JSON response contract, taken
as the deterministic proof source for the issue #463
version-aware quota pre-flight.

- quota-axi version at capture: **0.1.61**
- Capture command: `quota-axi --json --no-credential-refresh`
- Capture date: 2026-10-14
- Capture sidecar: the raw capture was taken locally on the capture
  machine and is **not** committed; these files are the sanitized
  projections below.

## Files

| File | Shape |
|---|---|
| `v5-provider-exhausted.json` | zai fresh with an `all_models` `exhausted_now` runway (limiting window `five_hour`), plus a second `auth_required` provider record |
| `v5-provider-sufficient.json` | zai fresh with an `all_models` `projected_exhaustion` runway of 60000 s (above the 35-minute default requirement), plus the same `auth_required` record |
| `v5-model-scope-exhausted-aggregate-unknown.json` | zai fresh with an exact `model:GLM-5.2` scope `exhausted_now` while the `all_models` aggregate is `unknown` — the exact-scope-exclusive selection |
| `v5-unsupported-schema-v6.json` | the exhausted capture with `schemaVersion: 6` — unsupported, fails open |

## Fidelity and redaction rules (issue #463)

- `schemaVersion: 5`, `providers[]`, each provider's `state`,
  `windows[]`, `quotaSemantics.effectiveAvailability[]`, and the
  nested `runway` objects preserve the real contract's field names,
  nesting levels, JSON types, status values, and array/object shape.
- Sensitive or volatile scalar values are redacted / replaced with
  synthetic values **of the same JSON type**: account markers and
  plan descriptors dropped, window `resetsAt` timestamps replaced
  with fixed ISO instants, `effectivePercentRemaining` and pace
  numbers replaced with synthetic values, the second provider's
  error string replaced with a placeholder. No credential material,
  auth-store path, or raw error text from a live provider survives.
- No legacy flat `quota[]` / `exhaustion[]` rows are present; the
  flat shape is the former contract that caused the #463 parser
  drift.
