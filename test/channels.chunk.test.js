#!/usr/bin/env node
// chunk(text, limit, mode): size-bounded splits that prefer paragraph, newline,
// sentence; markdown mode closes/reopens code fences across a split.
const { chunk } = require("../server/channels/chunk.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

assert(JSON.stringify(chunk("hello", 4000)) === '["hello"]', "short text → one chunk");
assert(JSON.stringify(chunk("", 4000)) === '[""]', "empty text → one empty chunk");

// paragraph preference
{
  const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"x".repeat(300)}`);
  const text = paras.join("\n\n");
  const out = chunk(text, 4000);
  assert(out.every((c) => c.length <= 4000), "paragraphs: every chunk ≤ limit");
  assert(out.length > 1, "paragraphs: text was split");
  assert(out.every((c) => c.startsWith("Paragraph")), "paragraphs: splits land on paragraph boundaries");
  assert(out.join("\n\n") === text, "paragraphs: join restores original");
}

// newline preference when no blank lines
{
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${"y".repeat(120)}`);
  const text = lines.join("\n");
  const out = chunk(text, 1000);
  assert(out.every((c) => c.length <= 1000), "newlines: every chunk ≤ limit");
  assert(out.every((c) => c.startsWith("line")), "newlines: splits land on line boundaries");
  assert(out.join("\n") === text, "newlines: join restores original");
}

// sentence preference when a single long line
{
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here and it goes on for a while.`).join(" ");
  const out = chunk(text, 400);
  assert(out.every((c) => c.length <= 400), "sentences: every chunk ≤ limit");
  assert(out.slice(1).every((c) => c.startsWith("Sentence")), "sentences: splits after '. '");
  assert(out.join(" ") === text, "sentences: join restores original");
}

// hard cut when there are no separators at all
{
  const out = chunk("z".repeat(5000), 4000);
  assert(out.length === 2 && out[0].length === 4000 && out[1].length === 1000, "no separators: hard cut at limit");
}

// markdown: fence reopening
{
  const code = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n");
  const text = `Intro\n\n\`\`\`js\n${code}\n\`\`\`\n\nOutro`;
  const out = chunk(text, 500, "markdown");
  assert(out.every((c) => c.length <= 500), "markdown: every chunk ≤ limit");
  assert(out.length > 1, "markdown: text was split");
  for (let i = 0; i < out.length; i++) {
    const fences = (out[i].match(/^```/gm) || []).length;
    assert(fences % 2 === 0, `markdown: chunk ${i} has balanced fences`);
  }
  const inner = out.filter((c) => c.includes("const v"));
  assert(inner.every((c) => /^```/m.test(c)), "markdown: code chunks are wrapped in a fence");
}

process.exit(failures ? 1 : 0);
