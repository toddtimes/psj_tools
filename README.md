# Post San Juan Tools

Small browser tools for shipping and mailbox stores that run PostalMate. Each one reads a report exported from PostalMate as a PDF and does the tedious part for you. They're live at **[tools.postsanjuan.com](https://tools.postsanjuan.com)**.

| Tool | Reads | Gives you |
|---|---|---|
| CMRA Mailbox Counts | CMRA Quarterly Report | Boxes rented, added and closed for the quarter, with box-by-box lists |
| Profit and Tax Totals | Profit Report + Sales Tax Report | Retail and services gross profit and total taxable sales, less any monthly base costs you enter |
| Mailbox Name Labels | Mailnames Report | A printable PDF of box name labels, on 8-per-sheet Letter stock or Avery 5164 |

**Your reports never leave your computer.** The PDFs are read in your browser. Nothing is uploaded, there is no server or account, and the site's security policy blocks the pages from making network requests at all. The only things saved are your settings, such as category lists and base costs, and they stay in your own browser.

The tools are provided free and as-is, with no warranty. Always check the results against the original reports before relying on them for USPS, tax or other filings.

## Browser support

The pages need a current browser: Chrome or Edge 140+, Firefox 134+, or Safari 18.2+ (iPhone and iPad on iOS 18.2+). Older browsers can open the pages but can't read the PDFs, and the tools say so.

## Problems and suggestions

If a tool misreads a report, often because PostalMate changed a report's layout, please [open an issue](https://github.com/toddtimes/psj_tools/issues). Describe what you expected and what you got. **Don't attach a real report.** They contain customer names and addresses.

## How it's built

Plain HTML, CSS and JavaScript with no build step and no framework. Everything that gets published is in `site/`:

```
site/
  index.html, <tool>.html     one page per tool
  css/<tool>.css, css/base.css
  js/<tool>.js                each tool's code
  lib/site.js                 shared helpers: HTML escaping, saved settings, old-browser warning
  lib/pdf-reader.js           shared PDF reader built on pdf.js
  lib/pdf-worker.mjs, lib/pdf-polyfills.mjs   pdf.js worker entry and fallbacks for newer built-ins
  vendor/                     pdf.js, jsPDF and fonts, self-hosted (see vendor/README.md)
  thumbs/                     index page screenshots
  _headers                    security headers, including the Content-Security-Policy
scripts/check-site.mjs        site-specific lint checks
```

Cloudflare deploys `site/` from the `main` branch. It runs `npm ci && npm run lint` first, and a failing lint stops the deploy. GitHub Actions runs the same lint on every push and pull request.

Pages sends every file with `Cache-Control: max-age=0, must-revalidate`, so browsers check for a new version on each visit. The zone's **Browser Cache TTL** (Cloudflare dashboard → Caching → Configuration) must be set to **Respect Existing Headers**. At its default of four hours Cloudflare rewrites that header for scripts and styles, and a visitor who loaded the site before a deploy runs the new page with the old script for up to four hours. A `_headers` rule can't fix this, because the zone setting overrides it too.

### Rules that must not break

These protect the "nothing leaves your computer" promise. `npm run lint` enforces most of them.

1. **Load nothing from other sites.** No CDN scripts, Google Fonts, analytics or embeds. Copy third-party code into `site/vendor/` instead.
2. **No inline scripts, styles, `style=""` attributes or `onclick=` handlers**, including in markup built by JavaScript. The CSP blocks them, and they would fail silently in production.
3. **Escape everything read from a PDF** before putting it into HTML, using `Site.esc()` from `lib/site.js`. Report text is untrusted input.
4. **Never commit report files.** PDFs, CSVs and spreadsheets are git-ignored and rejected by lint, because anything in `site/` is public.
5. **Check what was read against the report's own totals** and warn when they don't match. That's how a PostalMate layout change gets noticed instead of producing wrong numbers.
6. **Keep reading in the browser.** Don't add a backend, uploads or `fetch` calls. The CSP's `connect-src 'none'` will block them anyway.

### Running it locally

The pages must be served over HTTP. Opening the files directly (`file://`) breaks the PDF reader.

```sh
npm ci              # once, for the linters
npm run lint        # HTML, JavaScript and site checks
python3 -m http.server -d site 8000   # then open http://localhost:8000
```

The local server doesn't send the `_headers` security headers, so a CSP problem only shows up on Cloudflare (a preview deploy is the place to check). Lint catches the common cases.

### Adding a tool

1. Add `site/<tool>.html`, `site/js/<tool>.js` and `site/css/<tool>.css`, following an existing tool. Load `lib/pdf-reader.js` and `lib/site.js` before the tool's script, then call `PdfReader.readPages(file)`, which returns the text items on each page.
2. Link it from `site/index.html` with a thumbnail in `site/thumbs/` (a 1200×750 WebP). Lint fails if a tool page isn't linked.
3. Add the same disclaimer footer the other tools have.
4. Run `npm run lint` and try it with real reports locally. Keep those reports outside the repo.

### Updating pdf.js, jsPDF and fonts

See [`site/vendor/README.md`](site/vendor/README.md). Check every three months, and whenever a security advisory comes out. A pdf.js update can change the minimum browser versions above.

## License

[MIT](LICENSE). The libraries and fonts in `site/vendor/` keep their own licences, which are included next to them: pdf.js (Apache 2.0), jsPDF (MIT), and the fonts (SIL Open Font License).
