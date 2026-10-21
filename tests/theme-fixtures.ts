import { zip } from "./package-fixtures";
export function themePackage(
  version = "1.0.0",
  entry = "export function mount(){return {dispose(){}}}",
) {
  return zip({
    "theme.json": JSON.stringify({
      id: "example.theme",
      defaultLocale: "en-US",
      content: { "en-US": { name: "Example" } },
      version,
      apiVersion: 1,
      supportedLocales: ["zh-CN", "en-US"],
      messages: { "zh-CN": {}, "en-US": {} },
      pages: { home: { entry: "entry.js" }, login: { entry: "entry.js" } },
      configSchema: {
        type: "object",
        properties: {
          heading: { type: "string", default: "Original" },
          count: { type: "integer", minimum: 1, default: 1 },
          welcome: {
            type: "string",
            "x-localized": true,
            default: { "en-US": "Welcome", "zh-CN": "欢迎" },
          },
        },
      },
    }),
    "entry.js": entry,
  });
}
