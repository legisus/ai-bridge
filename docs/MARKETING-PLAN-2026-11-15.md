# ai-bridge — distribution / advertising plan (2026-11-15)

State today: v0.1.10 (2026-09-07), MIT, 2 stars, 1 fork, no demo GIF, extension not on the Chrome Web Store,
no one-command install, not packaged as an MCP server. DOU "AI шумлять" pitch sent to Pasha Lysyi 2026-11-14
(see ~/Documents/IMMIGRATION/EB1A/Outreach/dou-pasha-lysyi-ai-bridge-2026-11-14.md).

## Step 1 — installable and visible (one week, before any promotion)
1. Chrome Web Store listing (release notes call it "pre-work"; finish it). First click of every reviewer.
2. One-command install: `npx ai-bridge` and/or `brew install legisus/tap/ai-bridge`, plus the existing menu-bar
   DMG. Three install paths at the top of the README.
3. 30-second demo GIF at the top of the README: terminal left, Chrome right, one real task (fill a form, pull a
   Gmail attachment). Needed by every channel below.
4. Package as an MCP server in addition to the CLI → one config line in Claude Desktop, Cursor, Windsurf, Codex;
   gets listed in MCP directories and awesome-lists (main discovery path for agent tools).

## Step 2 — positioning
Competitors: Claude in Chrome (Anthropic), Playwright MCP (Microsoft), Browser Use. Our gap: works with ANY agent
from a shell; runs in your real logged-in profile; localhost only, no cloud; no debugger banner by default;
trusted input for rich editors on demand; cheap-model ladder with a judge so browser tasks cost cents.
Tagline: "your agent, your Chrome, your sessions, localhost only". Lead with the gap, not the feature list.

## Step 3 — channels, by expected return
1. Show HN, Tuesday morning Pacific. Title: "Show HN: ai-bridge – let Claude Code or Codex drive your real
   logged-in Chrome, localhost only". Answer every comment for 6 hours.
2. Reddit: r/ClaudeAI, r/ChatGPTCoding, r/LocalLLaMA, r/ChromeExtensions — GIF + install line, short.
3. Claude Code GitHub Discussions; Anthropic and Cursor Discords (tools / show-and-tell channels).
4. Awesome-lists PRs: awesome-claude-code, awesome-mcp-servers, awesome-browser-automation.
5. Technical article "Why your agent cannot log in, and how a Chrome extension fixes it" — dev.to + LinkedIn
   (weekly AI-news routine) + DOU blog if the segment lands.
6. YouTube 3-minute walkthrough (reviewers embed it; Pasha's show uses screen capture).
7. Product Hunt only after Web Store listing + 100 stars.

## Step 4 — reasons to come back
One wedge use case at a time, published as ready-made recipes: review-form filling for academics, Gmail
attachment fetching, bank-statement downloads, marketplace messaging. Recipes rank in search and get shared.

## Measure (dated log from the first post)
Stars, Web Store installs, npm downloads, GitHub referrers, every third-party mention (URL + date).
EB-1A use: adoption numbers = criterion (v) evidence; DOU / newsletter / YouTube coverage = press items.

## Rules
No fleet size or Turo revenue in any public copy. Commits appear only under the user's name; all repo changes
via branch + PR.

## Next two deliverables
1. README demo script (30-s GIF) — needed before anything else.
2. Show HN draft (title + first comment with the "why").
