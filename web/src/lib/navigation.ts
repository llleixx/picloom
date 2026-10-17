import { adminPages } from "../../../shared/web-routes";
import {
  CloudUpload,
  Image,
  KeyRound,
  UserRound,
  Settings2,
  Layers3,
  SlidersHorizontal,
  Workflow,
  Settings,
  Activity,
} from "lucide-vue-next";
import type { MessageKey } from "./i18n";
export const navigationGroups = [
  { id: "library", label: "ui.library" },
  { id: "configuration", label: "ui.configuration" },
  { id: "administration", label: "ui.administration" },
] as const;
type Group = (typeof navigationGroups)[number]["id"];
const page = (
  path: string,
  title: MessageKey,
  icon: typeof Image,
  group?: Group,
) => ({ path, title, icon, group, adminOnly: adminPages.includes(path) });
export const navigation = [
  page("/", "home.upload", CloudUpload),
  page("/app/images", "ui.images", Image, "library"),
  page("/app/tokens", "ui.uploadTokens", KeyRound, "library"),
  page("/app/config/sources", "ui.storageSources", Settings2, "configuration"),
  page("/app/config/groups", "ui.storageGroups", Layers3, "configuration"),
  page(
    "/app/config/profiles",
    "ui.uploadProfiles",
    SlidersHorizontal,
    "configuration",
  ),
  page("/app/config/pipelines", "pipelines.title", Workflow, "configuration"),
  page("/app/plugins", "ui.plugins", Settings2, "configuration"),
  page("/app/users", "users.title", UserRound, "administration"),
  page("/app/settings", "settings.title", Settings, "administration"),
  page("/app/system", "system.title", Activity, "administration"),
  page("/app/account", "ui.account", UserRound),
];
