/**
 * Popup — detects service, captures citations, scores them via backend.
 */
(function () {
  "use strict";

  const serviceBadge = document.getElementById("service-badge");
  const statusBar = document.getElementById("status-bar");
  const statusText = document.getElementById("status-text");
  const emptyState = document.getElementById("empty-state");
  const refreshHint = document.getElementById("refresh-hint");
  const citationsSection = document.getElementById("citations-section");
  const citationsCount = document.getElementById("citations-count");
  const scoreBtn = document.getElementById("score-btn");
  const sourceList = document.getElementById("source-list");
  const copyRow = document.getElementById("copy-row");
  // const copyBtn          = document.getElementById('copy-btn');
  const copyFeedback = document.getElementById("copy-feedback");

  let currentSources = [];
  let scoredResults = {};

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setStatus(kind, text) {
    statusBar.className = "status-bar " + kind;
    statusText.textContent = text;
  }

  function setServiceBadge(service) {
    const labels = {
      chatgpt: "ChatGPT",
      claude: "Claude",
      gemini: "Gemini",
      perplexity: "Perplexity",
      unknown: "Not supported",
    };
    serviceBadge.textContent = labels[service] || "—";
    serviceBadge.className =
      "service-badge" + (service && service !== "unknown" ? " active" : "");
  }

  function detectService(url) {
    if (!url) return null;
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host === "chatgpt.com" || host === "chat.openai.com")
        return "chatgpt";
      if (host === "claude.ai") return "claude";
      if (host === "gemini.google.com") return "gemini";
      if (host === "perplexity.ai") return "perplexity";
    } catch (_) {}
    return null;
  }

  function scoreClass(score) {
    if (score === null || score === undefined) return "pending";
    if (score >= 70) return "high";
    if (score >= 45) return "mid";
    return "low";
  }

  function aiLabel(aiProb) {
    if (aiProb === null || aiProb === undefined) return null;
    if (aiProb > 0.65) return { cls: "likely-ai", text: "AI" };
    if (aiProb < 0.35) return { cls: "likely-human", text: "Human" };
    return { cls: "uncertain", text: "Uncertain" };
  }

  function truncate(str, n) {
    if (!str) return "—";
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  }

  function domain(url) {
    try {
      return new URL(url).hostname.replace("www.", "");
    } catch (_) {
      return url;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function renderSources(sources, scored) {
    sourceList.innerHTML = "";

    sources.slice(0, 20).forEach((s) => {
      const result = scored[s.url];
      const hasResult = result && !result.error;
      const score = hasResult ? result.credibility_score : null;
      const aiProb = hasResult ? result.ai_probability : null;
      const reasoning = hasResult && result.reasoning ? result.reasoning : [];
      const cls = scoreClass(score);
      const ai = aiLabel(aiProb);
      const label = s.attribution || s.title || domain(s.url);
      const rid = "r-" + Math.random().toString(36).slice(2, 8);

      const li = document.createElement("li");
      li.className = "source-item";
      li.innerHTML = `
        <div class="source-header">
          <a class="source-link" href="${s.url}" target="_blank" rel="noopener" title="${s.url}">
            ${truncate(label, 55)}
          </a>
          ${
            score !== null
              ? `<span class="score-pill ${cls}">${Math.round(score)}</span>`
              : result?.error
                ? `<span class="score-pill pending">ERR</span>`
                : `<span class="score-pill pending">—</span>`
          }
        </div>
        ${
          score !== null
            ? `
          <div style="display:flex;gap:4px;align-items:center;margin-top:4px;">
            <div class="score-bar-track" style="flex:1">
              <div class="score-bar-fill ${cls}" style="width:${score}%"></div>
            </div>
          </div>`
            : ""
        }
        <div class="source-meta">
          <span class="meta-item">🌐 <span>${truncate(domain(s.url), 28)}</span></span>
          ${hasResult ? `<span class="meta-item">📄 <span>${result.content_type}</span></span>` : ""}
          ${ai ? `<span class="ai-indicator ${ai.cls}">${ai.text}</span>` : ""}
        </div>
        ${
          reasoning.length > 0
            ? `
          <div class="reasoning-toggle" data-rid="${rid}">Why this score? ▾</div>
          <ul class="reasoning-list hidden" id="${rid}">
            ${reasoning.map((r) => `<li>${r}</li>`).join("")}
          </ul>`
            : ""
        }
      `;
      sourceList.appendChild(li);
    });

    if (sources.length > 20) {
      const d = document.createElement("div");
      d.className = "more-label";
      d.textContent = `… and ${sources.length - 20} more`;
      sourceList.appendChild(d);
    }
  }

  // Reasoning toggle (delegated)
  sourceList.addEventListener("click", (e) => {
    const t = e.target.closest(".reasoning-toggle");
    if (!t) return;
    const el = document.getElementById(t.dataset.rid);
    if (!el) return;
    const hidden = el.classList.toggle("hidden");
    t.textContent = hidden ? "Why this score? ▾" : "Why this score? ▴";
  });

  // ── Score via backend ─────────────────────────────────────────────────────
  function scoreAll(sources) {
    if (!sources.length) return;

    scoreBtn.disabled = true;
    scoreBtn.textContent = "Scoring…";

    chrome.runtime.sendMessage(
      { type: "SCORE_URLS", urls: sources.map((s) => s.url) },
      (response) => {
        scoreBtn.disabled = false;
        scoreBtn.textContent = "Re-score Sources";

        if (!response?.success) {
          setStatus("error", "Backend error");
          return;
        }

        response.results.forEach((r) => {
          if (r?.url) scoredResults[r.url] = r;
        });

        setStatus(
          "detected",
          response.cached
            ? "Loaded cached scores"
            : `Scored ${response.results.length} sources`,
        );

        renderSources(sources, scoredResults);
        copyRow.classList.remove("hidden");
      },
    );
  }

  scoreBtn.addEventListener("click", () => scoreAll(currentSources));

  // copyBtn.addEventListener('click', () => {
  //   const data = currentSources.map(s => ({ url: s.url, title: s.title || '', ...( scoredResults[s.url] || {}) }));
  //   navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
  //     copyFeedback.classList.remove('hidden');
  //     setTimeout(() => copyFeedback.classList.add('hidden'), 1500);
  //   });
  // });

  // ── Show states ───────────────────────────────────────────────────────────
  function showEmpty() {
    emptyState.classList.remove("hidden");
    citationsSection.classList.add("hidden");
    refreshHint.classList.add("hidden");
    setStatus("unsupported", "Open a supported AI chat site");
    setServiceBadge("unknown");
  }

  function showUnsupported() {
    emptyState.classList.remove("hidden");
    citationsSection.classList.add("hidden");
    refreshHint.classList.remove("hidden");
    setStatus("loading", "Refresh tab to activate extension");
  }

  function showCitations(service, sources) {
    emptyState.classList.add("hidden");
    refreshHint.classList.add("hidden");
    citationsSection.classList.remove("hidden");
    currentSources = sources;

    if (!sources.length) {
      citationsCount.textContent = "0 sources";
      scoreBtn.classList.add("hidden");
      copyRow.classList.add("hidden");
      sourceList.innerHTML = `<li style="padding:20px 16px;text-align:center;color:#64748b;font-size:12px;">No citations yet — ask with web search enabled</li>`;
    } else {
      citationsCount.textContent = `${sources.length} source${sources.length !== 1 ? "s" : ""}`;
      scoreBtn.classList.remove("hidden");
      if (sources.length) {
        scoreAll(sources);
      }
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    setStatus("loading", "Detecting…");
    refreshHint.classList.add("hidden");

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        showEmpty();
        return;
      }

      const service = detectService(tab.url);
      setServiceBadge(service || "unknown");

      if (!service) {
        showEmpty();
        return;
      }

      setStatus(
        "detected",
        `${service.charAt(0).toUpperCase() + service.slice(1)} detected`,
      );

      chrome.tabs.sendMessage(tab.id, { type: "GET_SERVICE" }, (svcRes) => {
        if (chrome.runtime.lastError || !svcRes) {
          showUnsupported();
          return;
        }

        chrome.tabs.sendMessage(
          tab.id,
          { type: "GET_CITATIONS" },
          (citeRes) => {
            const sources = citeRes?.sources || [];
            showCitations(service, sources);
          },
        );
      });
    });
  }

  init();
})();
