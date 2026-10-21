import { AppError } from "../core/errors";
import type { PluginLocalization } from "../../plugin-sdk/config";
import { DeclarationError } from "../../shared/config";
import type { Schema } from "../../shared/field-schema";
import {
  assertMessageCatalog,
  assertMessageKey,
  assertFieldHints,
  schemaEntries,
} from "../../shared/package-localization";
/** Only host-validated declaration diagnostics may be displayed for a failed package. */
export class PluginDeclarationError extends AppError {
  constructor(stage: string, error: unknown) {
    super(
      "PLUGIN_INVALID",
      `Invalid plugin declaration (${stage}): ${error instanceof DeclarationError ? error.message : "/: Invalid schema or metadata"}`,
    );
  }
}
export function assertPluginIdentity(resource: PluginLocalization) {
  if (
    ["name", "description", "content", "translations", "uiHints"].some(
      (k) => k in resource,
    )
  )
    throw new DeclarationError("/: Use message keys and inline x-ui hints");
  try {
    assertMessageCatalog(resource);
  } catch (error) {
    throw new DeclarationError(
      `/messages: ${error instanceof Error ? error.message : "Invalid catalog"}`,
    );
  }
  for (const key of ["nameKey", "descriptionKey"] as const) {
    if (key === "nameKey" || resource[key] !== undefined) {
      try {
        assertMessageKey(resource, resource[key]);
      } catch {
        throw new DeclarationError(`/${key}: Unknown message key`);
      }
    }
  }
}
export function assertPluginFieldMessages(
  resource: PluginLocalization,
  schema?: Schema,
  paramsSchema?: Schema,
) {
  for (const { node, path } of [
    ...(schema
      ? schemaEntries(schema).map((entry) => ({
          ...entry,
          path: "/configSchema" + entry.path,
        }))
      : []),
    ...(paramsSchema
      ? schemaEntries(paramsSchema).map((entry) => ({
          ...entry,
          path: "/paramsSchema" + entry.path,
        }))
      : []),
  ]) {
    try {
      assertFieldHints(resource, node);
    } catch (error) {
      throw new DeclarationError(
        `${path}: ${error instanceof Error ? error.message : "Invalid field hints"}`,
      );
    }
  }
}
