# Vendored libraries

Served from this site so no report data or visitor traffic touches a third-party CDN.
Check for updates and security advisories every 3 months.

| Library | Version | Files | Updated |
|---|---|---|---|
| pdfjs-dist (PDF reading) | 6.4.299 | `pdfjs/pdf.min.mjs`, `pdfjs/pdf.worker.min.mjs` | 2026-10-24 |
| jspdf (PDF labels) | 4.2.1 | `jspdf/jspdf.umd.min.js` | 2026-10-24 |
| @fontsource IBM Plex Sans / Mono / Sans Condensed, Barlow Semi Condensed, Public Sans | 5.3.0 | `fonts/` (latin + latin-ext woff2) | 2026-10-24 |

pdf.js is the modern build, not the legacy one, so it needs current browsers. It calls new JavaScript built-ins without fallbacks. Two places handle that:

- `lib/pdf-reader.js` checks for `Promise.try`, `Promise.withResolvers` and `Uint8Array.prototype.toHex`. Without them it tells the visitor their browser is too old, both when the page opens and when a file is dropped. Those three set the minimum versions stated on the index page and in the top-level README (Chrome/Edge 140, Firefox 134, Safari 18.2). Keep all three places in step.
- `lib/pdf-polyfills.mjs` supplies exact fallbacks for simpler built-ins (currently Map/WeakMap `getOrInsert` and `getOrInsertComputed`), on the page and in the worker. The worker loads through `lib/pdf-worker.mjs` so the fallbacks run before pdf.js does.

After a pdf.js update, check the [pdf.js release notes](https://github.com/mozilla/pdf.js/releases) for changes to the supported browsers. Then test in the oldest browser versions stated, or remove the newest built-ins in a current browser and read a real report. Either add a fallback or raise the stated minimums.

jsPDF (used only to make the label PDF) supports far older browsers than pdf.js, so it doesn't affect the minimums.

Where the files come from: `pdfjs-dist/build/pdf.min.mjs` and `pdfjs-dist/build/pdf.worker.min.mjs`; `jspdf/dist/jspdf.umd.min.js`; fonts from each `@fontsource/<family>` package's `files/`, latin and latin-ext subsets only, woff2 only, with `fonts/fonts.css` built from the matching blocks in each package's `<weight>.css`. The weights in use are IBM Plex Sans 400/500/600, IBM Plex Mono 400/500/600, IBM Plex Sans Condensed 500/600, Barlow Semi Condensed 600/700 and Public Sans 400/500/600/700.

To update: `npm install pdfjs-dist@latest jspdf@latest` in a scratch folder, run `npm audit`, copy the files above over these, run `npm run lint`, then load a real PostalMate PDF in each tool.
