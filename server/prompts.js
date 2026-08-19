export const AUDIENCES = {
  'non-technical': {
    label: 'Curious non-technical reader',
    brief:
      'a smart, curious adult with no technical background. They have never written code. ' +
      'Assume nothing beyond everyday computer use (browsers, apps, files).',
  },
  'basic-tech': {
    label: 'Basic technical knowledge',
    brief:
      'someone with basic technical knowledge. They know what a website, a server, a database and an API roughly are, ' +
      'but they have never read an academic paper or a spec, and they do not know the jargon of this field.',
  },
  'junior-dev': {
    label: 'Junior developer, new to research',
    brief:
      'a junior software developer. They can read code and they know basic programming, but they have never read an academic paper, ' +
      'they are rusty on maths beyond school algebra, and every Greek letter, subscript and summation sign is a wall to them. ' +
      'They are smart and motivated — they want the real thing explained properly, not a watered-down version.',
  },
  developer: {
    label: 'Working developer',
    brief:
      'a working software developer who is new to this specific topic. They are comfortable with code and systems, ' +
      'but not with this domain\'s notation, jargon or literature.',
  },
};

export function systemPrompt(audience) {
  const a = AUDIENCES[audience] ?? AUDIENCES['basic-tech'];
  return `You are a patient, precise technical explainer. You take dense material — research papers, RFCs, specifications, technical docs — and make it genuinely understandable without dumbing it down or making things up.

YOUR READER: ${a.brief}

HOW YOU WRITE
- Plain, direct English. Short sentences. Active voice.
- Every piece of jargon gets defined in plain words the first time you use it, inline, e.g. "attention (the mechanism that lets the model weigh which earlier words matter most)".
- Use concrete analogies from everyday life, then immediately connect the analogy back to the real mechanism so the reader is not left with only a metaphor.
- Prefer numbers and specifics from the document over vague claims.
- Never pad. No "in today's fast-paced world", no restating the heading, no summarising what you are about to say.

ACCURACY RULES — THESE ARE NOT OPTIONAL
- Only state things the source document supports. This is an explainer, not a creative exercise.
- If the document does not say something, say so plainly ("the paper does not report X") rather than inventing it.
- Clearly separate what the document claims from what it actually demonstrates.
- If you draw on your own background knowledge to give context, mark it as context, not as something the document says.

FORMAT
- Output GitHub-flavoured Markdown.
- Do NOT write a top-level heading for the section — the heading is added for you. Start directly with content.
- Use "###" for any sub-headings you need, bullet lists, bold for key terms, and tables where they genuinely help.`;
}

export const RECON_PROMPT = (docText, sourceLabel) => `Read this document and produce a structured reconnaissance of it. This will be used to plan a plain-English explainer, so be accurate and specific.

SOURCE: ${sourceLabel}

<document>
${docText}
</document>

Return JSON with exactly this shape:
{
  "title": "the document's real title",
  "docType": "one of: research paper | RFC | specification | technical documentation | blog post | book chapter | patent | report | other",
  "authorsOrOrg": "authors or issuing organisation if stated, else empty string",
  "year": "year if stated, else empty string",
  "oneLiner": "one sentence, max 30 words, saying what this document is about in plain English",
  "field": "the field or domain, in plain words",
  "keyClaims": ["3-6 specific claims or contributions the document actually makes"],
  "keyTerms": ["6-14 jargon terms, acronyms or symbols a newcomer would trip over"],
  "structure": ["the document's main parts in order, as short labels"],
  "systemShape": "2-4 sentences describing the architecture, system, protocol or process the document describes — the moving parts and how they connect. If the document describes no system, say so.",
  "numbers": ["notable concrete results, measurements or parameters, with units — up to 6, empty array if none"],
  "confidence": "high | medium | low — how complete and readable the extracted text was"
}`;

