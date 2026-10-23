import { afterEach, expect, test } from "bun:test";
import { t, formatDate, formatNumber, setLocale } from "../web/src/lib/i18n";
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
  expect(error.message).toContain("copies");
  expect(error.requestId).toBe("request-1");
  expect(errorMessage("PIPELINE_MISSING")).toContain("deleted");
  expect(
    decodeError({ error: { code: "FUTURE_ERROR", message: "后端提示" } }, 500)
      .message,
  ).toBe("后端提示");
});

afterEach(() => {
  configureLanguages(["zh-CN", "en-US"], "en-US");
  setLocale("en-US");
});

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
  expect(errorMessage("STORAGE_UNAVAILABLE")).toContain("副本");
  expect(errorMessage("FUTURE_ERROR")).toBe("请求失败，请重试。");
});

test("locale resolution, date and number formatting follow language changes", () => {
  const available = ["zh-CN", "en-US"] as const;
  for (const language of [
    "zh-Hans-CN",
    "zh-TW",
    "zh-Hant-TW",
    "zh-MO",
    "ZH-cn",
  ])
    expect(matchLocale(language, available)).toBe("zh-CN");
  expect(matchLocale("fr-FR", available)).toBeUndefined();
  expect(matchLocale("english", available)).toBeUndefined();
  expect(selectLocale(null, [], available, "en-US")).toBe("en-US");
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

import { selectLocale, siteText, matchLocale } from "../shared/locales";
import {
  configureLanguages,
  languagePreference,
  locale,
} from "../web/src/lib/i18n";

test("language negotiation respects ordered browser preferences and page availability", () => {
  const both = ["zh-CN", "en-US"] as const;
  expect(selectLocale(null, ["ja-JP", "en-GB", "zh-CN"], both, "zh-CN")).toBe(
    "en-US",
  );
  expect(selectLocale("zh-CN", ["en-US"], both, "en-US")).toBe("zh-CN");
  expect(selectLocale(null, ["ja-JP"], both, "zh-CN")).toBe("zh-CN");
  expect(selectLocale("en-US", ["en-US"], ["zh-CN"], "zh-CN")).toBe("zh-CN");
  setLocale("en-US");
  configureLanguages(["zh-CN"], "zh-CN");
  expect(locale.value).toBe("zh-CN");
  expect(languagePreference.value).toBe("en-US");
  configureLanguages(both, "zh-CN");
  expect(locale.value).toBe("en-US");
  setLocale("");
  expect(languagePreference.value).toBeNull();
  configureLanguages(both, "en-US");
});

test("localized site content does not borrow the site default language", () => {
  const site = {
    enabledLocales: ["zh-CN", "en-US"] as Array<"zh-CN" | "en-US">,
    defaultLocale: "zh-CN" as "zh-CN" | "en-US",
    content: {
      "zh-CN": { name: "拾光", description: "中文介绍" },
      "en-US": { description: "English introduction" },
    },
  };
  expect(siteText(site, "en-US", "name")).toBe("");
  expect(siteText(site, "en-US", "description")).toBe("English introduction");
  site.defaultLocale = "en-US";
  expect(siteText(site, "en-US", "name")).toBe("");
  expect(siteText(site, "zh-CN", "name")).toBe("拾光");
});

test("site content preserves blank values without borrowing base-language or plugin fallback", () => {
  const site = {
    enabledLocales: ["en-US"] as Array<"en-US">,
    defaultLocale: "en-US" as const,
    content: {
      "en-US": { name: "Gallery", description: "Default" },
      zh: { name: "图库" },
      "zh-CN": { name: "  ", description: " " },
    },
  };
  expect(siteText(site, "zh-CN", "name")).toBe("  ");
  expect(siteText(site, "zh-CN", "description")).toBe(" ");
});
