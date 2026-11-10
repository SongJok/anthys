---
name: frontend-dev
description: 前端页面与动效方法论：视觉设计规范、动效与性能预算、素材生成流程、转化文案框架与生成艺术创作步骤。
version: 0.1.1
when_to_use: 用户要求做落地页、营销页或产品页，设计高级动效，规划视觉素材，或撰写转化文案时使用。
tags:
  - origin:qoder-market
  - frontend
  - design
  - motion
  - copywriting
allowed_tools:
  - project_read
  - project_search
  - web_fetch
  - web_search
  - deliver_artifact
risk: read
visibility: public
max_instruction_chars: 8000
---

# Frontend Studio

Build complete, production-ready frontend pages by orchestrating 5 specialized capabilities: design engineering, motion systems, AI-generated assets, persuasive copy, and generative art.

## 本项目适配说明

本项目没有 shell、没有 npm/dev server、不能落盘写文件：产出是 HTML/CSS/JS 代码文本、动效参数与设计方案，由用户在自己的项目里落地。
素材生成（`scripts/minimax_*.py`）需要 `MINIMAX_API_KEY` 与本地 python，本项目两者都没有：改为输出素材需求清单（类型、数量、规格、提示词），由用户用自有工具生成。
上游的 `canvas-fonts/`、`templates/` 与 minimax 系列参考文档已随本次导入删除，只保留动效配方、素材提示词规则与排障清单。

## Invocation

用户用自然语言提出需求（例如"做一个音乐流媒体应用的落地页"），直接按下面的流程产出设计与代码文本。

## Skill Structure

```
frontend-dev/
├── SKILL.md                      # 核心方法论（本文件）
└── references/                   # 按需读取的细则
    ├── asset-prompt-guide.md     # 素材提示词规则
    ├── motion-recipes.md         # 动效代码配方
    └── troubleshooting.md        # 常见问题
```

素材生成脚本、p5.js 模板与字体资源没有随本次导入保留：本项目没有 shell 也没有素材 API 密钥，素材部分只输出需求清单与提示词。

## Project Structure

### Assets (Universal)

All frameworks use the same asset organization:

```
assets/
├── images/
│   ├── hero-landing-1710xxx.webp
│   ├── icon-feature-01.webp
│   └── bg-pattern.svg
├── videos/
│   ├── hero-bg-1710xxx.mp4
│   └── demo-preview.mp4
└── audio/
    ├── bgm-ambient-1710xxx.mp3
    └── tts-intro-1710xxx.mp3
```

**Asset naming:** `{type}-{descriptor}-{timestamp}.{ext}`

### By Framework

| Framework | Asset Location | Component Location |
|-----------|---------------|-------------------|
| **Pure HTML** | `./assets/` | N/A (inline or `./js/`) |
| **React/Next.js** | `public/assets/` | `src/components/` |
| **Vue/Nuxt** | `public/assets/` | `src/components/` |
| **Svelte/SvelteKit** | `static/assets/` | `src/lib/components/` |
| **Astro** | `public/assets/` | `src/components/` |

### Pure HTML

```
project/
├── index.html
├── assets/
│   ├── images/
│   ├── videos/
│   └── audio/
├── css/
│   └── styles.css
└── js/
    └── main.js           # Animations (GSAP/vanilla)
```

### React / Next.js

```
project/
├── public/assets/        # Static assets
├── src/
│   ├── components/
│   │   ├── ui/           # Button, Card, Input
│   │   ├── sections/     # Hero, Features, CTA
│   │   └── motion/       # RevealSection, StaggerGrid
│   ├── lib/
│   ├── styles/
│   └── app/              # Pages
└── package.json
```

### Vue / Nuxt

```
project/
├── public/assets/
├── src/                  # or root for Nuxt
│   ├── components/
│   │   ├── ui/
│   │   ├── sections/
│   │   └── motion/
│   ├── composables/      # Shared logic
│   ├── pages/
│   └── assets/           # Processed assets (optional)
└── package.json
```

### Astro

```
project/
├── public/assets/
├── src/
│   ├── components/       # .astro, .tsx, .vue, .svelte
│   ├── layouts/
│   ├── pages/
│   └── styles/
└── package.json
```

**Component naming:** PascalCase (`HeroSection.tsx`, `HeroSection.vue`, `HeroSection.astro`)

---

## Compliance

**All rules in this skill are mandatory. Violating any rule is a blocking error — fix before proceeding or delivering.**

---

## Workflow
### Phase 1: Design Architecture
1. Analyze the request — determine page type and context
2. Set design dials based on page type
3. Plan layout sections and identify asset needs

### Phase 2: Motion Architecture
1. Select animation tools per section (see Tool Selection Matrix)
2. Plan motion sequences following performance guardrails