const SECTION_BRIEFS = {
  tldr: `Write the 60-second version.
- Open with one bold sentence: what this document is and why anyone should care.
- Then 4-6 bullets covering: the problem, the core idea, how it works at the highest level, what the results/impact are, and who this matters to.
- A reader who stops here should be able to hold their own in a conversation about it.`,

  problem: `Explain the problem this work exists to solve.
- Start with the situation BEFORE this work: what people did, and what specifically went wrong or was missing. Make the pain concrete.
- Explain why the obvious fixes don't work — this is what makes the contribution non-trivial.
- End with one sentence stating precisely what this document set out to achieve.`,

  analogy: `Explain the core idea as a story or analogy.
- Pick ONE analogy from everyday life (a post office, a library, a kitchen, a group of translators…) that genuinely maps onto the mechanism. Commit to it.
- Walk through the analogy as a short narrative.
- Then add a mapping table: each part of the analogy in one column, what it actually is in the document in the other.
- Finish with "Where the analogy breaks down" — 1-3 honest bullets. This matters; do not skip it.`,

  how: `Explain how it actually works, in layers.
- Layer 1: the whole thing in 3-5 sentences.
- Layer 2: walk through the main components or steps in order. Give each a "###" sub-heading in plain words (not the paper's jargon name — put that in brackets after).
- For each step: what goes in, what happens to it, what comes out, and why that step is needed at all.
- Layer 3: the one or two clever bits — the insights that make this work where earlier attempts failed.
- Define every symbol or piece of notation you use.`,

  architecture: `Describe the architecture and produce diagrams. THIS SECTION HAS A SPECIAL FORMAT — see the JSON schema below.`,

  math: `Teach the maths from the ground up. Assume the reader last did algebra at school and finds Greek letters intimidating. Do not skip steps and do not apologise for going slowly.

For EVERY equation or formula that matters in this document:
- **Say what it is for first**, in one plain sentence, before showing any notation. "This formula answers the question: how much should each word pay attention to every other word?"
- **Show the equation**, on its own line, using LaTeX-free plain notation or simple inline code. Write \`sum over i\` rather than an unexplained sigma if that is clearer.
- **Name every single symbol** in a bullet list underneath: the symbol, what it stands for, what type of thing it is (a number? a vector? a matrix? how big?), and where it came from.
- **Read the equation out loud in English**, left to right, as a sentence a person could say.
- **Do one tiny numeric example** with small made-up numbers — 2 or 3 elements, not 512 — and show the actual arithmetic step by step so the reader can check it by hand.
- **Say why it is built that way**: what would break if you removed a term, a square root, a normalisation.

Also cover, briefly and only where the document relies on them:
- Any background concept the reader needs first (dot products, matrices, probability, gradients, logarithms) — one short plain-English paragraph each, in the order they are needed.
- What the notation conventions in this document mean (bold = vector, superscripts = layer index, and so on).

If the document contains no real mathematics, say so in one line and instead explain the quantitative logic it does use — the counts, thresholds, complexity claims or resource limits — with the same care.`,

  walkthrough: `Trace one concrete example end to end.
- Invent a small, realistic input (or use one from the document if it gives one) and follow it all the way through the system, step by step, showing what it looks like at each stage.
- Use real-looking values, not placeholders like "X" — a reader should be able to picture it.
- Number the steps. Show intermediate state.
- End with the final output and one sentence on what just happened.`,

  deep: `Go deeper for a reader who wants the substance.
- The method or mechanism in more precise detail, still in plain language. Explain any maths in words first, then show the formula and name every symbol.
- What evidence the document gives: experiments, benchmarks, proofs, deployments. What was measured, against what baseline, and what the numbers actually were.
- What those results do and do not prove.
- The design decisions and trade-offs, and what was given up for what.
- If the document contains no evaluation, say that clearly and explain what that means for how much weight to give its claims.`,

  context: `Place this in the bigger picture. Draw on your own knowledge here, and mark it clearly as background rather than something the document says.
- What came before this, and what problem the field was stuck on.
- How this compares to the main alternative approaches — a comparison table works well.
- What this enabled or influenced afterwards, if you know.
- Where a reader would encounter this in the real world: products, protocols, systems they may already use.
- If your knowledge of what came after this document is incomplete or may be out of date, say so.`,

  limits: `Be the honest critic.
- Limitations the document itself admits.
- Limitations it does not admit but that a careful reader should notice: assumptions, narrow test conditions, scale, cost, missing baselines, security or privacy implications.
- Known criticisms or failures of this approach from the wider field, if you know them — marked as outside context.
- Where this approach is the wrong tool for the job.
Be specific and fair. Do not manufacture criticism, and do not soften real problems.`,

  glossary: `Produce the jargon decoder. THIS SECTION HAS A SPECIAL FORMAT — see the JSON schema below.`,

  faq: `Answer the questions a smart reader would actually have after reading the above.
- 6-9 questions. Write them the way a real person would ask them ("Wait, why doesn't it just…?", "Is this the thing behind…?", "Could I build this myself?").
- Include at least two sceptical questions and answer them honestly.
- Each answer: 2-5 sentences, direct, no hedging.
- Format each as a bolded question followed by the answer.`,

  takeaways: `What to remember.
- 5-7 bullets. Each one a complete, standalone thought that survives on its own out of context.
- Then a short "If you remember only one thing" line in bold.
- Then "Where to go next": 2-4 concrete suggestions — sections of the original worth reading, related work worth looking up, or something to try.`,
};

