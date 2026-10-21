# @picloom/theme-sdk

Browser-only TypeScript contracts for trusted Picloom home and login themes.

Themes export `mount(container, context)` and return `{ dispose() }`. The host supplies `ThemeContext`; no runtime import or application-internal module is required. Bundle your own framework, subscribe to snapshots, and call context actions for uploads, authentication, navigation and preferences. Dispose your event handlers and framework instances when unmounted.

See `examples/themes/split` for a complete Vue template and `docs/development/themes.md` for the package format, configuration schema, installation, preview and recovery instructions. Run `bun run build:themes` from the repository root to create the example ZIP.

Theme code is trusted code, not sandboxed. Login themes can access entered credentials. Install only reviewed packages. Public configuration must never contain secrets.

Themes declare `supportedLocales` and `messages` dictionaries, with a package `defaultLocale` for display-text fallback. `Snapshot.languages` supplies language metadata; `locales` remains the page-available tag list, and `defaultLocale` is the site default. `localized()` reads only the current language, preserving empty text. Theme authors own language switcher UI. `setLocale()` rejects unavailable languages. Preview language choices never persist visitor preferences.

SDK snapshots and helpers are framework-independent. In Vue themes, assign each `subscribe()` snapshot to a local ref and derive computed values from that ref. Calls such as `t()`, `localized()` and `links.format()` do not establish reactive dependencies in the theme's bundled Vue runtime: do not cache their results in a computed value without explicitly depending on the relevant snapshot fields (`locale` or `copy.format`). The examples call these helpers during rendering, which is triggered by their snapshot subscription. Configuration is fixed for a mount; draft changes are picked up when a new preview is loaded.

Core errors and notifications in snapshots are translated at display time and update with the current language. Recognized error codes use core dictionaries; unknown errors preserve their original text. Themes continue to receive strings and do not need access to core translation keys. Language changes do not restart notification dismissal timers.

Manifests declare names only in `content[locale].name`, with a required name in `defaultLocale`. The admin UI displays one name in its own locale, falling back to the package default locale. Schema labels and theme messages follow the same fallback. `defaultLocale` must belong to `supportedLocales`; it does not select the visitor locale or change the site default. Administrator configuration values never fall back. Name locales may be any core-supported language.
