## 1.6 Creative Arsenal

| Category | Patterns |
|----------|----------|
| Navigation | Dock magnification, Magnetic button, Gooey menu, Dynamic island, Radial menu, Speed dial, Mega menu |
| Layout | Bento grid, Masonry, Chroma grid, Split-screen scroll, Curtain reveal |
| Cards | Parallax tilt, Spotlight border, Glassmorphism, Holographic foil, Swipe stack, Morphing modal |
| Scroll | Sticky stack, Horizontal hijack, Locomotive sequence, Zoom parallax, Progress path, Liquid swipe |
| Gallery | Dome gallery, Coverflow, Drag-to-pan, Accordion slider, Hover trail, Glitch effect |
| Text | Kinetic marquee, Text mask reveal, Scramble effect, Circular path, Gradient stroke, Kinetic grid |
| Micro | Particle explosion, Pull-to-refresh, Skeleton shimmer, Directional hover, Ripple click, SVG draw, Mesh gradient, Lens blur |


## 1.7 Bento Paradigm

- **Palette:** Background `#f9fafb`, cards pure white with `border-slate-200/50`
- **Surfaces:** `rounded-[2.5rem]`, diffusion shadow
- **Typography:** Geist/Satoshi, `tracking-tight` headers
- **Labels:** Outside and below cards
- **Animation:** Spring physics (`stiffness: 100, damping: 20`), infinite loops, `React.memo` isolation

**5-Card Archetypes:**
1. Intelligent List — auto-sorting with `layoutId`
2. Command Input — typewriter + blinking cursor
3. Live Status — breathing indicators
4. Wide Data Stream — infinite horizontal carousel
5. Contextual UI — staggered highlight + float-in toolbar


## 1.8 Brand Override

When brand styling is active:
- Dark: `#141413`, Light: `#faf9f5`, Mid: `#b0aea5`, Subtle: `#e8e6dc`
- Accents: Orange `#d97757`, Blue `#6a9bcc`, Green `#788c5d`
- Fonts: Poppins (headings), Lora (body)

---


# 2. Motion Engine


## 2.1 Tool Selection Matrix

| Need | Tool |
|------|------|
| UI enter/exit/layout | **Framer Motion** — `AnimatePresence`, `layoutId`, springs |
| Scroll storytelling (pin, scrub) | **GSAP + ScrollTrigger** — frame-accurate control |
| Looping icons | **Lottie** — lazy-load (~50KB) |
| 3D/WebGL | **Three.js / R3F** — isolated `<Canvas>`, own `"use client"` boundary |
| Hover/focus states | **CSS only** — zero JS cost |
| Native scroll-driven | **CSS** — `animation-timeline: scroll()` |

**Conflict Rules [MANDATORY]:**
- NEVER mix GSAP + Framer Motion in same component
- R3F MUST live in isolated Canvas wrapper
- ALWAYS lazy-load Lottie, GSAP, Three.js


## 2.2 Intensity Scale

| Level | Techniques |
|-------|------------|
| 1-2 Subtle | CSS transitions only, 150-300ms |
| 3-4 Smooth | CSS keyframes + Framer animate, stagger ≤3 items |
| 5-6 Fluid | `whileInView`, magnetic hover, parallax tilt |
| 7-8 Cinematic | GSAP ScrollTrigger, pinned sections, horizontal hijack |
| 9-10 Immersive | Full scroll sequences, Three.js particles, WebGL shaders |


## 2.3 Animation Recipes

See `references/motion-recipes.md` for full code. Summary:

| Recipe | Tool | Use For |
|--------|------|---------|
| Scroll Reveal | Framer | Fade+slide on viewport entry |
| Stagger Grid | Framer | Sequential list animations |
| Pinned Timeline | GSAP | Horizontal scroll with pinning |
| Tilt Card | Framer | Mouse-tracking 3D perspective |
| Magnetic Button | Framer | Cursor-attracted buttons |
| Text Scramble | Vanilla | Matrix-style decode effect |
| SVG Path Draw | CSS | Scroll-linked path animation |
| Horizontal Scroll | GSAP | Vertical-to-horizontal hijack |
| Particle Background | R3F | Decorative WebGL particles |
| Layout Morph | Framer | Card-to-modal expansion |


## 2.4 Performance Rules
**GPU-only properties (ONLY animate these):** `transform`, `opacity`, `filter`, `clip-path`

**NEVER animate:** `width`, `height`, `top`, `left`, `margin`, `padding`, `font-size` — if you need these effects, use `transform: scale()` or `clip-path` instead.

**Isolation:**
- Perpetual animations MUST be in `React.memo` leaf components
- `will-change: transform` ONLY during animation
- `contain: layout style paint` on heavy containers