export function sectionPrompt({ key, heading, recon, docText, sourceLabel, extraInstructions, written }) {
  const brief = SECTION_BRIEFS[key] ?? `Write the section titled "${heading}".`;
  const context = `WHAT WE KNOW ABOUT THIS DOCUMENT
Title: ${recon.title || '(unknown)'}
Type: ${recon.docType || '(unknown)'}${recon.authorsOrOrg ? `\nBy: ${recon.authorsOrOrg}` : ''}${recon.year ? ` (${recon.year})` : ''}
In one line: ${recon.oneLiner || ''}
Field: ${recon.field || ''}
Key claims: ${(recon.keyClaims || []).map((c) => `\n  - ${c}`).join('')}
The system it describes: ${recon.systemShape || ''}
Jargon a newcomer will trip on: ${(recon.keyTerms || []).join(', ')}
${(recon.numbers || []).length ? `Concrete numbers: ${recon.numbers.join('; ')}` : ''}`;

  const alreadyCovered = written?.length
    ? `\n\nSections already written (do not repeat their content — you may reference them):\n${written.map((w) => `  - ${w}`).join('\n')}`
    : '';

  return `You are writing ONE section of a plain-English explainer of the document below.

SECTION TO WRITE: "${heading}"

WHAT THIS SECTION MUST DO:
${brief}${alreadyCovered}

${context}
${extraInstructions ? `\nEXTRA INSTRUCTIONS FOR THIS REPORT:\n${extraInstructions}\n` : ''}
SOURCE: ${sourceLabel}
<document>
${docText}
</document>

Write only the body of the "${heading}" section, in Markdown. No top-level heading, no preamble, no sign-off.`;
}

export function architecturePrompt({ recon, docText, sourceLabel, extraInstructions }) {
  return `Produce the "Architecture & Diagrams" section for a plain-English explainer of the document below.

You must produce:
1. A written walkthrough of the architecture — the moving parts, what each one is responsible for, and how data or messages flow between them. Plain language, no unexplained jargon. Markdown, "###" sub-headings allowed.
2. Between 2 and 4 Mermaid diagrams that a newcomer can actually read.

DIAGRAM RULES — FOLLOW EXACTLY, BROKEN DIAGRAMS ARE WORSE THAN NO DIAGRAMS
- Use only these diagram types: "flowchart TD", "flowchart LR", "sequenceDiagram", "stateDiagram-v2", "erDiagram".
- ALWAYS wrap every node label in double quotes: A["User request"] not A[User request]. This is mandatory — labels with brackets, parentheses, commas or slashes break the parser otherwise.
- Node IDs: short and alphanumeric only (A, B, step1, db). Never use a reserved word (end, graph, class, style, click, subgraph) as an ID.
- Keep each diagram to 12 nodes or fewer. Two clear diagrams beat one crowded one.
- Label the arrows where the label adds meaning: A -->|"encrypted payload"| B
- Use plain-English labels, not the document's raw notation.
- For sequenceDiagram use: participant A as "Client" then A->>B: message
- Do NOT include the \`\`\`mermaid fence in the code field — just the diagram source.

Good diagram set for most documents:
  1. A high-level flowchart of the whole system or process.
  2. A zoom-in on the single most important component, or a sequence diagram of the main interaction.
  3. Optionally: the data/state model, or a before-vs-after comparison.

WHAT WE KNOW ABOUT THIS DOCUMENT
Title: ${recon.title || '(unknown)'}
Type: ${recon.docType || '(unknown)'}
In one line: ${recon.oneLiner || ''}
The system it describes: ${recon.systemShape || ''}
Key claims: ${(recon.keyClaims || []).map((c) => `\n  - ${c}`).join('')}
${extraInstructions ? `\nEXTRA INSTRUCTIONS FOR THIS REPORT:\n${extraInstructions}\n` : ''}
SOURCE: ${sourceLabel}
<document>
${docText}
</document>

Return JSON with exactly this shape:
{
  "body": "the written architecture walkthrough, in Markdown",
  "diagrams": [
    { "title": "short title of the diagram",
      "caption": "1-2 plain sentences telling the reader what to look at and what it means",
      "code": "the Mermaid source, no fences" }
  ]
}

If the document genuinely describes no system, process or protocol, return a body explaining what it does describe and a single diagram summarising its logical structure or argument.`;
}

