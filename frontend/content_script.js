/**
 * Content script — injected into ChatGPT, Claude, Gemini, Perplexity.
 * 1. Injects inject.js into MAIN world to intercept citation streams.
 * 2. Watches DOM for external links and badges them with credibility scores.
 * 3. Responds to popup messages.
 */

(function () {
  "use strict";

  // ── Inject fetch interceptor ──────────────────────────────────────────────
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // ── Badge styles ──────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .ai-cred-badge {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      font-weight: 700;
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      padding: 1px 6px;
      border-radius: 4px;
      margin-left: 5px;
      vertical-align: middle;
      cursor: default;
      border: 1px solid;
      line-height: 1.6;
      position: relative;
      white-space: nowrap;
    }
    /* tooltip shown via JS mouseenter */
    .ai-cred-badge.high  { color: #10b981; border-color: rgba(16,185,129,0.5); background: rgba(16,185,129,0.12); }
    .ai-cred-badge.mid   { color: #f59e0b; border-color: rgba(245,158,11,0.5);  background: rgba(245,158,11,0.12);  }
    .ai-cred-badge.low   { color: #ef4444; border-color: rgba(239,68,68,0.5);   background: rgba(239,68,68,0.12);   }
    .ai-cred-badge.pending {
      color: #64748b;
      border-color: rgba(100,116,139,0.3);
      background: rgba(100,116,139,0.08);
      animation: ai-cred-pulse 1.2s infinite;
    }
    @keyframes ai-cred-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
    .ai-cred-tooltip {
      display: none;
      position: fixed;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 10px 12px;
      width: 260px;
      z-index: 2147483647;
      box-shadow: 0 8px 32px rgba(0,0,0,0.8);
      pointer-events: none;
      text-align: left;
    }
    .ai-cred-tooltip-title {
      font-size: 12px;
      font-weight: 700;
      color: #f1f5f9;
      margin-bottom: 6px;
      font-family: 'SF Mono', monospace;
    }
    .ai-cred-tooltip-reason {
      font-size: 11px;
      color: #94a3b8;
      line-height: 1.5;
      padding: 1px 0;
      font-weight: 400;
      font-family: system-ui, sans-serif;
    }
    .ai-cred-tooltip-reason::before { content: '→ '; color: #7c3aed; }
  `;
  document.head.appendChild(style);

  // ── State ─────────────────────────────────────────────────────────────────
  let lastCitations = [];
  const scoredCache = {}; // url -> result

  // ── Helpers ───────────────────────────────────────────────────────────────
  function scoreClass(score) {
    if (score >= 70) return "high";
    if (score >= 45) return "mid";
    return "low";
  }

  function isSelfDomain(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return (
        host.includes("chatgpt.com") ||
        host.includes("openai.com") ||
        host.includes("claude.ai") ||
        host.includes("gemini.google.com") ||
        host.includes("perplexity.ai") ||
        host.includes("google.com")
      );
    } catch (_) {
      return true;
    }
  }

  function removePending(anchor) {
    const next = anchor.nextElementSibling;
    if (next && next.classList.contains("ai-cred-badge")) next.remove();
  }

  function addPendingBadge(anchor) {
    removePending(anchor);
    const badge = document.createElement("span");
    badge.className = "ai-cred-badge pending";
    badge.textContent = "…";
    anchor.insertAdjacentElement("afterend", badge);
  }

  // Single shared tooltip appended to body
  const sharedTooltip = document.createElement("div");
  sharedTooltip.className = "ai-cred-tooltip";
  sharedTooltip.style.display = "none";
  document.body.appendChild(sharedTooltip);

  function addScoredBadge(anchor, result) {
    removePending(anchor);
    const score = result.credibility_score;

    if (score === null || score === undefined || isNaN(score)) {
      return;
    }

    const reasoning = result.reasoning || [];
    const badge = document.createElement("span");
    badge.className = `ai-cred-badge ${scoreClass(score)}`;
    badge.textContent = Math.round(score);

    if (reasoning.length > 0) {
      const html =
        `<div class="ai-cred-tooltip-title">⚡ Credibility: ${Math.round(score)}/100</div>` +
        reasoning
          .map((r) => `<div class="ai-cred-tooltip-reason">${r}</div>`)
          .join("");

      badge.addEventListener("mouseenter", () => {
        sharedTooltip.innerHTML = html;
        sharedTooltip.style.display = "block";
        const rect = badge.getBoundingClientRect();
        const left = Math.min(rect.left, window.innerWidth - 275);
        if (rect.top > 160) {
          sharedTooltip.style.top = "";
          sharedTooltip.style.bottom = window.innerHeight - rect.top + 8 + "px";
        } else {
          sharedTooltip.style.bottom = "";
          sharedTooltip.style.top = rect.bottom + 8 + "px";
        }
        sharedTooltip.style.left = left + "px";
      });

      badge.addEventListener("mouseleave", () => {
        sharedTooltip.style.display = "none";
      });
    }

    anchor.insertAdjacentElement("afterend", badge);
  }

  // ── Find unprocessed external anchors ─────────────────────────────────────
  function findNewAnchors() {
    const all = document.querySelectorAll('a[href^="http"]:not([data-aicred])');
    const results = [];
    all.forEach((a) => {
      if (isSelfDomain(a.href)) return;
      a.setAttribute("data-aicred", "1");
      results.push(a);
    });
    return results;
  }

  // ── Score and badge a batch ───────────────────────────────────────────────
  function scoreAndBadge(anchors) {
    if (!anchors.length) return;

    const anchorMap = {}; // url -> [anchor, ...]
    const toFetch = [];

    anchors.forEach((a) => {
      const url = a.href;
      if (scoredCache[url]) {
        addScoredBadge(a, scoredCache[url]);
        return;
      }
      addPendingBadge(a);
      if (!anchorMap[url]) {
        anchorMap[url] = [];
        toFetch.push(url);
      }
      anchorMap[url].push(a);
    });

    if (!toFetch.length) return;

    chrome.runtime.sendMessage(
      { type: "SCORE_URLS", urls: toFetch },
      (response) => {
        if (!response || !response.success) {
          // Remove pending badges on failure
          Object.values(anchorMap).flat().forEach(removePending);
          return;
        }
        response.results.forEach((result) => {
          if (!result?.url) return;
          scoredCache[result.url] = result;
          (anchorMap[result.url] || []).forEach((a) => {
            if (result.error) removePending(a);
            else addScoredBadge(a, result);
          });
        });
      },
    );
  }

  // ── MutationObserver — catches links as ChatGPT streams response ──────────
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const anchors = findNewAnchors();
      if (anchors.length) scoreAndBadge(anchors);
    }, 300);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial scan after page settles
  setTimeout(() => {
    const anchors = findNewAnchors();
    if (anchors.length) scoreAndBadge(anchors);
  }, 2000);

  // ── Listen for citations from inject.js (for popup) ───────────────────────
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (
      event.data.type === "AICredibilityCitations" &&
      Array.isArray(event.data.sources)
    ) {
      lastCitations = event.data.sources;
    }
  });

  // ── Popup messages ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "GET_SERVICE") {
      const host = window.location.hostname.toLowerCase();
      let service = "unknown";
      if (host === "chatgpt.com" || host === "chat.openai.com")
        service = "chatgpt";
      else if (host === "claude.ai") service = "claude";
      else if (host === "gemini.google.com") service = "gemini";
      else if (host === "perplexity.ai") service = "perplexity";
      sendResponse({ service, pageUrl: window.location.href });
      return true;
    }
    if (message.type === "GET_CITATIONS") {
      sendResponse({ sources: lastCitations });
      return true;
    }
  });
})();
