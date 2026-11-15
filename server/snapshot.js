// AI Browser Bridge — `bridge snapshot`: a DOM digest instead of a screenshot.
//
// Returns the page's URL, title, visible text (capped) and every interactive
// element with role, label, state, a stable selector and its viewport box.
// Pierces open shadow roots and same-origin iframes. Runs as a plain `eval`,
// so it works in direct mode and needs no extension update.
//
// Options (all optional): {"tabId":N, "maxText":6000, "maxElements":300,
//   "root":"css selector", "all":true (include non-interactive text blocks)}

"use strict";

// Serialized into the page; must be self-contained (no closures over this file).
function digest(opts) {
  const MAX_TEXT = opts.maxText || 6000;
  const MAX_EL = opts.maxElements || 300;
  const INTERACTIVE = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab]," +
    "[role=checkbox],[role=radio],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox]," +
    "[contenteditable=''],[contenteditable='true'],[onclick],[tabindex]:not([tabindex='-1'])";
  const vw = window.innerWidth, vh = window.innerHeight;
  const seen = new Set();
  const elements = [];
  const textParts = [];
  let textLen = 0;
  let truncatedElements = false;

  const looksGenerated = (s) => /\d{3,}|^[a-z]{1,2}-?[0-9a-f]{5,}|[_-][0-9a-zA-Z]{5,}$|^(css|sc|jss|mui)-/i.test(s) || s.length > 40;
  const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  const uniqueIn = (root, sel) => { try { return root.querySelectorAll(sel).length === 1; } catch { return false; } };

  function selectorFor(el, root) {
    if (el.id && !looksGenerated(el.id) && uniqueIn(root, "#" + cssEsc(el.id))) return "#" + cssEsc(el.id);
    for (const attr of ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label", "data-id", "placeholder", "title"]) {
      const v = el.getAttribute(attr);
      if (v && v.length <= 80) {
        const sel = `${el.tagName.toLowerCase()}[${attr}="${v.replace(/"/g, '\\"')}"]`;
        if (uniqueIn(root, sel)) return sel;
      }
    }
    if (el.tagName === "INPUT" && el.name && el.value && (el.type === "radio" || el.type === "checkbox")) {
      const sel = `input[name="${el.name.replace(/"/g, '\\"')}"][value="${el.value.replace(/"/g, '\\"')}"]`;
      if (uniqueIn(root, sel)) return sel;
    }
    if (el.tagName === "A" && el.getAttribute("href")) {
      const sel = `a[href="${el.getAttribute("href").replace(/"/g, '\\"')}"]`;
      if (uniqueIn(root, sel)) return sel;
    }
    // Structural path, shortest unique suffix.
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== root && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && !looksGenerated(cur.id)) { parts.unshift("#" + cssEsc(cur.id)); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
      const candidate = parts.join(">");
      if (uniqueIn(root, candidate)) return candidate;
    }
    return parts.join(">");
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function labelFor(el) {
    const al = el.getAttribute("aria-label"); if (al) return al.trim();
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { const t = lb.split(/\s+/).map((id) => { const n = el.ownerDocument.getElementById(id); return n ? n.textContent : ""; }).join(" ").trim(); if (t) return t; }
    if (el.id) { const l = el.ownerDocument.querySelector(`label[for="${cssEsc(el.id)}"]`); if (l && l.textContent.trim()) return l.textContent.trim(); }
    const wrap = el.closest && el.closest("label"); if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    return (el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.value && el.tagName === "INPUT" && ["submit", "button"].includes(el.type) && el.value || el.textContent || "").trim();
  }

  function roleOf(el) {
    const r = el.getAttribute("role"); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "button" || t === "summary") return "button";
    if (t === "select") return "combobox";
    if (t === "textarea" || el.isContentEditable) return "textbox";
    if (t === "input") {
      const ty = (el.type || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(ty)) return "button";
      if (ty === "checkbox" || ty === "radio") return ty;
      return ty === "text" ? "textbox" : ty;
    }
    return t;
  }

  function walk(root, doc, frame) {
    const scope = root.querySelectorAll ? root : doc;
    const nodes = scope.querySelectorAll(INTERACTIVE);
    for (const el of nodes) {
      if (elements.length >= MAX_EL) { truncatedElements = true; break; }
      if (seen.has(el) || !visible(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      const item = {
        i: elements.length,
        role: roleOf(el),
        tag: el.tagName.toLowerCase(),
        label: labelFor(el).replace(/\s+/g, " ").slice(0, 120),
        selector: selectorFor(el, scope.querySelectorAll ? scope : doc),
        box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      };
      if (frame) item.frame = frame;
      if (el.tagName === "A" && el.href) item.href = el.href.slice(0, 200);
      if ("value" in el && el.tagName !== "BUTTON" && el.type !== "password" && typeof el.value === "string" && el.value) item.value = el.value.slice(0, 120);
      if (el.tagName === "SELECT") item.options = Array.from(el.options).slice(0, 40).map((o) => o.text.trim().slice(0, 60));
      if (el.type === "checkbox" || el.type === "radio" || el.getAttribute("aria-checked") != null) item.checked = el.checked != null ? !!el.checked : el.getAttribute("aria-checked");
      if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) item.offscreen = true;
      elements.push(item);
    }
    // Shadow roots and same-origin iframes.
    const all = scope.querySelectorAll("*");
    for (const el of all) {
      if (el.shadowRoot) walk(el.shadowRoot, doc, frame);
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        try {
          const d = el.contentDocument;
          if (d && d.body) walk(d.body, d, (frame ? frame + ">" : "") + selectorFor(el, doc));
        } catch {}
      }
    }
  }

  function collectText(root) {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
        const t = n.nodeValue.replace(/\s+/g, " ").trim();
        if (!t) return NodeFilter.FILTER_REJECT;
        return visible(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode()) && textLen < MAX_TEXT) {
      const t = n.nodeValue.replace(/\s+/g, " ").trim();
      textParts.push(t); textLen += t.length + 1;
    }
    for (const el of root.querySelectorAll("*")) {
      if (textLen >= MAX_TEXT) break;
      if (el.shadowRoot) collectText(el.shadowRoot.firstElementChild ? el.shadowRoot : el);
      if (el.tagName === "IFRAME") { try { if (el.contentDocument && el.contentDocument.body) collectText(el.contentDocument.body); } catch {} }
    }
  }

  const rootEl = opts.root ? document.querySelector(opts.root) : document.body;
  if (!rootEl) return { error: `root not found: ${opts.root}` };
  walk(rootEl, document, "");
  collectText(rootEl);
  const text = textParts.join(" ");
  return {
    url: location.href, title: document.title, readyState: document.readyState,
    viewport: [vw, vh], scroll: [Math.round(scrollX), Math.round(scrollY)],
    docHeight: Math.round(document.documentElement.scrollHeight),
    text: text.slice(0, MAX_TEXT), textTruncated: textLen >= MAX_TEXT,
    elements, elementsTruncated: truncatedElements,
  };
}

// Build the eval params for `bridge snapshot {...}`: same tabId/direct, code = digest(opts).
function buildEvalParams(params) {
  const { tabId, direct, maxText, maxElements, root, all, ...rest } = params || {};
  const opts = { maxText, maxElements, root, all };
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
  const code = `(${digest.toString()})(${JSON.stringify(opts)})`;
  const out = { ...rest, code };
  if (tabId != null) out.tabId = tabId;
  if (direct !== undefined) out.direct = direct;
  return out;
}

module.exports = { digest, buildEvalParams };
