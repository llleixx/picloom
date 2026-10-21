import { afterEach, expect, test } from "bun:test";
import {
  ApiError,
  decodeError,
  errorText,
  errorValue,
  messageText,
  notice,
  notify,
} from "../web/src/lib/api";
import { configureLanguages, setLocale, t } from "../web/src/lib/i18n";

afterEach(() => {
  configureLanguages(["zh-CN", "en-US"], "en-US");
  setLocale("en-US");
});

test("stored errors and notification parameters use the current language", () => {
  setLocale("en-US");
  const error = errorValue(
    decodeError(
      {
        error: {
          code: "TOO_LARGE",
          message: "backend text",
          requestId: "request-1",
        },
      },
      413,
    ),
  );
  const english = messageText(error);
  notify({ key: "images.previewLabel", params: { name: "相册/a.png" } });
  expect(notice.value).toBe("Preview 相册/a.png");
  setLocale("zh-CN");
  expect(messageText(error)).toBe(
    t("ui.fileIsEmptyOrExceedsTheUpload") +
      t("errors.requestId", { id: "request-1" }),
  );
  expect(messageText(error)).not.toBe(english);
  expect(notice.value).toBe("预览 相册/a.png");
  setLocale("en-US");
  expect(messageText(error)).toBe(english);
});

test("unknown errors and literal notifications preserve custom text", () => {
  const custom = decodeError(
    { error: { code: "CUSTOM", message: "Provider-specific text" } },
    400,
  );
  const native = errorValue(new Error("Original text"));
  notify("Literal notification");
  for (const lang of ["zh-CN", "en-US"]) {
    setLocale(lang);
    expect(errorText(custom)).toBe("Provider-specific text");
    expect(messageText(native)).toBe("Original text");
    expect(notice.value).toBe("Literal notification");
  }
});

test("HTTP, network and login errors translate without repeating requests", () => {
  const http = decodeError(null, 502);
  const network = new ApiError("REQUEST_NETWORK", "");
  const login = new ApiError("LOGIN_FAILED", "");
  for (const lang of ["zh-CN", "en-US"]) {
    setLocale(lang);
    expect(errorText(http)).toBe(t("errors.httpStatus", { status: 502 }));
    expect(errorText(network)).toBe(t("ui.cannotReachTheServerTryAgain"));
    expect(errorText(login)).toBe(t("ui.incorrectUsernameOrPassword"));
  }
});
