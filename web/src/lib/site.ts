import { siteText } from "../../../shared/locales";
import defaultIcon from "@/assets/picloom.svg?no-inline";
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
    homeTitle: computed(() => text("name") || t("home.title")),
    name: computed(() => text("name") || "Picloom"),
    description: computed(() => text("description") || t("home.subtitle")),
    logoUrl: computed(() => query.data.value?.siteLogoUrl || defaultIcon),
    faviconUrl: computed(() => query.data.value?.siteFaviconUrl || defaultIcon),
  };
}
