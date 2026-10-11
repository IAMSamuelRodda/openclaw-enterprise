import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { inspect } from "node:util";
import {
  failureSecrets,
  maskPrivateKeyLines,
  redactOutputLine,
} from "../../scripts/ci/failure-redaction.mjs";

const protectedValues = new Set();

// The forms a registered value takes in logs and API errors besides itself:
// JSON-escaped (pino's JSON lines, and Go's, which also escapes <, > and &),
// base64 (a Secret's `data` in a kube API error) and percent-encoded. A value
// shorter than 8 characters gets no base64 forms, which would be short enough
// to garble unrelated text.
export function qaSecretVariants(value) {
  const json = JSON.stringify(value).slice(1, -1);
  const goJson = json.replace(
    /[<>&\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const bytes = Buffer.from(value, "utf8");
  return [
    ...new Set([
      value,
      json,
      goJson,
      ...(value.length >= 8 ? [bytes.toString("base64"), bytes.toString("base64url")] : []),
      encodeURIComponent(value),
    ]),
  ];
}

export function registerQaSecret(value) {
  for (const variant of qaSecretVariants(value)) {
    protectedValues.add(variant);
  }
}

// How deep redaction follows nested values (a cause chain, AggregateError
// errors, a parsed response body). A deeper value is cut to "[Truncated]"
// rather than left unredacted.
const maxErrorDepth = 8;
// Read even when inherited: a DOMException's message, name and code are getters
// on its prototype.
const inheritedErrorFields = ["name", "message", "stack", "code"];

// Errors, arrays and plain objects are redacted field by field. Any other object
// (a Map, a class instance) is checked through its printed form instead.
function walkable(value) {
  if (Array.isArray(value) || value instanceof Error) {
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Redacts registered secrets from every field of a thrown value that the test
// runner prints (it uses util.inspect, getters included): message and stack, an
// execFile error's cmd, stdout and stderr (strings or Buffers), every other own
// field, the `cause` chain and AggregateError `errors`, recursively. A thrown
// string is redacted too.
//
// It returns the value to rethrow: the same error when every field could be
// updated in place, otherwise a plain Error carrying the redacted fields. Some
// errors cannot be updated: a DOMException (AbortSignal.timeout's TimeoutError)
// has a getter-only `message`, a field can be an own getter, and a frozen error
// has read-only fields. A replacement keeps only redacted values, never the
// original. A value that points back up its own chain becomes "[Circular]", so
// no cycle leads from a replacement to an unredacted original. If redaction
// itself throws (a throwing setter or proxy trap), a bare Error carrying only the
// redacted message is returned instead.
export function redactQaError(error) {
  // Longest first, so a value containing another is replaced whole.
  const secrets = [...protectedValues].sort((a, b) => b.length - a.length);
  const redactText = (text) =>
    secrets.reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), text);
  const marker = Buffer.from("[REDACTED]");
  const secretBytes = secrets.map((secret) => Buffer.from(secret, "utf8"));
  // Byte for byte, so the rest of a binary buffer survives unchanged.
  const redactBytes = (view) => {
    let bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    let changed = false;
    for (const secret of secretBytes) {
      const parts = [];
      let start = 0;
      for (let index = bytes.indexOf(secret); index !== -1; index = bytes.indexOf(secret, start)) {
        parts.push(bytes.subarray(start, index), marker);
        start = index + secret.length;
      }
      if (parts.length > 0) {
        bytes = Buffer.concat([...parts, bytes.subarray(start)]);
        changed = true;
      }
    }
    return changed ? bytes : view;
  };
  const done = new Map();
  const active = new Set();

  const redactValue = (value, depth) => {
    if (typeof value === "string") {
      return redactText(value);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (ArrayBuffer.isView(value)) {
      return redactBytes(value);
    }
    if (done.has(value)) {
      return done.get(value);
    }
    if (active.has(value)) {
      return "[Circular]";
    }
    if (depth > maxErrorDepth) {
      return "[Truncated]";
    }
    active.add(value);
    let result;
    try {
      if (Array.isArray(value)) {
        const items = value.map((item) => redactValue(item, depth + 1));
        result = items.every((item, index) => item === value[index]) ? value : items;
      } else if (walkable(value)) {
        result = redactObject(value, depth);
      } else {
        const text = inspect(value, { depth: maxErrorDepth, getters: true });
        const redacted = redactText(text);
        result = redacted === text ? value : redacted;
      }
    } finally {
      active.delete(value);
    }
    done.set(value, result);
    return result;
  };

  const redactObject = (object, depth) => {
    const fields = [];
    for (const key of new Set([...inheritedErrorFields, ...Reflect.ownKeys(object)])) {
      let value;
      try {
        value = object[key];
      } catch {
        continue;
      }
      if (value === undefined && !Object.hasOwn(object, key)) {
        continue;
      }
      fields.push([key, value, redactValue(value, depth + 1)]);
    }
    const write = (key, value) => {
      try {
        return Reflect.set(object, key, value) && object[key] === value;
      } catch {
        return false;
      }
    };
    if (fields.every(([key, value, redacted]) => value === redacted || write(key, redacted))) {
      return object;
    }
    // Every kept value went through redactValue; functions are dropped.
    const kept = fields
      .map(([key, , redacted]) => [key, redacted])
      .filter(([, value]) => typeof value !== "function");
    if (!(object instanceof Error)) {
      return Object.fromEntries(kept);
    }
    const values = new Map(kept);
    const message = values.get("message");
    const replacement = new Error(typeof message === "string" ? message : "[REDACTED]");
    for (const [key, value] of kept) {
      if (key !== "message" && key !== "stack") {
        replacement[key] = value;
      }
    }
    const stack = values.get("stack");
    replacement.stack =
      typeof stack === "string" ? stack : `${replacement.name}: ${replacement.message}`;
    return replacement;
  };

  try {
    return redactValue(error, 0);
  } catch {
    let message = "[REDACTED: the thrown value could not be redacted]";
    try {
      if (typeof error?.message === "string") {
        message = redactText(error.message);
      }
    } catch {
      // Keep the placeholder.
    }
    return new Error(message);
  }
}

// Command arguments and stdout can contain API payloads. Publish only a bounded
// stderr tail, using the CI redactor plus dynamically generated fixture secrets.
export function qaCommandFailureDetail(stderr, env) {
  return redactedQaTail(stderr, env, { lines: 8, lineChars: 800 }).join("\n");
}

// The last `lines` lines of `text` (a command's stderr or a component log),
// each cut to `lineChars` after the same redaction: environment values, every
// registered fixture secret, common token shapes, and whole credential-bearing lines.
export function redactedQaTail(text, env, { lines, lineChars }) {
  const secrets = [
    ...failureSecrets([env]),
    // Text is redacted line by line, so each line of a multi-line value (a PEM
    // key) is a value of its own, as failureSecrets does for the environment.
    ...[...protectedValues].flatMap((value) => [
      [value, "qa-secret"],
      ...(value.includes("\n")
        ? value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length >= 8)
            .map((line) => [line, "qa-secret"])
        : []),
    ]),
  ].sort(([a], [b]) => b.length - a.length);
  // A private key's body lines are found across the whole text, so a key that
  // starts above the tail still loses the lines inside it.
  return maskPrivateKeyLines(
    String(text ?? "")
      .trimEnd()
      .split("\n"),
  )
    .slice(-lines)
    .map((line) => redactOutputLine(line, secrets, "", lineChars));
}

export async function protectedText(path, label) {
  assert.ok(path, `${label} path is required`);
  // Check and read the same opened file; never follow a substituted symlink.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    assert.ok(
      info.isFile() && (info.mode & 0o077) === 0,
      `${label} must be a private regular file`,
    );
    const value = (await file.readFile("utf8")).trim();
    assert.ok(value.length > 0, `${label} must not be empty`);
    registerQaSecret(value);
    return value;
  } finally {
    await file.close();
  }
}

export async function grantQaSecret(f, agent, secretId, name) {
  const base = `/namespaces/${agent.namespaceId}`;
  const role = await f.api("POST", `${base}/iam/roles`, {
    name,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  await f.api("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "secret",
    resourceId: secretId,
  });
}
