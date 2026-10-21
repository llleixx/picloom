import type { Schema } from "./field-schema";
import { equalJson } from "./field-schema";
/** Presentation and initialization do not determine whether one input can serve both steps. */
export function sameParameterConstraints(a: Schema, b: Schema) {
  const constraints = (rule: Schema) =>
    Object.fromEntries(
      Object.entries(rule).filter(
        ([key]) => !["x-ui", "default"].includes(key),
      ),
    );
  return equalJson(constraints(a), constraints(b));
}
export function sameParameterDefault(a: Schema, b: Schema) {
  return equalJson(a.default, b.default);
}
