/**
 * Service worker — handles API calls and global cache for scores.
 */

const API_BASE = "http://159.203.124.143:8000";

// Global cache (persists while extension service worker is alive)
const scoreCache = {}; // url -> result

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SCORE_URLS") {
    const urls = message.urls || [];

    // Split cached vs uncached
    const uncached = urls.filter((url) => !scoreCache[url]);

    // If everything already cached
    if (uncached.length === 0) {
      sendResponse({
        success: true,
        results: urls.map((url) => scoreCache[url]),
        cached: true,
      });
      return true;
    }

    // Fetch only uncached URLs
    fetch(`${API_BASE}/analyze_urls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ urls: uncached }),
    })
      .then((r) => r.json())
      .then((data) => {
        // Store in cache
        data.forEach((result) => {
          if (result?.url) {
            scoreCache[result.url] = result;
          }
        });

        // Return results in original order
        const mergedResults = urls.map((url) => scoreCache[url]);

        sendResponse({
          success: true,
          results: mergedResults,
          cached: false,
        });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: err.message,
        });
      });

    return true; // keep async channel open
  }
});
