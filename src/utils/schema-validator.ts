/**
 * Runtime validation of MCP tool inputs against their declared `inputSchema`
 * (FX-015).
 *
 * Before this existed, `asToolInput<T>()` in src/index.ts was a bare
 * `args as T` cast and nothing sat between MCP dispatch and the domain
 * handlers — so every `inputSchema` in src/tools/definitions/ was decorative.
 * A caller could send the wrong type, an unknown property under
 * `additionalProperties: false`, or a value outside a declared `enum`, and the
 * handler ran regardless.
 *
 * This is hand-rolled rather than ajv/zod because a new dependency would hit
 * the project's 30-day supply-chain age rule. It therefore implements exactly
 * the keyword subset the repo's own schemas use, inventoried across
 * src/tools/definitions/ and the compliance tool definitions:
 *
 *   type · properties · required · additionalProperties · enum · pattern
 *   minimum · maximum · minLength · maxLength · items · maxItems
 *   default (parsed, not applied) · format (parsed, not enforced)
 *
 * Deliberate non-goals:
 * - **No coercion and no mutation.** The validated value is never touched;
 *   defaults are not injected. Handlers keep their own defaulting, and a
 *   validator that rewrote its input would make the handlers' declared types
 *   lie in a new way.
 * - **No $ref / oneOf / anyOf / allOf / not.** No schema in this repo uses
 *   them. An unrecognised keyword is ignored rather than guessed at, so an
 *   unknown construct fails open — it can never reject a legitimate call.
 *
 * Error messages are path-qualified (`options.timeout`, `urls[1]`) and NEVER
 * include the offending value, which may carry user data or credentials.
 */

export type SchemaValidationResult = { ok: true } | { ok: false; error: string };

type SchemaObject = Record<string, unknown>;

const VALID = { ok: true } as const;

function isPlainObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(error: string): SchemaValidationResult {
  return { ok: false, error };
}

/** Describe a value's type for an error message without revealing its contents. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return "non-finite number";
  return typeof value;
}

/** Join a parent path and a property name into a readable dotted path. */
function childPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    // JSON Schema treats a non-finite number as invalid JSON; reject NaN and
    // Infinity rather than letting them reach arithmetic in a handler.
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      // Unknown type keyword — fail open rather than reject a legitimate call.
      return true;
  }
}

function validateNode(
  schema: unknown,
  value: unknown,
  path: string
): SchemaValidationResult {
  // A missing or non-object schema constrains nothing.
  if (!isPlainObject(schema)) return VALID;

  const label = path || "input";

  // --- type ---------------------------------------------------------------
  const declaredType = schema.type;
  if (typeof declaredType === "string" && !matchesType(value, declaredType)) {
    return fail(
      `${label} must be of type ${declaredType} (got ${describeType(value)})`
    );
  }

  // --- enum ---------------------------------------------------------------
  // Strict membership: no coercion, so 1 never satisfies an enum of ["1"].
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return fail(`${label} must be one of: ${schema.enum.map(String).join(", ")}`);
  }

  if (typeof value === "string") {
    const stringResult = validateString(schema, value, label);
    if (!stringResult.ok) return stringResult;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const numberResult = validateNumber(schema, value, label);
    if (!numberResult.ok) return numberResult;
  }

  if (Array.isArray(value)) {
    const arrayResult = validateArray(schema, value, label);
    if (!arrayResult.ok) return arrayResult;
  }

  if (isPlainObject(value)) {
    const objectResult = validateObject(schema, value, path);
    if (!objectResult.ok) return objectResult;
  }

  return VALID;
}

function validateString(
  schema: SchemaObject,
  value: string,
  label: string
): SchemaValidationResult {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    return fail(`${label} must be at least ${schema.minLength} character(s) long`);
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    return fail(`${label} must be at most ${schema.maxLength} character(s) long`);
  }
  if (typeof schema.pattern === "string") {
    let re: RegExp;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      // A malformed pattern in our own schema must not break dispatch.
      return VALID;
    }
    if (!re.test(value)) {
      return fail(`${label} does not match the required format`);
    }
  }
  return VALID;
}

function validateNumber(
  schema: SchemaObject,
  value: number,
  label: string
): SchemaValidationResult {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    return fail(`${label} must be >= ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    return fail(`${label} must be <= ${schema.maximum}`);
  }
  return VALID;
}

function validateArray(
  schema: SchemaObject,
  value: unknown[],
  label: string
): SchemaValidationResult {
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    return fail(`${label} must contain at most ${schema.maxItems} item(s)`);
  }
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    return fail(`${label} must contain at least ${schema.minItems} item(s)`);
  }
  if (schema.items !== undefined) {
    // Every element, not just the first — an array whose tail is hostile is
    // exactly the case a first-element-only check would wave through.
    for (let i = 0; i < value.length; i++) {
      const elementResult = validateNode(schema.items, value[i], `${label}[${i}]`);
      if (!elementResult.ok) return elementResult;
    }
  }
  return VALID;
}

function validateObject(
  schema: SchemaObject,
  value: SchemaObject,
  path: string
): SchemaValidationResult {
  const properties = isPlainObject(schema.properties) ? schema.properties : undefined;

  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key !== "string") continue;
      if (value[key] === undefined) {
        return fail(`${childPath(path, key)} is required`);
      }
    }
  }

  if (schema.additionalProperties === false) {
    const declared = properties ? Object.keys(properties) : [];
    for (const key of Object.keys(value)) {
      if (!declared.includes(key)) {
        return fail(`${childPath(path, key)} is not a recognised property`);
      }
    }
  }

  if (properties) {
    for (const [key, subSchema] of Object.entries(properties)) {
      // An absent optional property is not validated; `required` above is the
      // only thing that makes presence mandatory.
      if (value[key] === undefined) continue;
      const propertyResult = validateNode(subSchema, value[key], childPath(path, key));
      if (!propertyResult.ok) return propertyResult;
    }
  }

  return VALID;
}

/**
 * Validate `value` against `schema`, returning the first violation found.
 *
 * Fails open on anything it does not understand: an absent schema, a
 * non-object schema, or an unrecognised keyword all validate successfully.
 * This is a guard added to a shipping dispatch path — it must be incapable of
 * rejecting a call that the pre-FX-015 server would have accepted for any
 * reason other than a schema rule it explicitly implements.
 */
export function validateAgainstSchema(
  schema: unknown,
  value: unknown
): SchemaValidationResult {
  return validateNode(schema, value, "");
}
