# @picloom/theme-sdk

Browser-only TypeScript contracts for trusted Picloom home and login themes.

Themes export `mount(container, context)` and return `{ dispose() }`. The host supplies `ThemeContext`; no runtime import or application-internal module is required. Bundle your own framework, subscribe to snapshots, and call context actions for uploads, authentication, navigation and preferences. Dispose your event handlers and framework instances when unmounted.

See `examples/themes/split` for a complete Vue template and `docs/development/themes.md` for the package format, configuration schema, installation, preview and recovery instructions. Run `bun run build:themes` from the repository root to create the example ZIP.

Theme code is trusted code, not sandboxed. Login themes can access entered credentials. Install only reviewed packages. Public configuration must never contain secrets.

Themes declare `supportedLocales` and `messages` dictionaries, with a package `defaultLocale` for display-text fallback. `Snapshot.languages` supplies language metadata; `locales` remains the page-available tag list, and `defaultLocale` is the site default. `localized()` reads only the current language, preserving empty text. Theme authors own language switcher UI. `setLocale()` rejects unavailable languages. Preview language choices never persist visitor preferences.

SDK snapshots and helpers are framework-independent. In Vue themes, assign each `subscribe()` snapshot to a local ref and derive computed values from that ref. Calls such as `t()`, `localized()` and `links.format()` do not establish reactive dependencies in the theme's bundled Vue runtime: do not cache their results in a computed value without explicitly depending on the relevant snapshot fields (`locale` or `copy.format`). The examples call these helpers during rendering, which is triggered by their snapshot subscription. Configuration is fixed for a mount; draft changes are picked up when a new preview is loaded.

Core errors and notifications in snapshots are translated at display time and update with the current language. Recognized error codes use core dictionaries; unknown errors preserve their original text. Themes continue to receive strings and do not need access to core translation keys. Language changes do not restart notification dismissal timers.

Manifests require `nameKey`, referencing the unified `messages` catalog. Field
`x-ui` supports labels, descriptions, enum labels, groups, order, advanced fields, textarea/password widgets and visibility conditions. Password widgets only mask input; theme configuration is public.
The default catalog must contain all referenced and translated keys; supplied
messages cannot be blank. Other supported languages may provide partial catalogs.
Author copy resolves current locale, base language, then package `defaultLocale`;
unknown keys display themselves. `defaultLocale` must belong to `supportedLocales`.
It does not select the visitor locale or change the site default. Administrator
configuration values never fall back. Old `content`, direct schema labels and
`x-multiline` declarations are rejected; no conversion is performed.

This SDK is independent of the plugin SDK and host shared modules. The host shares declaration checks, value validation, explicit initialization and ordinary field editing internally. Theme adapters handle language dictionaries and draft completeness. Themes use the injected `ctx.t()` API.

## Configuration contract

`Field` describes static fields and `Constraint` describes composition branches;
branches reject defaults and field extensions. Formats use the supported
`SchemaFormat` names. A manifest's configuration schema must have an object root.
Types provide authoring feedback; the host remains responsible for declaration
and value validation.

`configSchema` is optional. When present its root must be an object; when absent,
only `{}` is accepted. The host normalizes omission to a closed empty object
schema, equivalent to declaring one explicitly; manifests returned by the host
include that schema. Explicit `null` or `{}` is not a valid schema. A theme with
no custom settings can omit the declaration and receives `ctx.config` as `{}`.
Static `properties/items` support
objects, homogeneous arrays, scalar types and null. Composition (`allOf`, `anyOf`,
`oneOf`, `not`, `if/then/else`) only constrains declared fields; branches cannot
declare defaults or extensions. References, open objects, tuples, sensitive and
immutable extensions are unsupported. See the [shared subset and scenario comparison](https://llleixx.github.io/picloom/development/plugin-config.html#三类-schema-的边界).

Drafts check types, unknown properties, enum/const, numeric bounds and string
constraints, including patterns and formats. Required fields, composition and
array length/uniqueness constraints are deferred until preview or application.
Complete validation runs for every theme-supported language, including languages
not currently enabled by the site. A missing required translation may be saved in
a draft; supplied empty text still fails `minLength: 1`.

Localized fields declare `type: "string"` and `"x-localized": true`. Their stored
value and `default` are dictionaries such as `{ "en-US": "Welcome", "zh-CN": "欢迎" }`;
string constraints and enum/const apply to each language's string. Dictionary keys
must be core-supported locale tags. Missing translations never use another
language's value. Read administrator text through `ctx.localized(ctx.config.heading)`;
use `ctx.t()` for author-owned messages.

The editor uses one tree and one array structure across languages. Defaults
initialize installation drafts and explicitly added array items; saving, reading,
previewing and applying never restore removed values. Values are not coerced;
numbers must be finite and `integer` values must be safe integers. Strings without
an explicit `maxLength` are limited to 10000 Unicode code points.
