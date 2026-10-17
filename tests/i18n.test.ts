import { afterEach, expect, test } from "bun:test";
import {
  t,
  formatDate,
  formatNumber,
  setLocale,
  resolveLocale,
} from "../web/src/lib/i18n";
import { decodeError, errorMessage } from "../web/src/lib/api";

test("UI messages interpolate values without translating user content", () => {
  expect(t("images.previewLabel", { name: "相册/a.png" })).toBe(
    "Preview 相册/a.png",
  );
  expect(t("processing.integerRange", { field: "w", max: 8192 })).toBe(
    "w must be an integer from 1 to 8192.",
  );
  expect(t("tasks.attempts", { count: 2 })).toBe("Attempts: 2");
  expect(formatDate(Date.UTC(2026, 9, 15, 12))).toContain("2026");
});

test("API error codes select English copy instead of backend display text", () => {
  const error = decodeError(
    {
      error: {
        code: "STORAGE_UNAVAILABLE",
        message: "后端提示",
        requestId: "request-1",
      },
    },
    503,
  );
  expect(error.message).toContain("redundancy");
  expect(error.requestId).toBe("request-1");
  expect(errorMessage("PIPELINE_MISSING")).toContain("deleted");
  expect(
    decodeError({ error: { code: "FUTURE_ERROR", message: "后端提示" } }, 500)
      .message,
  ).toBe("Request failed. Try again.");
});

afterEach(() => setLocale("en-US"));

test("Chinese catalog covers every message and preserves interpolation placeholders", async () => {
  const { en } = await import("../web/src/locales/en");
  const { zhCN } = await import("../web/src/locales/zh-CN");
  expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  for (const key of Object.keys(en) as Array<keyof typeof en>) {
    expect(zhCN[key].match(/\{\w+\}/g)?.sort() ?? []).toEqual(
      en[key].match(/\{\w+\}/g)?.sort() ?? [],
    );
  }
  setLocale("zh-CN");
  expect(t("ui.signIn")).toBe("登录");
  expect(t("images.previewLabel", { name: "相册/Hello.png" })).toBe(
    "预览 相册/Hello.png",
  );
  expect(t("processing.integerRange", { field: "w", max: 8192 })).toBe(
    "w 必须是 1 到 8192 之间的整数。",
  );
  expect(errorMessage("STORAGE_UNAVAILABLE")).toContain("冗余");
  expect(errorMessage("FUTURE_ERROR")).toBe("请求失败，请重试。");
});

test("locale resolution, date and number formatting follow language changes", () => {
  expect(resolveLocale("zh-Hans-CN")).toBe("zh-CN");
  expect(resolveLocale("zh-TW")).toBe("zh-CN");
  expect(resolveLocale("fr-FR")).toBe("en-US");
  expect(resolveLocale(null)).toBe("en-US");
  const value = Date.UTC(2026, 9, 15, 12);
  setLocale("en-US");
  const english = formatDate(value);
  setLocale("zh-CN");
  expect(formatDate(value)).not.toBe(english);
  expect(formatDate(value)).toContain("2026");
  expect(formatNumber(1234.5)).toBe(
    new Intl.NumberFormat("zh-CN").format(1234.5),
  );
});
