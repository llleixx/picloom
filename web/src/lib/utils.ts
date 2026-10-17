import { t, formatDate, formatNumber } from "./i18n";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function size(n: number | null | undefined) {
  if (n == null) return t("ui.unknown");
  if (n < 1024) return `${formatNumber(n)} B`;
  if (n < 1024 ** 2)
    return `${formatNumber(n / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  return `${formatNumber(n / 1024 ** 2, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}
export const date = (n: number | null | undefined) =>
  n == null ? t("ui.unknown") : formatDate(n);
export const statuses = {
  get ready() {
    return t("ui.ready");
  },
  get blocked() {
    return t("images.blocked");
  },
  get preparing() {
    return t("ui.processing2");
  },
  get failed() {
    return t("ui.uploadFailed");
  },
  get deleting() {
    return t("ui.deleting");
  },
  get deleted() {
    return t("ui.deleted");
  },
};
