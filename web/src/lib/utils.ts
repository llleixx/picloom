import { t, formatDate, formatNumber } from "./i18n";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function size(n: number | null | undefined) {
  if (n == null) return t("ui.unknown");
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${formatNumber(n, { minimumFractionDigits: unit ? 1 : 0, maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
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
  get delete_failed() {
    return t("ui.deleteFailed");
  },
  get deleted() {
    return t("removal.removed");
  },
};

export function fileStatus(file: import("../../../shared/api").FileView) {
  return file.status === "delete_failed"
    ? t("ui.deleteFailed")
    : statuses[file.status];
}
