<div align="center">

# Legible

**Turn research papers, RFCs and specs into something you can actually understand — and watch.**

Paste a URL, drop a PDF, and get a plain-English explainer with diagrams, an
autoplaying reel of illustrated cards, narration in 16 languages, and
interactive simulators you can drag.

Runs entirely on your own machine. Everything lives in one SQLite file.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)
![No API key required](https://img.shields.io/badge/API%20key-optional-success.svg)

</div>

---

## Why

Papers are written for people who already understand them. The 60-second summary
you get elsewhere is too thin to be useful, and the paper itself is too dense to
start with. Legible sits in between: it reads the whole document once, then
explains it thirteen different ways — plain summary, the problem it solves, an
analogy, the maths line by line, architecture diagrams, an honest list of what it
does *not* prove — and then cuts the same material into a short vertical reel so
the ideas actually stick.

---

## What it does

### Reads almost anything

| Source | How |
|---|---|
| **URL** | Fetched and stripped to article text with Readability |
| **PDF** | Text extracted per page |
| **DOCX / DOC** | Converted with Mammoth |
| **Pasted text** | Straight in |

Long documents are fitted to a token budget that keeps the beginning, the end and
the densest middle, so a 90-page spec still produces a coherent explainer.

### Writes a real explainer, not a summary

Up to **13 sections**, each written separately so a failure in one never kills the
report:

`The 60-Second Version` · `What Problem Does It Solve?` · `Explain It Like a Story`
· `How It Actually Works` · `Architecture & Diagrams` · `The Maths, Slowly` ·
`A Worked Example` · `Deep Dive` · `How It Fits The Bigger Picture` ·
`Limits, Risks & Criticisms` · `Jargon Decoder` · `Questions You Might Have` ·
`What To Remember`

The maths section is the point of difference: every symbol is named, every formula
is read aloud in English, and each one gets a tiny worked example with small
numbers you can check by hand.

**Diagrams** are generated as Mermaid and rendered inline. **Architecture**,
**glossary** and **FAQ** are structured data, not prose blobs.

### Templates

Five built-in profiles (paper deep-dive, RFC/spec, quick brief, and more) choose
which sections run and who the reader is — from *curious non-technical* to
*working developer*. Make your own; editing a built-in saves a copy instead of
overwriting it.

### ⚡ Shorts — an explainer reel

Any finished document can be cut into **10–14 vertical cards** and played like a
reel:

- **Autoplays** with story-style progress bars, timed by how much there is to read
- Headlines animate in word by word, figures count up
- **Tap the middle to pause, the sides to skip**; `space`, `↑`, `↓`, `f` for full screen
- **⛶ Theatre mode** hands the whole window to the reel and shapes the card like a phone

Every card is **illustrated by an animation chosen for that idea** — eight scene
types drawn on canvas:

| Scene | Used for |
|---|---|
| `demo` | **the thing actually happening** — see below |
| `actors` | metaphors and objects: a query 🔎 meeting keys 🔑 and values 📦 |
| `flow` | pipelines and protocols, with a packet travelling the chain |
| `compare` | before/after, ticked and crossed |
| `grid` | matrices, attention maps, causal masks |
| `split` | parallel copies — eight attention heads fanning out |
| `stack` | depth and repeated blocks |
| `bars` | real figures from the document, counting up |

`demo` is the one that makes a card feel like an explainer rather than a slide:
objects genuinely move and collide, with force arrows, speed streaks and impact
bursts. Modes are `accelerate`, `collide`, `push`, `fall`, `orbit`, `grow`.

> Run it over Newton's laws and the model picks, unprompted: two cars colliding
> for the third law, a trolley accelerating under a steady push, a rock falling,
> exhaust shoving a rocket, and Newton's cannonball orbiting the Earth.

### 🌐 16 languages, translated live

Hindi · Bengali · Tamil · Telugu · Marathi · Spanish · French · German ·
Portuguese · Japanese · Korean · Chinese · Arabic · Russian · Indonesian · English

The whole deck is translated in one pass so the cards stay consistent, then cached
in SQLite — a language is paid for once. Switching keeps your place and keeps
playing. Numbers and equations are never altered, technical terms stay in English
where that is what practitioners actually say, and Arabic renders right-to-left.

### 🔊 Real recorded narration

On macOS each card is synthesised with the system voices — Samantha, Lekha
(Hindi), Piya (Bengali), Vani (Tamil), Geeta (Telugu), Kyoko, Tingting and so on —
at 188 wpm and cached as WAV. Novelty voices are filtered out. Off macOS it falls
back to browser speech, which plays but cannot be recorded.

### ⬇ Export the reel as a real video

1080×1920 H.264 **MP4 with the narration mixed in** as an AAC track (WebM/Opus
where MP4 isn't supported). Card timings stretch to fit the voice so nothing is
cut mid-sentence. Recording is real-time — a 3-minute reel takes 3 minutes.

### 🎛 Interactive simulators

The pipeline pulls **relationships worth playing with** out of the document and
turns them into sliders. From *Attention Is All You Need* it produced the
self-attention vs recurrent cost ratio — with the insight that it *"crosses 1
precisely when n equals d"* — plus the learning-rate warmup schedule and the √d_k
scaling.

### 🧊 3D scenes (three.js)

Drag to rotate, wheel to zoom, sliders to drive. Five kinds covering maths,
physics, chemistry, game development and ML:

| Kind | For |
|---|---|
| `surface` | z = f(x,y): loss landscapes, energy wells, trade-off spaces. Set `descent` and a ball rolls downhill |
| `molecule` | atoms and bonds in real 3D coordinates |
| `projectile` | motion under gravity with the arc drawn |
| `orbit` | central forces and anything periodic |
| `transform` | translate / rotate / scale, for linear algebra and engine transforms |

### 🤖 AI console

Each project has a chat tab that knows what you have already read, and can
suggest what to read next — returning real, checkable citations that become new
tabs in one click.

### 💾 Opens where you left off

Everything generated has always lived in SQLite, so nothing is lost when the app
closes. It also remembers *where you were* — project, tab, view, card and language
— server-side rather than in `localStorage`, so the same place opens on your
laptop and on your phone.

---

## Requirements

| | |
|---|---|
| **Node.js** | 20 or newer (built and tested on 24) |
| **An engine** | the `claude` CLI, the `codex` CLI, **or** an Anthropic API key |
| **macOS** | only for recorded narration (`say`). Everything else is cross-platform |
| **cloudflared** | only if you want a public URL |

No API key is needed if you already have the Claude Code or Codex CLI signed in.

---

## Setup

```bash
git clone <your-fork-url> legible
cd legible
npm install
npm start
```

Open **http://127.0.0.1:4317**.

> Use `127.0.0.1`, not `localhost` — the server binds IPv4, and `localhost`
> resolves to IPv6 `::1` on many systems.

On first run it creates `data/research.db` and seeds the built-in templates.
Pick your engine in **Settings**, then hit **New Project**.

### Choosing an engine

| Engine | Requirement | Notes |
|---|---|---|
| **Claude Code CLI** | `claude` on PATH | No API key. Uses your existing sign-in |
| **Codex CLI** | `codex` on PATH | No API key |
| **Anthropic API** | API key in Settings or `ANTHROPIC_API_KEY` | Billed per token |

Test the connection with the button in Settings before starting a long run.

---

## Hosting

The app has two ties to the machine it runs on: the CLIs are **authenticated
locally**, and narration needs the macOS **`say`** command. Moving it to a Linux
box costs you both — so it stays put and a tunnel puts a URL in front of it.

```bash
./host.sh            # public https:// URL via Cloudflare, password on
./host.sh --lan      # this Wi-Fi only, password on
./host.sh --local    # this machine only, no password
```

`./host.sh` prints a `https://….trycloudflare.com` address that works from
anywhere while your Mac is awake. It calls `caffeinate` so the Mac won't sleep and
drop the link, and Ctrl-C shuts the tunnel and server down together.

**A password is mandatory off localhost.** The first non-local start generates
one, prints it, and writes it to `data/ACCESS.txt` — save it, delete the file, and
change it in Settings.

<details>
<summary>Troubleshooting the tunnel</summary>

- **Quick-tunnel URLs are ephemeral** and change on every restart. For a stable
  URL you need a free Cloudflare account, a domain, and a *named* tunnel
  (`cloudflared tunnel create`) instead of `--url`.
- **QUIC is blocked on many corporate networks** (UDP 7844). `host.sh` already
  passes `--protocol http2`, which survives those.
- **Some corporate DNS resolvers filter `trycloudflare.com`.** If the tunnel
  registers but the hostname won't resolve, that's your network — the URL will
  still work from outside it.

</details>

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4317` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address. `127.0.0.1` disables auth (loopback only) |
| `DR_PUBLIC` | — | `1` marks cookies `Secure` (set when behind HTTPS) |
| `DR_AUTH` | — | `off` disables the password gate. Only sane on loopback |
| `ANTHROPIC_API_KEY` | — | Used if no key is set in Settings |

---

## Security

This app shells out to locally-authenticated CLIs and holds everything you have
ever researched, so exposure is treated seriously.

- **Password gate is automatic off-loopback** — you cannot accidentally publish it
  unprotected. scrypt-hashed password, HMAC-signed `HttpOnly` session cookies,
  `Secure` behind HTTPS, exponential lockout after five wrong guesses, and
  changing the password invalidates every session. Nothing is exempt except the
  login page itself — including the narration audio.
- **Model-authored formulas are never `eval`'d.** Simulators and 3D surfaces come
  from a language model, so `public/formula.js` is a real recursive-descent parser
  with a function whitelist, and `server/simulations.js` validates every
  expression, variable range and slider reference *before* anything is written to
  disk. `alert(1)`, `constructor`, `__proto__` and `fetch()` are parse errors, not
  code.
- **No shell interpolation.** Every subprocess is spawned with an argument array,
  never a shell string.
- **Nothing leaves your machine** except the document fetch and the calls to your
  chosen engine.

---

## How it works

```
server/
  index.js         HTTP API, static files, auth wiring
  db.js            SQLite schema and migrations
  pipeline.js      recon → sections → diagrams → glossary → simulators → 3D
  prompts.js       every prompt, in one place
  providers.js     Claude CLI / Codex CLI / Anthropic API, with retries
  extract.js       URL, PDF, DOCX extraction and token budgeting
  shorts.js        card feed, translation, scene specs
  narrate.js       macOS `say` narration into cached WAV clips
  simulations.js   validation for model-authored formulas and 3D scenes
  console.js       project chat and paper suggestions
  auth.js          password gate, sessions, rate limiting

public/
  app.js           the whole UI
  scenes.js        2D card animations (shared by reel and video export)
  three-scenes.js  3D scenes
  formula.js       safe arithmetic parser
  styles.css       black theme
```

The pipeline runs sections **concurrently** and streams progress over SSE, so text
appears as it is written. Each section is independent — one failure degrades the
report instead of destroying it.

The **same canvas draw code** runs in the live reel and in the video exporter, so
what you watch is what you get.

### Data

Everything is in `data/`:

```
data/research.db     all projects, reports, cards, translations, settings
data/narration/      cached WAV clips per language
data/uploads/        original PDFs and documents
data/ACCESS.txt      generated password, first run only — delete after saving
```

`data/` is git-ignored. Back it up by copying the folder; there is nothing else.

---

## Limitations

Stated plainly, because they matter:

- **Recorded narration is macOS-only.** Elsewhere the in-app voice still works but
  cannot be recorded into the exported video.
- **Video export is real-time** and needs the tab in front. A 3-minute reel takes
  3 minutes.
- **Card animations are canvas motion graphics, not generated footage.** A
  Schrödinger card gets an animated 🐱 and 📦 — not a cat that walks.
- **Quality depends on the source.** A scanned PDF with no text layer yields
  little; the app tells you how many characters it actually read.
- **The model can be wrong.** Prompts push hard toward "the document does not say"
  over invention, and simulators are validated against the document's own figures,
  but this is an explainer over an LLM — check anything load-bearing against the
  original, which is always one tab away.

---

## License

[Apache License 2.0](LICENSE) — commercial use, modification and distribution are
all permitted, with attribution and the patent grant that comes with it.
