import { createApp } from "vue";
import DefaultPage from "../../../themes/default/src/Page.vue";
import manifest from "../../../themes/default/theme.json";
import { messageText } from "../../../shared/package-localization";
import type { ThemeContext } from "../../../theme-sdk";
export function mount(container: HTMLElement, context: ThemeContext) {
  const app = createApp(DefaultPage, {
    context: {
      ...context,
      t(key: string, params: Record<string, string | number> = {}) {
        return messageText(manifest, context.getSnapshot().locale, key).replace(
          /\{(\w+)\}/g,
          (match, name: string) => String(params[name] ?? match),
        );
      },
    },
  });
  app.mount(container);
  return {
    dispose() {
      app.unmount();
    },
  };
}
