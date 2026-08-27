# Attest — Brand & Design System

## The name

**Attest** — *to bear witness; to certify that something is true.*

It is the exact verb for what a chartered accountant does and, importantly, the
exact verb for what this software does **not** do. The product prepares; the
accountant attests. The name puts the human at the centre of the thing, which
is the same argument the architecture makes. Short, pronounceable in Nepali and
English, and available as a verb in a sentence a firm would actually say:
*"run it through Attest before you sign."*

---

## The mark

```
   ╭──────────────╮
   │      ╱        │      a check
   │   ╲ ╱         │      made on a rule
   │    ╳          │      inside a seal
   │   ─────       │
   ╰──────────────╯
```

The mark is a **seal** containing **a check made on a rule**.

Every element is doing a job:

| Element | Meaning |
|---|---|
| The seal (rounded square) | Certification. A seal is what a professional applies *after* review — the product's whole promise in one shape. |
| The rule, muted | Both the ledger line and the signature line. Deliberately quiet: the record is the input, not the achievement. |
| The check, in accent | The attestation. It is the only coloured element in the entire mark, because the human's sign-off is the only thing that matters. |

**The idea in one sentence:** a mark made on a line is a signature. The logo is
the product's central claim — *the software prepares, the human attests* —
compressed into two strokes.

**The designed detail:** the check's vertex descends to sit directly on the
rule, and the two are separated by exactly one stroke-width of clear space. It
touches the line the way a pen does. The mark's silhouette is only two strokes,
which is why it still reads correctly at 16px in a browser tab.

**Why not the obvious options — and one I actually built and threw away:**
a magnifying glass says *search*, not *certify*. A shield says *security*, which
is a foundation here but not the value. A bar chart says *analytics*, the wrong
category entirely — this is not a dashboard product. The first version of this
mark put three ledger rules beside the check; rendered at size it read
unmistakably as a **to-do list app**, so it was scrapped. A second attempt ran
the rule horizontally into a rising tick and read as a *swoosh*. The lesson,
and the reason both are recorded here: a mark has to be rendered and looked at,
not reasoned about. The description of a logo is not the logo.

### Variants shipped

| File | Use |
|---|---|
| `logo-mark.svg` | Seal only, dark. App icon, favicon, avatars. |
| `logo-mark-light.svg` | Seal only, inverted for dark backgrounds. |
| `logo-lockup.svg` | Mark + wordmark, horizontal. Marketing, README, login screen. |
| `<Logo />` React component | Theme-aware, token-driven, used everywhere in-app. |

**Clear space:** never less than the height of one ledger rule gap on all sides.
**Minimum size:** 16px for the mark, 96px wide for the lockup. Below that, use
the mark alone — the wordmark stops being legible before the mark does.

---

## Colour

The palette is built on one conviction: **this is a tool people use for six
hours at a stretch, on a screen, while concentrating on numbers.** Loud colour
is not neutral here; it is fatigue, and it competes with the only thing that
should ever grab attention — a flag that needs a human decision.

So the interface is a warm paper neutral, and **saturation is a scarce resource
spent exclusively on meaning**.

### Neutrals — the warm paper ramp

The greys are warm (a touch of yellow), never blue-grey. Blue-grey reads as
"tech dashboard"; warm grey reads as paper, ledger, document. The product is
about documents.

| Token | Light | Role |
|---|---|---|
| `--paper` | `#FAF9F6` | App background. Off-white, never pure `#FFF`. |
| `--surface` | `#FFFFFF` | Cards, tables, panels lifted off the paper. |
| `--surface-sunken` | `#F3F1EC` | Table headers, inset wells, code. |
| `--line` | `#E5E1D9` | Hairline borders. |
| `--line-strong` | `#CFC9BD` | Emphasised dividers, input borders. |
| `--ink-400` | `#8A8578` | Placeholder, disabled. |
| `--ink-600` | `#6B6659` | Secondary text, labels, metadata. |
| `--ink-800` | `#3A3730` | Body text. |
| `--ink-900` | `#1A1815` | Headings, figures. |

### Accent — verdigris

`--accent: #2F7A6F`

A desaturated blue-green. Chosen because it is the colour of aged copper seals
and ledger ink, it is calm at large areas, and — critically — it is
**distinguishable from the semantic red and amber by people with deuteranopia
and protanopia**, which a conventional "success green" is not. In a product
whose entire job is signalling *this needs your attention* versus *this is
fine*, a palette that collapses under the most common colour-vision deficiency
is a correctness bug, not a taste problem.

### Semantic — severity, and nothing else

These three colours appear **only** on flags and status. They are never used
decoratively, never as a brand colour, never on a button that isn't about the
thing they mean. That discipline is what makes a red dot actually mean something
when the reviewer sees one.

| Token | Value | Meaning |
|---|---|---|
| `--severity-high` | `#A33A2E` | Money is wrong or at risk. Act now. |
| `--severity-medium` | `#9A6100` | Needs explanation before filing. |
| `--severity-low` | `#5B6B72` | Worth a glance. Deliberately near-neutral. |

