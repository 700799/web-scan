/* ===========================================================
 * Competitor auto-discovery
 * Uses DuckDuckGo HTML SERP (no API key) via CORS proxy.
 * Extracts top-ranking domains for the user's keywords and
 * filters out the target's own domain + common SaaS/aggregator
 * noise to produce 5 nearest competitors.
 * =========================================================== */

(function (global) {
  'use strict';

  const NOISE = new Set([
    'wikipedia.org','wikimedia.org','youtube.com','facebook.com','twitter.com','x.com',
    'instagram.com','linkedin.com','pinterest.com','reddit.com','quora.com','medium.com',
    'amazon.com','ebay.com','etsy.com','tumblr.com','duckduckgo.com','google.com',
    'bing.com','yahoo.com','yelp.com','tripadvisor.com','indeed.com','glassdoor.com',
    'apple.com','play.google.com','itunes.apple.com',
    'github.com','stackoverflow.com','crunchbase.com','bbb.org',
    'mapquest.com','foursquare.com','manta.com','superpages.com','yellowpages.com',
  ]);

  function rootDomain(host) {
    host = host.replace(/^www\./i, '').toLowerCase();
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    // Handle .co.uk style
    const tld2 = parts.slice(-2).join('.');
    if (/^(co|com|org|net|gov|edu)\.[a-z]{2}$/.test(tld2)) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  }

  function isNoise(host) {
    const r = rootDomain(host);
    return NOISE.has(r) || /\.(gov|edu)$/i.test(host);
  }

  async function searchDDG(query, proxyKey = 'allorigins') {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const proxies = {
      allorigins: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      corsproxy: (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      codetabs: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
    };
    const build = proxies[proxyKey] || proxies.allorigins;
    try {
      const r = await fetch(build(url));
      if (!r.ok) return [];
      const html = await r.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      // DDG html anchors with class "result__a" or "result__url"
      doc.querySelectorAll('a.result__a, a.result__url, a.result-link').forEach((a) => {
        let href = a.getAttribute('href') || '';
        if (href.startsWith('//')) href = 'https:' + href;
        if (href.includes('uddg=')) {
          try { href = decodeURIComponent(href.split('uddg=')[1].split('&')[0]); } catch {}
        }
        try {
          const u = new URL(href);
          out.push(u.hostname.replace(/^www\./, ''));
        } catch {}
      });
      // Fallback: any external anchor
      if (out.length === 0) {
        doc.querySelectorAll('a[href^="http"]').forEach((a) => {
          try {
            const u = new URL(a.getAttribute('href'));
            if (!/duckduckgo|google|bing/i.test(u.hostname)) out.push(u.hostname.replace(/^www\./, ''));
          } catch {}
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  async function discoverCompetitors(targetUrl, keywords, proxyKey = 'allorigins') {
    const targetRoot = rootDomain(new URL(targetUrl).hostname);
    const queries = [];
    if (keywords && keywords.trim()) {
      queries.push(keywords);
      queries.push(`${keywords} services`);
      queries.push(`best ${keywords}`);
    }
    // Always also do a "related:" style fallback
    queries.push(`related:${targetRoot}`);
    queries.push(`"${targetRoot}" alternatives`);

    const seen = new Map(); // root -> score
    for (const q of queries) {
      const hits = await searchDDG(q, proxyKey);
      hits.forEach((host, idx) => {
        const root = rootDomain(host);
        if (root === targetRoot) return;
        if (isNoise(root)) return;
        const score = Math.max(0, 10 - idx); // rank weight
        seen.set(root, (seen.get(root) || 0) + score);
      });
      if (seen.size > 15) break; // enough
    }

    return Array.from(seen.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([root]) => root);
  }

  global.SERPSCOPE = global.SERPSCOPE || {};
  global.SERPSCOPE.competitors = { discoverCompetitors, rootDomain };
})(window);