export function glossaryPrompt({ recon, docText, sourceLabel }) {
  return `Build a jargon decoder for a newcomer reading the document below.

Pick 10-18 terms: acronyms, notation, and words this field uses in a special way. Prefer the ones that would genuinely stop a reader. Skip anything a general audience already knows.

For each term give a plain-English explanation of 1-3 sentences. Explain what it IS and why it matters here — not a dictionary definition. No jargon inside the explanations.

Terms this document leans on: ${(recon.keyTerms || []).join(', ')}

SOURCE: ${sourceLabel}
<document>
${docText}
</document>

Return JSON with exactly this shape:
{ "terms": [ { "term": "the term or acronym", "plain": "the plain-English explanation" } ] }

Order them roughly by how early or how often a reader will hit them.`;
}

/* ═══════════════════════════════ AI console ══════════════════════════════ */

export const CONSOLE_SYSTEM = `You are a research librarian for AI and computer systems. A developer describes what they are trying to understand, and you work out which primary sources — research papers, RFCs, and specifications — will actually get them there.

You know this literature well. You recommend the real, load-bearing documents: the paper that introduced an idea, the RFC that defines a protocol, the spec people actually implement. You do not pad the list with survey articles, blog posts or textbook chapters unless nothing better exists.

You are honest about the limits of your memory. If you are not certain a paper exists under the exact title you remember, you say so rather than inventing a plausible-looking citation.`;

export const consolePrompt = ({ request, history, existing }) => `A developer is building up a reading list. Recommend the primary sources that will genuinely teach them what they want to know.

WHAT THEY ASKED FOR:
${request}
${history?.length ? `\nEARLIER IN THIS CONVERSATION:\n${history.map((m) => `${m.role === 'user' ? 'They asked' : 'You suggested'}: ${m.content.slice(0, 700)}`).join('\n')}\n` : ''}
${existing?.length ? `\nALREADY IN THEIR PROJECT (do not suggest these again):\n${existing.map((e) => `  - ${e}`).join('\n')}\n` : ''}
Return JSON with exactly this shape:
{
  "reply": "2-5 sentences in plain English: what you understood them to be asking, the shape of the reading list you are giving them, and the order you suggest reading it in. Address them directly. Markdown allowed.",
  "suggestions": [
    {
      "title": "the exact title of the document",
      "authors": "first author et al., or the RFC's author/organisation. Empty string if unsure.",
      "year": "publication year as a string, empty if unsure",
      "kind": "paper | rfc | spec | article",
      "url": "a direct URL. For arXiv papers use https://arxiv.org/abs/XXXX.XXXXX . For RFCs use https://www.rfc-editor.org/rfc/rfcNNNN.txt . Use an empty string rather than guessing a URL you are not confident about — the title will be used to look it up instead.",
      "why": "1-2 sentences: what THIS document specifically gives them that the others do not",
      "readsBefore": "what to read first if this one assumes prior knowledge, else empty string",
      "confidence": "high | medium | low — how sure you are this document exists exactly as described"
    }
  ]
}

RULES
- Between 3 and 6 suggestions. Fewer good ones beats more padded ones.
- Order them the way they should be read: foundations first, then the specific thing they asked about, then anything that extends it.
- Prefer documents you are confident about. Mark anything shaky as "low" confidence.
- If their request is vague, still give a useful starting list, and use the "reply" to ask the one question that would sharpen it.
- If they are asking about something with no real research literature behind it, say so honestly in the reply and suggest the closest useful thing.`;

/* ══════════════════════════════ shorts feed ══════════════════════════════ */

