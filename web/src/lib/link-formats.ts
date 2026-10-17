import { reactive, watch } from "vue";
export const copyFormats = ["URL", "Markdown", "HTML", "BBCode"] as const;
export type CopyFormat = typeof copyFormats[number];
const stored = localStorage.getItem("copyFormat");
export const copyPreferences = reactive({
  format: (copyFormats.includes(stored as CopyFormat) ? stored : "URL") as CopyFormat,
  auto: localStorage.getItem("autoCopy") === "true",
});
watch(copyPreferences, value => {
  localStorage.setItem("copyFormat", value.format);
  localStorage.setItem("autoCopy", String(value.auto));
});
export function formatLink(url: string, format: CopyFormat): string {
  if (format === "Markdown") return `![](${url})`;
  if (format === "HTML") return `<img src="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}" alt="" />`;
  if (format === "BBCode") return `[img]${url}[/img]`;
  return url;
}
