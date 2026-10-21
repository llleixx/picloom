import { messageText } from "./package-localization";
import type { PluginLocalization } from "../plugin-sdk/config";
export type { PluginLocalization } from "../plugin-sdk/config";
export type LocalizedPlugin<T> = T & { name: string; description: string };
export function localizePlugin<
  T extends PluginLocalization & {
    id?: string;
  },
>(resource: T, locale: string): LocalizedPlugin<T> {
  const display = {
    ...resource,
    name: resource.nameKey
      ? messageText(resource, locale, resource.nameKey)
      : (resource.id ?? ""),
    description: resource.descriptionKey
      ? messageText(resource, locale, resource.descriptionKey)
      : "",
  };
  return display;
}
