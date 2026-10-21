import { expect, test } from "bun:test";
import {
  assertDeclaration,
  compileSchema,
} from "../src/core/schema-validation";
import { configuration, validateField } from "../src/themes/schema";
import { requestParameters, parseQuery } from "../src/core/request-params";

test("multipleOf validates decimal values exactly across magnitudes", () => {
  for (const [step, valid, invalid] of [
    [0.1, [0, 0.3, -0.3, 12.2, 1200.3], [0.31, -0.31, 0.30000000000000004]],
    [2, [0, 6, -6], [7, -7, 1e-30]],
    [1e-13, [3e-13, -3e-13], [3.1e-13, -3.1e-13]],
    [1, [Number.MAX_VALUE], [Number.MIN_VALUE]],
    [3e-308, [3e-308, 6e-308], [Number.MAX_VALUE]],
  ] as const) {
    const validate = compileSchema({ type: "number", multipleOf: step });
    for (const value of valid) expect(validate(value)).toBe(true);
    for (const value of [...invalid, Infinity, -Infinity, NaN])
      expect(validate(value)).toBe(false);
  }
  const integer = compileSchema({ type: "integer", multipleOf: 0.1 });
  expect(integer(3)).toBe(true);
  expect(integer(0.3)).toBe(false);
});

test("decimal defaults and runtime parameters use the same numeric constraints", () => {
  const amount = { type: "number" as const, multipleOf: 0.1, default: 0.3 };
  const schema = { type: "object" as const, properties: { amount } };
  expect(() => assertDeclaration(schema, "/configSchema")).not.toThrow();
  expect(() => validateField(schema)).not.toThrow();
  expect(configuration(schema, { amount: 0.3 })).toEqual({ amount: 0.3 });
  expect(
    requestParameters(
      schema,
      ["amount"],
      parseQuery(new URLSearchParams("amount=0.3")),
    ),
  ).toEqual({ amount: 0.3 });
  expect(() =>
    requestParameters(
      schema,
      ["amount"],
      parseQuery(new URLSearchParams("amount=0.31")),
    ),
  ).toThrow("Invalid parameter");
  const invalid = {
    ...schema,
    properties: { amount: { ...amount, default: 0.31 } },
  };
  expect(() => assertDeclaration(invalid, "/configSchema")).toThrow("Default");
  expect(() => validateField(invalid)).toThrow("Default");
});
