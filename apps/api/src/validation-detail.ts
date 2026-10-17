/**
 * Turns a rejected request into a list of *named* contract rules, without ever
 * repeating what the caller sent.
 *
 * Why this exists (found by a live register attempt, 2026-10-12): a body that
 * broke a contract rule answered `400 REQUEST_VALIDATION_FAILED — "The request
 * does not match the API contract."`. The message named no field, the branch
 * logged nothing, request logging is disabled, and the correlation id the caller
 * was shown therefore existed nowhere: the operator could not look it up, the
 * caller could not fix the request, and for the invitation code the published
 * OpenAPI did not even state the rule that had been enforced. The failure was
 * real, reproducible, and undiscoverable.
 *
 * Safety rules this module holds to, because a rejected body is exactly where
 * passwords, invitation codes, and one-time codes travel:
 *  - only `instancePath` (a field name from our own schemas) and the validator's
 *    issue *code* are read; the library `message` and `params` payload are never
 *    copied into the result, since a validator issue can carry the submitted
 *    value and a message can embed it;
 *  - the one exception is `unrecognized_keys`, where the offending key names are
 *    the diagnosis; those are filtered against a strict identifier pattern and
 *    capped, so no free-form payload content is echoed back;
 *  - the result is capped so an abusive body cannot amplify into a huge response
 *    or log line.
 */

/** A contract rule the caller can act on, named by field. Never carries a value. */
export interface RejectedContractField {
  /** Field name taken from the endpoint schema, or `(body)` for a whole-body rule. */
  readonly path: string;
  /** A fixed sentence describing the rule that failed. */
  readonly rule: string;
}

const MAX_FIELDS = 20;
const MAX_UNKNOWN_KEYS = 8;

/** Zod issue codes (`createValidationError`) mapped to caller-facing wording. */
const RULE_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  invalid_type: 'the field is missing or is not the JSON type this contract requires',
  too_small: 'the value is shorter than this contract allows',
  too_big: 'the value is longer than this contract allows',
  invalid_format: 'the value does not match the format this contract requires',
  invalid_string: 'the value does not match the format this contract requires',
  invalid_value: 'the value is not one of the values this contract accepts',
  invalid_enum_value: 'the value is not one of the values this contract accepts',
  invalid_literal: 'the value is not the fixed value this contract requires',
  invalid_union: 'the value matches none of the shapes this contract accepts',
  not_multiple_of: 'the value does not satisfy the step this contract requires',
  unrecognized_keys: 'this endpoint does not accept this field',
  custom: 'the value does not satisfy a rule this contract states for the field',
  // Plain JSON-schema keywords, in case a non-Zod validator ever reaches here.
  required: 'the field is missing or is not the JSON type this contract requires',
  minLength: 'the value is shorter than this contract allows',
  maxLength: 'the value is longer than this contract allows',
  minimum: 'the value is below the minimum this contract allows',
  maximum: 'the value is above the maximum this contract allows',
  pattern: 'the value does not match the format this contract requires',
  enum: 'the value is not one of the values this contract accepts',
  additionalProperties: 'this endpoint does not accept this field',
});

const DEFAULT_RULE = 'the value does not match this endpoint contract';

/** Only identifier-shaped key names may be echoed back, and never their values. */
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

interface ValidationEntry {
  readonly keyword?: unknown;
  readonly instancePath?: unknown;
  readonly params?: unknown;
}

function ruleFor(code: string): string {
  return RULE_BY_CODE[code] ?? DEFAULT_RULE;
}

/** `/invitationCode` and `/items/0/amountMinor` become dotted field paths. */
function pathFor(instancePath: string): string {
  const trimmed = instancePath.replace(/^\/+/, '');
  if (trimmed.length === 0) return '(body)';
  return trimmed.split('/').join('.');
}

function unknownKeys(params: unknown): readonly string[] {
  const keys = (params as { readonly keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return [];
  return keys
    .filter((key): key is string => typeof key === 'string' && SAFE_FIELD_NAME.test(key))
    .slice(0, MAX_UNKNOWN_KEYS);
}

/**
 * Summarises `error.validation` for the response body and the log.
 *
 * Returns an empty array when the validator produced nothing usable; callers
 * must treat that as "no detail available" rather than inventing one.
 */
export function describeRejectedContractRules(validation: unknown): readonly RejectedContractField[] {
  if (!Array.isArray(validation)) return [];
  const fields: RejectedContractField[] = [];
  const seen = new Set<string>();

  const push = (path: string, rule: string): void => {
    const key = `${path}\u0000${rule}`;
    if (seen.has(key) || fields.length >= MAX_FIELDS) return;
    seen.add(key);
    fields.push({ path, rule });
  };

  for (const entry of validation as readonly ValidationEntry[]) {
    const code = typeof entry?.keyword === 'string' ? entry.keyword : '';
    const instancePath = typeof entry?.instancePath === 'string' ? entry.instancePath : '';
    if (code === 'unrecognized_keys' || code === 'additionalProperties') {
      const keys = unknownKeys(entry?.params);
      if (keys.length === 0) {
        push(pathFor(instancePath), ruleFor(code));
        continue;
      }
      for (const key of keys) push(key, ruleFor('unrecognized_keys'));
      continue;
    }
    push(pathFor(instancePath), ruleFor(code));
  }

  return fields;
}
