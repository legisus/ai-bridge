// Split long text for messengers with a per-message size limit.
// Preferred break points, in order: blank line, newline, sentence end ("). "),
// then a hard cut. In markdown mode a split that lands inside a ``` fence
// closes the fence at the end of the chunk and reopens it at the start of the next.

const SEPARATORS = ["\n\n", "\n", ". "];

function fenceOpen(text) {
  // Odd number of fence lines → we are inside a code block at the end of text.
  const n = (text.match(/^```/gm) || []).length;
  return n % 2 === 1;
}

function fenceLanguage(text) {
  // Language tag of the last opening fence (for the reopen line).
  const lines = text.split("\n");
  let lang = "";
  let open = false;
  for (const l of lines) {
    if (l.startsWith("```")) { open = !open; lang = open ? l.slice(3).trim() : ""; }
  }
  return lang;
}

function chunk(text, limit, mode = "text") {
  text = String(text == null ? "" : text);
  if (!(limit > 0)) throw new Error("chunk: limit must be > 0");
  const out = [];
  let rest = text;
  let reopen = ""; // fence line to prepend to the next chunk (markdown mode)
  while (true) {
    const prefix = reopen ? reopen + "\n" : "";
    const budget = limit - prefix.length - (mode === "markdown" ? 4 : 0); // room for a closing "\n```"
    if (prefix.length + rest.length <= limit) { out.push(prefix + rest); break; }
    let cut = -1;
    let sepLen = 0;
    for (const sep of SEPARATORS) {
      const i = rest.lastIndexOf(sep, budget - 1);
      if (i > 0) { cut = i; sepLen = sep.length; break; }
    }
    let piece, next;
    if (cut === -1) { piece = rest.slice(0, budget); next = rest.slice(budget); }
    else if (sepLen === 2 && rest.slice(cut, cut + 2) === ". ") { piece = rest.slice(0, cut + 1); next = rest.slice(cut + 2); }
    else { piece = rest.slice(0, cut); next = rest.slice(cut + sepLen); }
    let body = prefix + piece;
    reopen = "";
    if (mode === "markdown" && fenceOpen(body)) {
      reopen = "```" + fenceLanguage(body);
      body += "\n```";
    }
    out.push(body);
    rest = next;
  }
  return out;
}

module.exports = { chunk };
