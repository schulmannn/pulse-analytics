'use strict';

// Trust gate + sanitization for the "🤖 Claude" auto-fix pipeline (security audit finding S1):
//   POST /api/bugs/:id/claude-fix → repository_dispatch → .github/workflows/claude-bugfix.yml,
// where client_payload.text/context are interpolated into a Claude Code agent prompt that runs with
// `contents: write` + `pull-requests: write` and ANTHROPIC_API_KEY.
//
// THREAT: only SUPERUSER-authored reports (POST /api/bugs, requireSuper) are trusted. Crash rows
// (kind='crash') are written by ANY authenticated user via POST /api/client-errors — their name /
// message / componentStack / route / label / user-agent land verbatim in the bug's text+context. So
// an ordinary user can plant prompt-injection that a superuser, triaging a high-severity crash, hands
// to a write-capable CI agent (backdoor PR / secret exfil). This module keeps the gate pure so the
// invariant is unit-guarded — server/index.js listens on require and can't be imported in a test.

// Kinds a human superuser authors via POST /api/bugs. 'crash' is deliberately absent: it is the only
// user-plantable kind and must never drive the agent.
const CLAUDE_FIX_ALLOWED_KINDS = Object.freeze(['bug', 'feature', 'change']);

function canDispatchBugKind(kind) {
  return CLAUDE_FIX_ALLOWED_KINDS.includes(String(kind == null ? '' : kind));
}

// The marker the workflow wraps untrusted fields in. Kept here so the server can neutralize any
// occurrence in the content — otherwise a payload could emit the END marker and smuggle
// trusted-looking instructions after the fence.
const UNTRUSTED_FENCE = 'UNTRUSTED-BUG-REPORT';

// Defense-in-depth applied to every dispatched free-text field (even for allowed kinds — a superuser
// may quote user-supplied text in a bug). Cap length, drop ASCII control chars (keep \t and \n), and
// defang the two trivial prompt-escape scaffolds: the fence marker and role headers (System:/User:/…)
// at line start. NOT a substitute for the kind gate — LLM prompt-injection can't be reliably scrubbed
// by string rules; this only removes the cheap breakout, the human-merge gate and the fence do the rest.
function sanitizeForPrompt(value, maxLen = 4000) {
  let s = String(value == null ? '' : value);
  s = s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ' '); // strip control chars; keep \t (\x09) and \n (\x0A)
  s = s.replace(new RegExp(UNTRUSTED_FENCE, 'gi'), 'untrusted_bug_report');    // can't close the fence
  s = s.replace(/^[ \t>*#-]*(system|assistant|user|developer|tool)[ \t]*:/gim, '$1_:'); // defang role headers
  if (s.length > maxLen) s = s.slice(0, maxLen) + '…';
  return s;
}

module.exports = { CLAUDE_FIX_ALLOWED_KINDS, canDispatchBugKind, UNTRUSTED_FENCE, sanitizeForPrompt };
