# SERPSCOPE — SEO Intelligence Platform

A single-page, fully client-side SEO audit & competitive-intelligence tool, designed to feel like a professional SEO consultancy dashboard. Drop a URL in, get a multi-dimensional score, side-by-side benchmark against five competitors, and a prioritized action plan.

Runs entirely in the browser. Hosted on GitHub Pages. No backend required (optional GitHub Actions cron for true server-side scheduled audits).

## Live demo

Enable **GitHub Pages** for this repo (Settings → Pages → Source: `main` branch, root). The app will be served at:

```
https://<your-user>.github.io/web-scan/
```

## What it does

- **On-Page audit** — titles, descriptions, headings, alt text, internal/external linking, Open Graph, Twitter Cards, canonicals, structured data, lang, favicon.
- **Technical audit** — HTTPS, mobile viewport, robots, sitemap, fetch latency, HTML payload, script/CSS count, mixed content, modern image formats, hreflang, Core Web Vitals (via PSI).
- **Content analysis** — word count, Flesch reading ease, keyword diversity, top-keyword density, heading rhythm, multimedia richness, freshness markers.
- **Off-Page signals** — social presence, TLD trust, robots.txt + sitemap, brand entity declarations, E-E-A-T proxies, citation health.
- **Accessibility & best practices** — form-field labels, button names, heading-order integrity, skip links, ARIA usage, descriptive anchor text, `target="_blank"` safety, Content Security Policy, Subresource Integrity, resource hints (preconnect/preload), CLS-safe image dimensions, and PWA chrome (manifest, Apple touch icon, theme color).
- **Competitive benchmark** — your site + 5 competitors on a radar / bar / matrix chart with a ranked comparison table.
- **Prioritized action plan** — P0–P3, quick-win filter, impact + effort estimates, step-by-step fixes.
- **Email reports** — via EmailJS (browser) or SMTP (GitHub Actions).
- **Scheduled monitoring** — browser-side reminders + GitHub Actions cron workflow.

## Scoring model

```
SERPSCOPE Index =
    On-Page    × 30 %
  + Technical  × 30 %
  + Content    × 25 %
  + Off-Page   × 15 %
```

Grades: A ≥ 90, B ≥ 80, C ≥ 65, D ≥ 50, F < 50.

Action priorities are derived from `impact × ease`:
- **P0** — critical, ranking-blocking
- **P1** — high, material lift
- **P2** — medium
- **P3** — low / polish

## Files

```
index.html                              — single-page app shell
assets/css/styles.css                   — professional dark dashboard styling
assets/js/analyzer.js                   — SEO signal extraction + scoring engine
assets/js/competitors.js                — competitor auto-discovery (DuckDuckGo)
assets/js/renderer.js                   — charts, scorecards, tables
assets/js/email.js                      — EmailJS dispatch
assets/js/scheduler.js                  — browser-side scheduling
assets/js/app.js                        — controller / wiring
scripts/run-audit.js                    — headless runner for GitHub Actions
scripts/send-email.js                   — SMTP delivery for GitHub Actions
.github/workflows/scheduled-audit.yml   — true server-side cron
```

## Configuration

Open **Settings** in the app to add:

- **PageSpeed Insights API key** (optional — public quota works for low volume)
- **EmailJS** public key / service ID / template ID (for sending reports from the browser)
- **Branding** — company name + report footer

EmailJS template must accept the variables: `to_email`, `subject`, `message`, `from_name`.

## Scheduled audits via GitHub Actions

For true cron (runs even when your browser is closed):

1. Edit `.github/workflows/scheduled-audit.yml` and set `TARGET_URL` + `COMPETITORS`.
2. Add repo secrets: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_TO`. Optionally `PSI_KEY`.
3. The default cron runs Monday 09:00 UTC; adjust the `cron` line.

Reports are also uploaded as workflow artifacts for 90 days.

## CORS

Browser fetches go through one of three free CORS proxies (selectable in *Advanced options*):

- `allorigins.win` (default)
- `corsproxy.io`
- `codetabs.com`

If one is rate-limited or down, switch to another.

## Limitations

- True backlink graphs require a commercial API (Ahrefs / Majestic / Moz). SERPSCOPE estimates off-page health using public signals — solid for relative comparison and trend tracking, not for absolute domain rating.
- PSI is rate-limited without an API key (25k/day public quota across all IPs).
- Some sites block proxied fetches via referrer checks or Cloudflare challenges.

## License

MIT.