### Phase 3: Asset Generation
Generate all image/video/audio assets using `scripts/`. NEVER use placeholder URLs (unsplash, picsum, placeholder.com, via.placeholder, placehold.co, etc.) or external URLs.

1. Parse asset requirements (type, style, spec, usage)
2. Craft optimized prompts, show to user, confirm before generating
3. Execute via scripts, save to project — do NOT proceed to Phase 5 until all assets are saved locally

### Phase 4: Copywriting & Content
Follow copywriting frameworks (AIDA, PAS, FAB) to craft all text content. Do NOT use "Lorem ipsum" — write real copy.

### Phase 5: Build UI
Scaffold the project and build each section following Design and Motion rules. Integrate generated assets and copy. All `<img>`, `<video>`, `<source>`, and CSS `background-image` MUST reference local assets from Phase 3.

### Phase 6: Quality Gates
Run final checklist (see Quality Gates section).

---

# 1. Design Engineering

## 1.1 Baseline Configuration

| Dial | Default | Range |
|------|---------|-------|
| DESIGN_VARIANCE | 8 | 1=Symmetry, 10=Asymmetric |
| MOTION_INTENSITY | 6 | 1=Static, 10=Cinematic |
| VISUAL_DENSITY | 4 | 1=Airy, 10=Packed |

Adapt dynamically based on user requests.

## 1.2 Architecture Conventions
- **DEPENDENCY VERIFICATION:** Check `package.json` before importing any library. Output install command if missing.
- **Framework:** React/Next.js. Default to Server Components. Interactive components must be isolated `"use client"` leaf components.
- **Styling:** Tailwind CSS. Check version in `package.json` — NEVER mix v3/v4 syntax.
- **ANTI-EMOJI POLICY:** NEVER use emojis anywhere. Use Phosphor or Radix icons only.
- **Viewport:** Use `min-h-[100dvh]` not `h-screen`. Use CSS Grid not flex percentage math.
- **Layout:** `max-w-[1400px] mx-auto` or `max-w-7xl`.

## 1.3 Design Rules
| Rule | Directive |
|------|-----------|
| Typography | Headlines: `text-4xl md:text-6xl tracking-tighter`. Body: `text-base leading-relaxed max-w-[65ch]`. **NEVER** use Inter — use Geist/Outfit/Satoshi. **NEVER** use Serif on dashboards. |
| Color | Max 1 accent, saturation < 80%. **NEVER** use AI purple/blue. Stick to one palette. |
| Layout | **NEVER** use centered heroes when VARIANCE > 4. Force split-screen or asymmetric layouts. |
| Cards | **NEVER** use generic cards when DENSITY > 7. Use `border-t`, `divide-y`, or spacing. |
| States | **ALWAYS** implement: Loading (skeleton), Empty, Error, Tactile feedback (`scale-[0.98]`). |
| Forms | Label above input. Error below. `gap-2` for input blocks. |

## 1.4 Anti-Slop Techniques

- **Liquid Glass:** `backdrop-blur` + `border-white/10` + `shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]`
- **Magnetic Buttons:** Use `useMotionValue`/`useTransform` — never `useState` for continuous animations
- **Perpetual Motion:** When INTENSITY > 5, add infinite micro-animations (Pulse, Float, Shimmer)
- **Layout Transitions:** Use Framer `layout` and `layoutId` props
- **Stagger:** Use `staggerChildren` or CSS `animation-delay: calc(var(--index) * 100ms)`

## 1.5 Forbidden Patterns
| Category | Banned |
|----------|--------|
| Visual | Neon glows, pure black (#000), oversaturated accents, gradient text on headers, custom cursors |
| Typography | Inter font, oversized H1s, Serif on dashboards |
| Layout | 3-column equal card rows, floating elements with awkward gaps |
| Components | Default shadcn/ui without customization |

## 详细章节

正文其余章节已按文件拆分，需要细节时用 skill_read 读取对应文件（示例：`skill_read(name="frontend-dev", path="references/01-x.md")`）：

- `references/01-1-6-creative-arsenal.md` — 1.6 Creative Arsenal / 1.7 Bento Paradigm / 1.8 Brand Override / 2. Motion Engine / 2.1 Tool Selection Matrix / 2.2 Intensity Scale / 2.3 Animation Recipes / 2.4 Performance Rules / 2.5 Springs & Easings / 2.6 Accessibility / 2.7 Dependencies / 3. Asset Generation / 3.1 素材类型与规格 / 3.2 Workflow / 3.3 Preset Shortcuts / 3.4 Reference / 4. Copywriting / 4.1 Core Job / 4.2 Frameworks / 4.3 Headlines / 4.4 CTAs
- `references/02-4-5-emotional-triggers.md` — 4.5 Emotional Triggers / 4.6 Objection Handling / 4.7 Proof Types / 5. Visual Art / 5.1 Output Modes / 5.2 Workflow / Quality Gates