Low severity is rendered in a slate that is barely a colour at all — because a
low-severity flag genuinely does not deserve to pull the eye off a high one.
Each severity also carries a distinct **icon shape and text label**, so severity
is never communicated by colour alone (WCAG 1.4.1).

All text pairings meet **WCAG AA (4.5:1)**; figures and headings meet **AAA
(7:1)**, because misreading a digit is a materially worse failure than
misreading a label.

---

## Type

| Role | Family | Why |
|---|---|---|
| Display, wordmark, headings | **Source Serif 4** | A serif signals institution, permanence, and document. It is what a firm's letterhead looks like. It earns trust that a geometric sans has to work for. |
| UI, body, labels | **Inter** | Neutral, superb at small sizes, huge x-height, unambiguous `1`/`l`/`I` and `0`/`O`. |
| Figures | **Inter, `tabular-nums`** | Non-negotiable. Digits in a money column must occupy identical width so the decimal points form a straight line and the eye can compare magnitudes down the column without reading. |

Every currency figure in the product also uses `font-feature-settings: "tnum"`
and is right-aligned. This is the single highest-value typographic decision in a
financial interface and it costs nothing.

**Scale** (1.25 ratio, capped — a review tool needs about five sizes, not twelve):
`12 / 14 / 16 / 20 / 25 / 32 / 40`

---

## The UX laws this system is built on, and where

Not decoration — each one is answering a real failure mode in this product.

**Hick's Law** — decision time grows with the number of choices.
→ The review sheet gives exactly three actions per flag: **Accept**, **Dismiss**,
**Add note**. Not a dropdown of twelve dispositions. A reviewer working a
hundred flags makes the same three-way decision a hundred times and never
re-reads the options.

**Fitts's Law** — target acquisition time depends on size and distance.
→ Those three actions sit in a fixed position inside every flag card, at the
same offset, at 40px minimum height. The reviewer's hand learns one location.
Keyboard shortcuts (`A` / `D` / `N`, `J`/`K` to move) remove the distance
entirely for anyone who works the list daily — which is the whole target user.

**Miller's Law** — working memory holds about seven items.
→ The review sheet never shows a flag without its full context inline: the
figure, the date, the party, the reason, and the source snippet. The reviewer
never has to hold a number in their head while navigating elsewhere to check it.
This is also why the source viewer opens as a side panel, not a new page.

**Jakob's Law** — people expect your product to work like the ones they know.
→ Transactions are a table with sortable headers, sticky first column, and
right-aligned money. Accountants live in Excel; fighting that is arrogance.

**Von Restorff (isolation) effect** — the thing that differs is remembered.
→ Because 95% of the interface is warm neutral, a single high-severity flag is
genuinely impossible to miss. This is the entire reason the palette is
restrained: colour is being *saved up* to spend here.

**Doherty Threshold** — below ~400ms response, attention holds.
→ Every action on a flag updates optimistically and reconciles with the server
after. Uploads and parsing, which genuinely take seconds, get honest staged
progress ("Reading page 3 of 11") rather than a spinner, because a spinner with
no information is what makes a ten-second wait feel like a failure.

**Aesthetic–usability effect** — people judge attractive interfaces as more
capable and forgive their faults more readily.
→ Cuts both ways, and this is the honest caveat: a beautiful interface can make
a wrong number *more* persuasive. That is exactly why provenance is always one
click away and why nothing is ever presented as final. The polish earns
attention; the traceability earns the trust.

**Postel's Law** — be liberal in what you accept, conservative in what you emit.
→ The parser accepts `1,234.50`, `Rs 1234.5`, `(1,234.50)`, `1234.50 Dr`. The
system emits one canonical normalized shape. But liberality stops at ambiguity:
anything genuinely unparseable is raised as a flag, never guessed at.

---

## Layout & motion

- **8px spatial grid.** Every margin, padding and gap is a multiple. Nothing is
  ever 13px because it "looked right".
- **One elevation step.** Cards sit on the paper with a hairline border and the
  faintest shadow. There is no floating stack of z-layers; depth is a
  navigational cue here, not an aesthetic.
- **Density is a setting.** Comfortable by default, compact for the preparer who
  is working three hundred rows. Accountants asked for this in every accounting
  tool ever built.
- **Motion is 120–180ms, ease-out, and only ever confirms a state change** —
  a flag resolving, a panel opening. Nothing moves to be charming. All of it is
  disabled under `prefers-reduced-motion`.

## Dark mode

Not an inversion. The dark theme uses the same warm hue family (`#14120F`
grounds, not `#000`), keeps the accent at the same perceptual lightness by
lifting it to `#5FA89C`, and holds every contrast ratio. Preparers work late
during filing season; this is a working requirement, not a preference toggle.

---

*The interface should feel like a well-made ledger: quiet, exact, and completely
unambiguous about what needs a human.*