**Mobile:**
- ALWAYS respect `prefers-reduced-motion`
- ALWAYS disable parallax/3D on `pointer: coarse`
- Cap particles: desktop 800, tablet 300, mobile 100
- Disable GSAP pin on mobile < 768px

**Cleanup:** Every `useEffect` with GSAP/observers MUST `return () => ctx.revert()`


## 2.5 Springs & Easings

| Feel | Framer Config |
|------|---------------|
| Snappy | `stiffness: 300, damping: 30` |
| Smooth | `stiffness: 150, damping: 20` |
| Bouncy | `stiffness: 100, damping: 10` |
| Heavy | `stiffness: 60, damping: 20` |

| CSS Easing | Value |
|------------|-------|
| Smooth decel | `cubic-bezier(0.16, 1, 0.3, 1)` |
| Smooth accel | `cubic-bezier(0.7, 0, 0.84, 0)` |
| Elastic | `cubic-bezier(0.34, 1.56, 0.64, 1)` |


## 2.6 Accessibility
- ALWAYS wrap motion in `prefers-reduced-motion` check
- NEVER flash content > 3 times/second (seizure risk)
- ALWAYS provide visible focus rings (use `outline` not `box-shadow`)
- ALWAYS add `aria-live="polite"` for dynamically revealed content
- ALWAYS include pause button for auto-playing animations


## 2.7 Dependencies

```bash
npm install framer-motion           # UI (keep at top level)
npm install gsap                    # Scroll (lazy-load)
npm install lottie-react            # Icons (lazy-load)
npm install three @react-three/fiber @react-three/drei  # 3D (lazy-load)
```

---


# 3. Asset Generation


## 3.1 素材类型与规格

| Type | 规格 | 备注 |
|------|--------|------|
| TTS | 旁白配音 | 本项目只给文案与语速/情绪参数 |
| Music | 背景音乐 | 本项目只给曲风与结构标签 |
| Video | 主视觉视频 | 本项目只给分镜与运镜参数 |
| Image | 主视觉图 | 本项目只给构图与光影提示词 |

上游用 `scripts/minimax_*.py` + `MINIMAX_API_KEY` 生成素材，本项目两者都没有，请改为输出素材需求清单交由用户生成。


## 3.2 Workflow
1. **Parse:** type, quantity, style, spec, usage
2. **Craft prompt:** Be specific (composition, lighting, style). **NEVER** include text in image prompts.
3. **Execute:** 把提示词与规格给用户确认；本项目不生成素材，交付物是提示词与规格清单
4. **Save:** 建议用户保存到 `<project>/public/assets/{images,videos,audio}/`，命名为 `{type}-{descriptor}-{timestamp}.{ext}`
5. **Post-process:** 由用户本地处理（Images → WebP、Videos → ffmpeg 压缩、Audio → 归一化）
6. **Deliver:** File path + code snippet + CSS suggestion


## 3.3 Preset Shortcuts

| Shortcut | Spec |
|----------|------|
| `hero` | 16:9, cinematic, text-safe |
| `thumb` | 1:1, centered subject |
| `icon` | 1:1, flat, clean background |
| `avatar` | 1:1, portrait, circular crop ready |
| `banner` | 21:9, OG/social |
| `bg-video` | 768P, 6s, `[Static shot]` |
| `video-hd` | 1080P, 6s |
| `bgm` | 30s, no vocals, loopable |
| `tts` | MiniMax HD, MP3 |


## 3.4 Reference

- `references/asset-prompt-guide.md` — 素材提示词规则

---


# 4. Copywriting


## 4.1 Core Job

1. Grab attention → 2. Create desire → 3. Remove friction → 4. Prompt action


## 4.2 Frameworks

**AIDA** (landing pages, emails):
```
ATTENTION:  Bold headline (promise or pain)
INTEREST:   Elaborate problem ("yes, that's me")
DESIRE:     Show transformation
ACTION:     Clear CTA
```

**PAS** (pain-driven products):
```
PROBLEM:    State clearly
AGITATE:    Make urgent
SOLUTION:   Your product
```

**FAB** (product differentiation):
```
FEATURE:    What it does
ADVANTAGE:  Why it matters
BENEFIT:    What customer gains
```


## 4.3 Headlines

| Formula | Example |
|---------|---------|
| Promise | "Double open rates in 30 days" |
| Question | "Still wasting 10 hours/week?" |
| How-To | "How to automate your pipeline" |
| Number | "7 mistakes killing conversions" |
| Negative | "Stop losing leads" |
| Curiosity | "The one change that tripled bookings" |
| Transformation | "From 50 to 500 leads" |

Be specific. Lead with outcome, not method.


## 4.4 CTAs

**Bad:** Submit, Click here, Learn more

**Good:** "Start my free trial", "Get the template now", "Book my strategy call"

**Formula:** [Action Verb] + [What They Get] + [Urgency/Ease]

Place: above fold, after value, multiple on long pages.