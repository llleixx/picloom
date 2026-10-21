import { api } from "./api";
import {
  initialConfig,
  type ConfiguredStep,
  type PipelineKind,
  type PluginView,
} from "../../../shared/config";

/** Called only when creating a draft or explicitly selecting another plugin. */
export async function createPluginDraft(
  pluginId: string,
  version: string,
  stage?: PipelineKind,
): Promise<ConfiguredStep> {
  const plugin = await api<PluginView>(
    `/api/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}`,
  );
  const description =
    plugin.kind === "processor" ? stage && plugin.stages[stage] : plugin;
  if (!description?.configSchema) throw new Error("Unsupported stage");
  return { pluginId, version, config: initialConfig(description.configSchema) };
}
