# Horizon · 远空

A minimalist cinematic anime landscape theme for Picloom, replacing both the home and login pages. Built with Vue 3 and the public Theme SDK; Vue and icons are bundled independently.

以开阔的二次元云海、星湖为主体，配合大标题和轻量半透明操作面板，完整替换首页与登录页。

## Build / 构建安装

From the repository root / 在项目根目录运行：

```sh
bun run build:themes horizon
```

Install `outputs/themes/horizon.zip` through **管理后台 → 主题**, edit its draft configuration, preview, then apply. Installing does not automatically activate the theme.

## Configuration / 配置

- **Heading and description / 宣传标题与说明**: separate Chinese and English text; blank values remain empty. These do not modify the site name or browser title. Version 1.2.0 also exposes the login heading and description.
- **Rotation / 自动轮换**: enabled by default, every 6 seconds; configurable from 5–60 seconds. Includes manual scene selection and a pause button. Rotation pauses while the document is hidden; reduced-motion preference disables autoplay initially and removes transitions.
- **Shade / 遮罩浓度**: controls the additional dark overlay for readability.
- **Scenery image URLs / 四张背景图片地址**: package asset paths or replacement URLs; defaults point to bundled images, and clearing a field disables that image. Prefer landscape images with a quiet right side. External images depend on their origin's availability and access rules.

Backgrounds are bundled locally; no image API is required. The upload panel uses real SDK operations, including file selection, drag/drop, paste, URL upload, profile selection, queue actions, and sharing preferences. Login uses the host's authentication and safe navigation.

## Assets / 素材

All four original illustrations were generated with the built-in **imagegen** tool. They are stored in `assets/cloud-sea.png`, `assets/star-lake.png`, `assets/dawn-valley.png`, and `assets/aurora-fjord.png`, and packaged with the theme. No external hotlink is used by default.

### Cloud sea prompt

> Use case: stylized-concept. Create a finished cinematic anime landscape background for a minimalist image hosting website. Ultra-wide 16:9 landscape. Awe-inspiring enormous summer cumulonimbus clouds over an endless turquoise ocean and distant green island cliffs, viewed from a quiet grassy cliff high above the water. Hand-painted Japanese animation background art, delicate atmospheric perspective, breathtaking sense of distance and scale, luminous late afternoon sunlight, intricate cloud edges, rich azure and soft mint colors. Composition: vast sky in upper two thirds, horizon near lower third; distant island and the brightest cloud mass on the left and center; right third quieter blue sea and sky to support a dark translucent UI panel. Foreground grass only a thin strip along bottom. Refined, spacious, peaceful, premium editorial composition. No characters, no buildings in foreground, no text, no typography, no logos, no watermark, no UI. Generate one full-bleed illustration.

### Star lake prompt

> Use case: stylized-concept. Asset: full-screen rotating website background. Create a wide 16:9 cinematic anime landscape, a breathtaking vast alpine lake beneath distant monumental mountains at blue-hour twilight, with luminous violet-pink cloud bands and a fine star-filled deep indigo sky reflected in perfectly still water. Hand-painted Japanese animation background art, refined detailed painted clouds and atmospheric mountain silhouettes, quiet wonder and enormous open space. Landscape dominates, no characters. Mountains and most luminous reflections mostly in the left and center; right third is quieter dark blue lake and sky suitable behind an interface. Horizon near lower third; unobstructed expansive composition. Restrained blue, lavender and pale peach light, no oversaturated neon. No text, no logos, no watermark, no UI, no frames. One full-bleed finished illustration.

Version 1.1.0 adds dawn valley and aurora fjord and defaults to 6-second rotation. When copying configuration from 1.0.0, set the interval to 6 explicitly if you want the new default.

### Dawn valley prompt

> Create one finished wide 16:9 cinematic anime landscape illustration for a minimalist full-screen website background. A vast sunlit emerald highland valley above a sea of clouds at dawn, distant blue mountains stretching to infinity, towering softly lit peach and white clouds, a narrow winding river glimmering far below. Hand-painted Japanese animation background art, exquisite atmospheric perspective, awe-inspiring scale and open space, refined painterly details, tranquil and luminous. Main mountain ridges and golden light left and center, right third quieter mist and pale blue sky to support a dark translucent interface. Thin grassy foreground only at lower edge; sky occupies upper two thirds. Restrained sage green, soft gold and sky blue. No people, no text, no logos, no watermark, no interface, no frame. Full bleed illustration.

### Aurora fjord prompt

> Create one finished wide 16:9 cinematic anime landscape illustration for a minimalist full-screen website background. An immense tranquil northern fjord under flowing delicate turquoise aurora curtains and a deep blue starry night sky, monumental snowy peaks receding into mist on the left, still dark teal water reflecting the aurora, distant tiny warm lights along the far shoreline for scale. Hand-painted Japanese animation background art, refined painterly detail, breathtaking openness, quiet magical wonder. Sky occupies upper two thirds; luminous aurora arcs mainly upper left and center; right third quieter blue sky and water suitable behind a translucent interface panel. Elegant restrained teal, indigo, silver, a hint of violet; no oversaturated neon. Minimal foreground, no people, no prominent buildings, no text, no logos, no watermark, no UI, no frame. Full bleed illustration.

Version 1.2.0 uses explicit supported languages and the shared site default language. Empty content does not fall back to another language or site information.

Horizon uses a fixed visual style and does not read or change the host light/dark preference. Native form controls use a fixed dark color scheme. Scene-specific accent colors follow the background slideshow only.