export const shortsPrompt = ({ recon, docText, sourceLabel, headlines }) => `Turn this document into a scrollable feed of short cards — the format people flick through one at a time on a phone.

The point is retention. Someone who swipes through all the cards in three minutes should walk away actually remembering the ideas, in order, and able to explain them to a friend. A long report they skim teaches them nothing; twelve sharp cards teach them a lot.

HOW EACH CARD MUST WORK
- ONE idea per card. If a card needs "and", it is two cards.
- The headline is the idea, not a label. "Words look at each other" beats "Self-Attention Mechanism". Under 60 characters.
- The body is 25-45 words of plain English that makes the headline click. Concrete, not abstract. No jargon unless the card is the one that defines it.
- Every card must be true to the document. Punchy is good; exaggerating is not. Do not invent numbers.
- Cards must build: each one should make sense because of the ones before it.

THE SHAPE OF THE FEED
1. Card 1 is the hook: the surprising or high-stakes thing that makes someone keep scrolling. A question or a bold fact. Never "This paper introduces…".
2. Then the problem — what was broken before, made vivid.
3. Then the core ideas, one per card, in the order that builds understanding.
4. Sprinkle in "number" cards for the striking figures, and "analogy" cards where an everyday comparison unlocks something.
5. At least one honest "catch" card: the limitation, cost or trade-off. Do not skip this.
6. The last card is the payoff: what the reader now understands and why it matters to them.

WHAT WE KNOW ABOUT THE DOCUMENT
Title: ${recon.title || '(unknown)'}
Type: ${recon.docType || '(unknown)'}
In one line: ${recon.oneLiner || ''}
The system it describes: ${recon.systemShape || ''}
Key claims: ${(recon.keyClaims || []).map((c) => `\n  - ${c}`).join('')}
${(recon.numbers || []).length ? `Concrete numbers available: ${recon.numbers.join('; ')}` : ''}
${headlines?.length ? `\nThe full explainer covers these sections: ${headlines.join(', ')}` : ''}

SOURCE: ${sourceLabel}
<document>
${docText}
</document>

Return JSON with exactly this shape:
{
  "cards": [
    {
      "kind": "hook | problem | idea | number | analogy | catch | payoff",
      "emoji": "a single emoji that fits the card",
      "headline": "the idea itself, under 60 characters",
      "body": "25-45 words of plain English",
      "punch": "a short figure or phrase to show large on the card, e.g. '65M parameters' or '3.5 days'. Empty string when the card has no single striking figure — do not force one.",
      "scene": { "see the ANIMATED SCENE section below" }
    }
  ]
}

ANIMATED SCENE — every card gets one
Each card is animated, not just text. You choose which of these seven scenes illustrates that card's idea, and you fill in its labels. Pick the scene that actually shows the idea; do not default to one type for everything.

1. "actors" — characters or objects that stand for something, with a relationship between them.
   Use it for: metaphors, everyday analogies, anything with a "thing" you can picture — a cat in a box, a librarian and a shelf, a sender and a receiver.
   { "type": "actors", "items": [ { "emoji": "🐱", "label": "the cat" }, { "emoji": "📦", "label": "sealed box" } ], "link": "unknown until opened" }
   2 or 3 items. "link" is a short phrase shown on the connector, or "".

2. "flow" — steps in order, with something travelling through them.
   Use it for: pipelines, processes, protocols, "input goes in, output comes out".
   { "type": "flow", "items": [ { "emoji": "📝", "label": "raw text" }, { "emoji": "⚙️", "label": "encoder" }, { "emoji": "🌍", "label": "translation" } ] }
   2 to 4 items.

3. "compare" — two things side by side, the old way and the new way.
   Use it for: before/after, this-vs-that, what was replaced.
   { "type": "compare", "left": { "emoji": "🐌", "label": "read word by word", "verdict": "bad" }, "right": { "emoji": "⚡", "label": "read all at once", "verdict": "good" } }
   "verdict" is "good", "bad" or "".

4. "grid" — a square grid of cells lighting up.
   Use it for: everything-attends-to-everything, matrices, coverage, parallel work, combinations.
   { "type": "grid", "size": 6, "label": "every word scores every other word", "pattern": "all" }
   "size" 3 to 8. "pattern" is "all" (fills in), "diagonal", or "row" (one row at a time).

5. "split" — one thing fans out into several and merges back.
   Use it for: parallel copies, multiple heads/workers/views, divide and recombine.
   { "type": "split", "count": 8, "label": "8 attention heads", "from": "one input", "to": "one output" }
   "count" 2 to 12.

6. "stack" — layers piling up one on another.
   Use it for: depth, repeated blocks, layered architectures, protocol stacks.
   { "type": "stack", "count": 6, "label": "6 identical layers", "top": "output", "bottom": "input" }
   "count" 2 to 8.

7. "demo" — SHOW THE THING HAPPENING. Objects that actually move, collide, fall and get pushed.
   Use it whenever the idea is physical, causal, or about something changing over time: a force, a
   collision, gravity, speed, pressure, growth, orbiting, cause and effect. PREFER THIS over a
   diagram whenever the concept can be demonstrated with a moving object — it is the most memorable
   scene there is.
   { "type": "demo", "mode": "accelerate", "actors": [ { "emoji": "🚗", "label": "the car" } ], "force": "engine", "caption": "same push, faster and faster" }
   Modes, and what each one animates:
     "accelerate" — one object speeds up under a steady force. actors: 1. For force, acceleration, compounding, exponential growth.
     "collide"    — two objects rush together, hit, and bounce apart. actors: 2. For equal-and-opposite forces, momentum, conflict, trade-offs.
     "push"       — one actor pushes another object along. actors: 2 (pusher, then the thing pushed). For applied force, work, cause and effect.
     "fall"       — an object falls and bounces. actors: 1. For gravity, decay, dropping, attraction.
     "orbit"      — one object circles another. actors: 2 (the orbiter, then the centre). For cycles, loops, attraction, feedback.
     "grow"       — one object swells. actors: 1. For scaling, inflation, growth, blow-up.
   "force" is a 1-3 word label on the arrow ("engine", "gravity", "push"). "caption" is a short line
   above the action, 3-6 words, saying what to notice.

8. "bars" — a small bar chart.
   Use it for: number cards, comparisons of size, cost, speed or score.
   { "type": "bars", "unit": "BLEU", "items": [ { "label": "previous best", "value": 26.4 }, { "label": "this paper", "value": 28.4, "highlight": true } ] }
   2 to 4 items, real values from the document only.

SCENE RULES
- Labels are 1-4 words. They are read at a glance on a phone.
- Use real emoji that a person would recognise. One emoji per item.
- Never invent numbers for a "bars" scene. If the document gives no comparable figures, use a different scene type.
- The scene must show what the headline says. A card about a cat in a box gets a cat and a box, not a generic flowchart.
- Ask first: "could I demonstrate this with something moving?" If yes, use "demo". A card about force
  gets cars actually accelerating or colliding — never two static panels captioned "force". Diagrams
  are the fallback for ideas that genuinely have no physical action, like a data structure or a stack
  of layers.

Produce 10 to 14 cards. Fewer sharp cards beat more padded ones.`;

