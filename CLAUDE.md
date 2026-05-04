# ICT Autopilot — Working Instructions

## Core Workflow (Follow Strictly)

### 1. Plan First
For any task with 3+ steps, UI changes, or architectural impact: write a clear, numbered plan before coding. Include success criteria.

### 2. Minimal Impact & Simplicity
Always prefer the smallest, cleanest change that solves the problem. Never over-engineer or do unnecessary refactoring. Touch only what is required.

### 3. Ruthless Verification
Never mark a task complete until you have verified it works. Test on mobile, iOS PWA, and live price flows. Use console logs and manual testing.

### 4. Autonomous Bug Fixing
When something breaks, just fix it. Point out the root cause (logs, errors, stale cache, etc.) and resolve it without asking for hand-holding.

### 5. Self-Improvement
After any correction from the user, internalize the lesson immediately so the same mistake is not repeated. Update this file when a durable lesson emerges.

### 6. Elegance Check
For non-trivial features (backtester, news engine, version system, etc.), pause and ask: "Is there a cleaner, more maintainable way?" before committing to an approach.

## Domain Rules (Critical)

- **Do not assume current market prices.** User is operating in **May 2026** (Gold ~$4700, Silver ~$74). Never "correct" seed prices or levels based on older training knowledge.
- **Never refactor or "fix" user's manual entries, SL/TP, bias, or `watch` field** — even if they look inconsistent. They are often intentional (e.g. HTF bearish bias with a counter-trend long scalp at Fib retest = dual setup).
- **iOS PWA caches aggressively.** When features appear missing, always suggest "delete app from home screen and re-add" as the first troubleshooting step before assuming a code bug.

## Project Mindset

- Think like a paranoid senior engineer shipping trading software that real money depends on.
- Prioritize reliability, mobile/PWA experience, and clean code.
- Be pragmatic: "Perfect is the enemy of shipped."
- Keep changes surgical and reversible.

## Session Notes

### Sandbox Push Caveat
Git pushes from this environment route to a sandboxed proxy at `127.0.0.1:*` and may NOT reach real GitHub. Always verify with `git ls-remote origin` before assuming a commit landed. If the branch is missing on the remote, patches are saved at `/home/user/ict-autopilot/.patches/` (gitignored).

### Open Work
- `<meta name="app-version">` + ~30-line auto-update banner so iOS PWA doesn't keep showing stale HTML
- News Risk factor in Confluence Engine still placeholder (70 fixed) — needs wiring to `fetchNews` tagging or a high-impact feed
- Backtester (replay 90d klines vs alerts) — biggest leverage move, blocking the auto-execution conversation
