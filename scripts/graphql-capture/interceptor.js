// Copilot Money GraphQL capture interceptor.
// Paste into the DevTools console on copilot.money, then reload the page.
// All GraphQL calls land in window.__gqlLog. Drain with JSON.stringify(window.__gqlLog).
(() => {
  if (window.__gqlLogInstalled) {
    console.warn('[gql-capture] already installed');
    return;
  }
  window.__gqlLogInstalled = true;
  window.__gqlLog = window.__gqlLog || [];

  const isGraphQLUrl = (u) => typeof u === 'string' && /graphql/i.test(u);
  const bodyLooksLikeGraphQL = (b) => {
    if (!b) return false;
    const s = typeof b === 'string' ? b : '';
    return s.includes('"query"') || s.includes('"operationName"');
  };

  const headersToObject = (h) => {
    if (!h) return {};
    if (h instanceof Headers) {
      const o = {};
      h.forEach((v, k) => { o[k] = v; });
      return o;
    }
    if (Array.isArray(h)) return Object.fromEntries(h);
    return { ...h };
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    const body = init && init.body;
    const shouldCapture = isGraphQLUrl(url) || bodyLooksLikeGraphQL(body);
    const entry = {
      ts: Date.now(),
      kind: 'fetch',
      url,
      method,
      headers: headersToObject(init && init.headers),
      requestBody: typeof body === 'string' ? body : null,
    };
    const res = await origFetch(input, init);
    if (shouldCapture) {
      try {
        const clone = res.clone();
        const text = await clone.text();
        try { entry.response = JSON.parse(text); } catch { entry.response = text; }
        entry.status = res.status;
        window.__gqlLog.push(entry);
      } catch (e) {
        entry.error = String(e);
        window.__gqlLog.push(entry);
      }
    }
    return res;
  };

  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    const meta = { ts: Date.now(), kind: 'xhr', headers: {} };
    const origOpen = xhr.open;
    xhr.open = function (method, url, ...rest) {
      meta.method = method;
      meta.url = url;
      return origOpen.call(this, method, url, ...rest);
    };
    const origSetHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function (k, v) {
      meta.headers[k] = v;
      return origSetHeader.call(this, k, v);
    };
    const origSend = xhr.send;
    xhr.send = function (body) {
      meta.requestBody = typeof body === 'string' ? body : null;
      xhr.addEventListener('loadend', () => {
        if (isGraphQLUrl(meta.url) || bodyLooksLikeGraphQL(meta.requestBody)) {
          meta.status = xhr.status;
          try { meta.response = JSON.parse(xhr.responseText); } catch { meta.response = xhr.responseText; }
          window.__gqlLog.push(meta);
        }
      });
      return origSend.call(this, body);
    };
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  console.log('[gql-capture] installed. Reload page to capture initial queries.');
})();