/* ═══════════════════════════ shorts translation ══════════════════════════ */

export const LANGUAGES = [
  { code: 'en',    label: 'English',    native: 'English',   voice: 'en-US' },
  { code: 'hi',    label: 'Hindi',      native: 'हिन्दी',     voice: 'hi-IN' },
  { code: 'bn',    label: 'Bengali',    native: 'বাংলা',      voice: 'bn-IN' },
  { code: 'ta',    label: 'Tamil',      native: 'தமிழ்',      voice: 'ta-IN' },
  { code: 'te',    label: 'Telugu',     native: 'తెలుగు',      voice: 'te-IN' },
  { code: 'mr',    label: 'Marathi',    native: 'मराठी',      voice: 'mr-IN' },
  { code: 'es',    label: 'Spanish',    native: 'Español',   voice: 'es-ES' },
  { code: 'fr',    label: 'French',     native: 'Français',  voice: 'fr-FR' },
  { code: 'de',    label: 'German',     native: 'Deutsch',   voice: 'de-DE' },
  { code: 'pt',    label: 'Portuguese', native: 'Português', voice: 'pt-BR' },
  { code: 'ja',    label: 'Japanese',   native: '日本語',      voice: 'ja-JP' },
  { code: 'ko',    label: 'Korean',     native: '한국어',      voice: 'ko-KR' },
  { code: 'zh',    label: 'Chinese',    native: '中文',        voice: 'zh-CN' },
  { code: 'ar',    label: 'Arabic',     native: 'العربية',    voice: 'ar-SA', rtl: true },
  { code: 'ru',    label: 'Russian',    native: 'Русский',   voice: 'ru-RU' },
  { code: 'id',    label: 'Indonesian', native: 'Bahasa Indonesia', voice: 'id-ID' },
];

