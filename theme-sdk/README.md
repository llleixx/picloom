# @picloom/theme-sdk

Browser-only TypeScript contracts for trusted Picloom home and login themes.
Create a project with `bun create @picloom/theme@0.1.0 ./my-theme`, or install
the types with `bun add --dev @picloom/theme-sdk@0.1.0`.

```ts
import type { ThemeContext } from "@picloom/theme-sdk";

export function mount(container: HTMLElement, context: ThemeContext) {
  const unsubscribe = context.subscribe((state) => {
    container.textContent = state.site.name;
  });
  return { dispose() { unsubscribe(); container.replaceChildren(); } };
}
```

Bundle your own framework and dispose listeners and framework instances when unmounted.
The host injects runtime capabilities; do not import application-internal modules.
Theme configuration and package assets are public. Theme code is trusted and login
themes can read entered credentials; install reviewed packages only.

Use `@picloom/create-theme` for a standalone Vue project based on the shared default
theme in `themes/default/`. Horizon in `examples/themes/horizon` is the advanced example.

SDK snapshots and helpers are framework-independent. In Vue themes, assign each `subscribe()` snapshot to a local ref and derive computed values from that ref. Calls such as `t()`, `localized()` and `links.format()` do not establish reactive dependencies in the theme's bundled Vue runtime: do not cache their results in a computed value without explicitly depending on the relevant snapshot fields (`locale` or `copy.format`). The examples call these helpers during rendering, which is triggered by their snapshot subscription. Configuration is fixed for a mount; draft changes are picked up when a new preview is loaded.

Core errors and notifications in snapshots are translated at display time and update with the current language. Recognized error codes use core dictionaries; unknown errors preserve their original text. Themes continue to receive strings and do not need access to core translation keys. Language changes do not restart notification dismissal timers.

## Documentation

- [Quick start](https://llleixx.github.io/picloom/development/theme-tooling.html)
- [Theme protocol and localized configuration](https://llleixx.github.io/picloom/development/themes.html)
- [Schema reference](https://llleixx.github.io/picloom/development/schema.html)
- [Messages and form hints](https://llleixx.github.io/picloom/development/package-localization.html)
- [Tool maintenance](https://llleixx.github.io/picloom/development/theme-tooling-maintenance.html)
