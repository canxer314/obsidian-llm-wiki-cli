import { types } from "node:util";

export function ownDataPropertyValues(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      types.isProxy(value)
    ) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return undefined;
      const descriptor = descriptors[key]!;
      if (!Object.hasOwn(descriptor, "value")) return undefined;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

export function hasExactOwnKeys(
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

export function frozenStringRecord(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  const values = ownDataPropertyValues(value);
  if (values === undefined) return undefined;
  const snapshot = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(values)) {
    const entry = values[key];
    if (typeof entry !== "string") return undefined;
    snapshot[key] = entry;
  }
  return Object.freeze(snapshot);
}
