/**
 * Injected into page (MAIN world) on ChatGPT and Claude to intercept conversation/completion streams.
 * Parses SSE for citations and dispatches via postMessage so the content script can receive them.
 *
 * ChatGPT: POST .../backend-api/.../conversation -> sources_footnote / content_references
 * Claude:  POST ...claude.ai/.../completion     -> citation_start_delta + tool_result knowledge array
 */

(function () {
  'use strict';

  const CONVERSATION_PATH = '/backend-api/';
  const CONVERSATION_SUBPATH = 'conversation';
  const CITATIONS_EVENT = 'AICredibilityCitations';
  const DEBUG = true;

  function getRequestUrl(input, options) {
    if (typeof input === 'string') return input;
    if (input && typeof input === 'object' && 'url' in input) return input.url;
    return '';
  }

  function getRequestMethod(input, options) {
    if (input && typeof input === 'object' && input instanceof Request) return input.method || 'GET';
    return (options && options.method) ? String(options.method).toUpperCase() : 'GET';
  }

  // ----- ChatGPT: extract from sources_footnote / content_references -----
  function extractSourcesFromPayload(obj, found) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) extractSourcesFromPayload(obj[i], found);
      return;
    }
    if (obj.type === 'sources_footnote' && Array.isArray(obj.sources)) {
      for (const s of obj.sources) {
        if (s && typeof s.url === 'string') found.push({ url: s.url, title: s.title || '', attribution: s.attribution || '' });
      }
      return;
    }
    if (Array.isArray(obj.items)) {
      for (const item of obj.items) {
        if (item && typeof item.url === 'string') found.push({ url: item.url, title: item.title || '', attribution: item.attribution || '' });
      }
    }
    for (const key of Object.keys(obj)) extractSourcesFromPayload(obj[key], found);
  }

  function processDataLineChatGPT(line, collected) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '[DONE]') return;
    try {
      const data = JSON.parse(trimmed);
      extractSourcesFromPayload(data, collected);
    } catch (_) {}
  }

  // ----- Claude: extract from citation_start_delta and tool_result partial_json -----
  function createClaudeProcessor() {
    let jsonBuffer = '';
    return function processDataLineClaude(line, collected) {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const data = JSON.parse(trimmed);
        if (data.type === 'content_block_delta' && data.delta) {
          const d = data.delta;
          if (d.citation) {
            const c = d.citation;
            const url = c.url || (c.sources && c.sources[0] && c.sources[0].url);
            if (url) {
              const attribution = (c.metadata && c.metadata.site_name) || (c.sources && c.sources[0] && c.sources[0].source) || '';
              collected.push({ url, title: c.title || '', attribution: attribution || '' });
            }
          }
          if (d.partial_json) {
            jsonBuffer += d.partial_json;
            try {
              const parsed = JSON.parse(jsonBuffer);
              if (Array.isArray(parsed)) {
                for (const item of parsed) {
                  if (item && typeof item.url === 'string') {
                    const meta = item.metadata || {};
                    collected.push({
                      url: item.url,
                      title: item.title || '',
                      attribution: meta.site_name || meta.site_domain || '',
                    });
                  }
                }
                jsonBuffer = '';
              }
            } catch (_) {}
          }
        }
        if (data.type === 'content_block_stop' && jsonBuffer) {
          try {
            const parsed = JSON.parse(jsonBuffer);
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (item && typeof item.url === 'string') {
                  const meta = item.metadata || {};
                  collected.push({
                    url: item.url,
                    title: item.title || '',
                    attribution: meta.site_name || meta.site_domain || '',
                  });
                }
              }
            }
          } catch (_) {}
          jsonBuffer = '';
        }
        // Claude Messages API: tool_use blocks sometimes carry citation/source data
        if (data.type === 'content_block_start' && data.content_block) {
          const block = data.content_block;
          if (block.type === 'tool_use' && block.input && Array.isArray(block.input)) {
            for (const item of block.input) {
              if (item && typeof item.url === 'string') {
                const meta = item.metadata || {};
                collected.push({
                  url: item.url,
                  title: item.title || '',
                  attribution: meta.site_name || meta.site_domain || '',
                });
              }
            }
          }
        }
      } catch (_) {}
    };
  }

  /**
   * Consume stream, parse SSE, extract sources with platform-specific parser, dispatch when done.
   */
  function consumeStream(stream, decoder, platform) {
    const reader = stream.getReader();
    let buffer = '';
    const collected = [];
    const processDataLine = platform === 'claude' ? createClaudeProcessor() : processDataLineChatGPT;

    function processBuffer() {
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          processDataLine(payload, collected);
        }
      }
    }

    function read() {
      return reader.read().then(({ value, done }) => {
        if (value) buffer += decoder.decode(value, { stream: true });
        processBuffer();
        if (done) {
          processBuffer();
          const seen = new Set();
          const unique = collected.filter((s) => {
            const key = s.url;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          if (DEBUG) console.log('[AI Source Credibility] Stream ended. Extracted', unique.length, 'sources.');
          if (unique.length > 0) {
            try {
              window.postMessage({ type: CITATIONS_EVENT, sources: unique }, '*');
              if (DEBUG) console.log('[AI Source Credibility] Dispatched', unique.length, 'citations to extension.');
            } catch (e) {
              if (DEBUG) console.warn('[AI Source Credibility] Dispatch error', e);
            }
          }
          return;
        }
        return read();
      });
    }
    return read();
  }

  /** Only intercept requests to these hosts so third-party (e.g. statsig.anthropic.com) never go through our logic. */
  function getHost(urlStr) {
    try {
      return new URL(urlStr).hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function shouldIntercept(urlStr, method) {
    if (!urlStr || method !== 'POST') return false;
    const host = getHost(urlStr);
    if (host === 'chatgpt.com' || host === 'chat.openai.com') {
      return urlStr.includes(CONVERSATION_PATH) && urlStr.includes(CONVERSATION_SUBPATH);
    }
    if (host === 'claude.ai') {
      return urlStr.includes('completion');
    }
    return false;
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = getRequestUrl(input, init);
    const method = getRequestMethod(input, init);

    // Only intercept conversation/completion streams on our target hosts. All other requests
    // (e.g. statsig.anthropic.com) pass through unchanged. If another extension blocks those
    // requests (net::ERR_BLOCKED_BY_CLIENT), the stack may still show this wrapper.
    if (!shouldIntercept(url, method)) {
      return originalFetch.apply(this, arguments);
    }

    const platform = getHost(url) === 'claude.ai' ? 'claude' : 'chatgpt';
    if (DEBUG) console.log('[AI Source Credibility] Intercepting', platform, 'request:', url);

    return originalFetch.apply(this, arguments).then((response) => {
      if (!response.ok || !response.body) return response;
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream') && !contentType.includes('text/plain')) {
        if (DEBUG) console.log('[AI Source Credibility] Skipping (content-type):', contentType);
        return response;
      }

      const tee = response.body.tee();
      const stream1 = tee[0];
      const stream2 = tee[1];
      const decoder = new TextDecoder();
      consumeStream(stream2, decoder, platform);

      return new Response(stream1, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
  };
})();
