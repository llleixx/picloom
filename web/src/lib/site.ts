import { siteText } from "../../../shared/locales";
import { computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import type { ClientSettings } from "../../../shared/api";
import { api } from "./api";
import { t, locale } from "./i18n";

export function useSite() {
  const query = useQuery({
    queryKey: ["client-settings"],
    queryFn: () => api<ClientSettings>("/api/client-settings"),
  });
  const text = (field: "name" | "description") =>
    query.data.value ? siteText(query.data.value, locale.value, field) : "";
  return {
    settings: query.data,
    pending: query.isPending,
    homeTitle: computed(() => text("name")),
    name: computed(() => text("name")),
    description: computed(() => text("description")),
    logoUrl: computed(() => query.data.value?.siteLogoUrl ?? ""),
    faviconUrl: computed(() => query.data.value?.siteFaviconUrl ?? ""),
  };
}