export const translateShortsPrompt = ({ language, cards, title }) => `Translate this deck of explainer cards into ${language.label} (${language.native}).

These cards are watched one at a time, like a short video. The translation has to work spoken aloud and read at a glance — not as a literal word-for-word rendering.

RULES
- Translate into natural, everyday ${language.label} — the way a person would actually explain this to a friend. Not textbook register, not machine-literal.
- Keep every number, unit, symbol and equation EXACTLY as it is. Do not localise digits, convert units, or re-order figures.
- Established technical terms usually stay in English where that is what practitioners in ${language.label} actually say (for example "self-attention", "softmax", "TLS handshake"). Translate the surrounding explanation, and on first use add a short gloss in ${language.label} in brackets if it helps.
- Headlines must stay punchy and short — aim for a similar visual length to the original, never more than about 70 characters.
- Bodies stay roughly the same length. Do not add commentary, do not omit anything.
- The "punch" field is a figure shown very large. Keep the number identical; translate only any word attached to it (e.g. "3.5 days" → the ${language.label} for days).
- "tag" is a 2-3 word category label shown in a small pill. Translate it naturally and keep it short.
- "sceneLabels" are the captions on the card's animation. They are 1-4 words each and are read at a glance, so keep them very short. Return the same number of strings in the same order.

Source document: ${title}

CARDS (JSON):
${JSON.stringify(
  cards.map((c, i) => ({
    i,
    tag: c.tag,
    headline: c.headline,
    punch: c.punch,
    body: c.body,
    sceneLabels: c.sceneLabels ?? [],
  })),
  null,
  1
)}

Return JSON with exactly this shape, one entry per card, in the same order, with the same "i" values:
{
  "cards": [
    { "i": 0, "tag": "…", "headline": "…", "punch": "…", "body": "…", "sceneLabels": ["…"] }
  ]
}

Return all ${cards.length} cards. If a punch field was empty, return it empty.`;


/* ═════════════════════════════ simulations ═════════════════════════════ */

export const simulationsPrompt = ({ recon, docText, sourceLabel }) => `Find the relationships in this document that a reader could PLAY WITH, and turn them into interactive simulators.

A simulator is a formula plus sliders. The reader drags a slider and watches the answer move. This is how someone actually feels why a result is true, instead of taking it on faith.

SOURCE: ${sourceLabel}
DOCUMENT TITLE: ${recon.title}

<document>
${docText}
</document>

WHAT MAKES A GOOD ONE
- It must come from THIS document — a formula it states, a scaling law it relies on, a cost or performance relationship it demonstrates. Do not invent physics the document never mentions.
- The interesting part is the SHAPE of the relationship: something that grows quadratically, saturates, trades off, or has a surprising break-even point. A straight line nobody would misjudge is not worth a slider.
- Defaults should reproduce a real figure from the document where possible, so the reader starts at a number they just read about.
- 2 to 3 variables. One is boring, four is a control panel.

FORMULA RULES — the expression is evaluated by a small arithmetic parser, not a programming language
- Allowed: + - * / % ^ ( ) and the variable names you declare.
- Allowed functions: abs sqrt cbrt exp ln log log2 log10 sin cos tan asin acos atan floor ceil round sign min max pow
- Allowed constants: pi, e
- No assignments, no conditionals, no other names of any kind. Every name in the expression MUST be one of your declared variable keys, a listed function, or pi/e.
- Variable keys: short, letters/digits/underscore only, no spaces.

Return JSON:
{
  "simulations": [
    {
      "title": "short, plain English, e.g. 'How attention cost grows with sentence length'",
      "blurb": "one or two sentences: what this computes and why it matters",
      "expression": "n^2 * d",
      "output_label": "Operations per layer",
      "output_unit": "ops",
      "vars": [
        { "key": "n", "label": "Words in the sentence", "unit": "words", "min": 1, "max": 512, "step": 1, "value": 64 },
        { "key": "d", "label": "Model width", "unit": "dims", "min": 64, "max": 1024, "step": 64, "value": 512 }
      ],
      "insight": "one sentence naming what to notice while dragging — e.g. 'double the sentence and the cost quadruples'"
    }
  ]
}

Return 1 to 3 simulations. If the document genuinely contains no quantitative relationship worth playing with, return {"simulations": []} — an empty list is a valid, honest answer.`;

