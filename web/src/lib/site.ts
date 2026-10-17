import defaultIcon from "@/assets/picloom.svg?no-inline";
import { computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import type { ClientSettings } from "../../../shared/api";
import { api } from "./api";
import { t } from "./i18n";

export function useSite() {
  const query = useQuery({
    queryKey: ["client-settings"],
    queryFn: () => api<ClientSettings>("/api/client-settings"),
  });
  return {
    homeTitle: computed(() => query.data.value?.siteName || t("home.title")),
    name: computed(() => query.data.value?.siteName || "Picloom"),
    description: computed(
      () => query.data.value?.siteDescription || t("home.subtitle"),
    ),
    logoUrl: computed(() => query.data.value?.siteLogoUrl || defaultIcon),
    faviconUrl: computed(() => query.data.value?.siteFaviconUrl || defaultIcon),
  };
}
