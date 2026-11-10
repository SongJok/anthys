## 4.5 Emotional Triggers

| Trigger | Example |
|---------|---------|
| FOMO | "Only 3 spots left" |
| Fear of loss | "Every day without this, you're losing $X" |
| Status | "Join 10,000+ top agencies" |
| Ease | "Set it up once. Forget forever." |
| Frustration | "Tired of tools that deliver nothing?" |
| Hope | "Yes, you CAN hit $10K MRR" |


## 4.6 Objection Handling

| Objection | Response |
|-----------|----------|
| Too expensive | Show ROI: "Pays for itself in 2 weeks" |
| Won't work for me | Social proof from similar customer |
| No time | "Setup takes 10 minutes" |
| What if it fails | "30-day money-back guarantee" |
| Need to think | Urgency/scarcity |

Place in FAQ, testimonials, near CTA.


## 4.7 Proof Types

Testimonials (with name/title), Case studies, Data/metrics, Social proof, Certifications

---


# 5. Visual Art

Philosophy-first workflow. Two output modes.


## 5.1 Output Modes

| Mode | Output | When |
|------|--------|------|
| Static | PDF/PNG | Posters, print, design assets |
| Interactive | HTML (p5.js) | Generative art, explorable variations |


## 5.2 Workflow

### Step 1: Philosophy Creation
Name the movement (1-2 words). Articulate philosophy (4-6 paragraphs) covering:
- Static: space, form, color, scale, rhythm, hierarchy
- Interactive: computation, emergence, noise, parametric variation

### Step 2: Conceptual Seed
Identify subtle, niche reference — sophisticated, not literal. Jazz musician quoting another song.

### Step 3: Creation

**Static Mode:**
- Single page, highly visual, design-forward
- Repeating patterns, perfect shapes
- Sparse typography from `canvas-fonts/`
- Nothing overlaps, proper margins
- Output: `.pdf` or `.png` + philosophy `.md`

**Interactive Mode:**
1. Read `templates/viewer.html` first
2. Keep FIXED sections (header, sidebar, seed controls)
3. Replace VARIABLE sections (algorithm, parameters)
4. Seeded randomness: `randomSeed(seed); noiseSeed(seed);`
5. Output: single self-contained HTML

### Step 4: Refinement
Refine, don't add. Make it crisp. Polish into masterpiece.

---


# Quality Gates
**Design:**
- [ ] Mobile layout collapse (`w-full`, `px-4`) for high-variance designs
- [ ] `min-h-[100dvh]` not `h-screen`
- [ ] Empty, loading, error states provided
- [ ] Cards omitted where spacing suffices

**Motion:**
- [ ] Correct tool per selection matrix
- [ ] No GSAP + Framer mixed in same component
- [ ] All `useEffect` have cleanup returns
- [ ] `prefers-reduced-motion` respected
- [ ] Perpetual animations in `React.memo` leaf components
- [ ] Only GPU properties animated
- [ ] Heavy libraries lazy-loaded

**General:**
- [ ] Dependencies verified in `package.json`
- [ ] **No placeholder URLs** — grep the output for `unsplash`, `picsum`, `placeholder`, `placehold`, `via.placeholder`, `lorem.space`, `dummyimage`. If ANY found, STOP and replace with generated assets before delivering.
- [ ] **All media assets exist as local files** in the project's assets directory
- [ ] Asset prompts confirmed with user before generation

---

*React and Next.js are trademarks of Meta Platforms, Inc. and Vercel, Inc., respectively. Vue.js is a trademark of Evan You. Tailwind CSS is a trademark of Tailwind Labs Inc. Svelte and SvelteKit are trademarks of their respective owners. GSAP/GreenSock is a trademark of GreenSock Inc. Three.js, Framer Motion, Lottie, Astro, and all other product names are trademarks of their respective owners.*