/* ═══════════════════════════ 3D scenes (three.js) ══════════════════════ */

export const scenes3dPrompt = ({ recon, docText, sourceLabel }) => `Build interactive 3D scenes that let a reader SEE the ideas in this document in space, and drag sliders to change them.

These render with three.js. The reader can rotate the scene with a drag and zoom with the wheel. Pick scenes that genuinely need three dimensions or genuinely benefit from being driven by hand — not decoration.

SOURCE: ${sourceLabel}
DOCUMENT TITLE: ${recon.title}

<document>
${docText}
</document>

THE FIVE KINDS. Pick whichever fit; skip the rest.

1. "surface" — a 3D landscape of z = f(x, y).
   For: any function of two variables, optimisation landscapes, loss surfaces, energy wells, trade-off spaces, interference patterns.
   { "kind": "surface", "expression": "(x^2 + y^2)/4", "xMin": -3, "xMax": 3, "yMin": -3, "yMax": 3,
     "descent": true, "rateKey": "rate", "startX": 2.4, "startY": 2.2 }
   - "expression" may use x, y and any variable key you declare. Same arithmetic rules as below.
   - Set "descent": true to drop a ball that rolls downhill — this is how you show gradient descent,
     energy minimisation or any "settles to the lowest point" idea. Declare a variable for the step
     size and name it in "rateKey".

2. "molecule" — atoms joined by bonds, in real 3D coordinates.
   For: chemistry, molecular structure, crystal lattices, and any "nodes joined by links" structure.
   { "kind": "molecule", "atoms": [ {"el":"O","x":0,"y":0,"z":0}, {"el":"H","x":0.76,"y":0.59,"z":0} ],
     "bonds": [ {"a":0,"b":1} ], "spin": true }
   - "el" drives the colour and radius: H C N O S P Cl Na Fe are known, anything else gets a default.
   - Coordinates in ångström-ish units; keep the whole thing within about ±5.
   - "bonds" index into "atoms" by position, starting at 0.

3. "projectile" — a body thrown under gravity, with its full arc drawn.
   For: ballistics, motion under a constant force, anything with a launch and a landing.
   { "kind": "projectile", "speedKey": "speed", "angleKey": "angle", "gravityKey": "gravity" }
   - Declare variables with those keys. Angle is in degrees, gravity in m/s².

4. "orbit" — one body circling another.
   For: orbital mechanics, central forces, cycles, feedback loops, anything periodic.
   { "kind": "orbit", "radiusKey": "radius", "massKey": "mass" }

5. "transform" — a cube you can translate, rotate and scale, with axes and a ghost of the original.
   For: linear algebra, coordinate systems, game-engine transforms, rotations.
   { "kind": "transform", "txKey":"tx", "tyKey":"ty", "tzKey":"tz", "rxKey":"rx", "ryKey":"ry", "rzKey":"rz", "scaleKey":"scale" }
   - Rotations in degrees.

FORMULA RULES (the "surface" expression only) — evaluated by a small arithmetic parser, not a language
- Allowed: + - * / % ^ ( ) , the names x and y, and any variable key you declare.
- Allowed functions: abs sqrt cbrt exp ln log log2 log10 sin cos tan asin acos atan floor ceil round sign min max pow
- Allowed constants: pi, e
- No other names of any kind.

VARIABLES
- Every *Key you name MUST have a matching entry in "vars".
- 1 to 4 variables, each { key, label, unit, min, max, step, value }, with min < max and value inside the range.
- Keys: letters, digits, underscore. No spaces. Must not be a function name or pi/e.

Return JSON:
{
  "scenes": [
    {
      "title": "short and plain, e.g. 'The loss landscape gradient descent walks down'",
      "blurb": "one or two sentences: what you are looking at, and what the sliders do",
      "kind": "surface",
      "spec": { "kind": "surface", "expression": "...", "descent": true, "rateKey": "rate" },
      "vars": [ { "key": "rate", "label": "Learning rate", "unit": "", "min": 0.01, "max": 0.5, "step": 0.01, "value": 0.12 } ],
      "insight": "one sentence naming what to notice — e.g. 'turn the rate up too far and it overshoots and never settles'"
    }
  ]
}

Return 0 to 2 scenes. Only build one where 3D genuinely helps. If this document has nothing spatial or nothing worth driving by hand, return {"scenes": []} — that is a perfectly good answer and much better than a decorative cube.`;
