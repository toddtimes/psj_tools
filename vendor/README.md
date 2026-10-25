# Vendored libraries

Served from this site so no report data or visitor traffic touches a third-party CDN.
Check for updates and security advisories every 3 months.

| Library | Version | Files | Updated |
|---|---|---|---|
| pdfjs-dist (PDF reading) | 6.4.299 | `pdfjs/pdf.min.mjs`, `pdfjs/pdf.worker.min.mjs` | 2026-10-24 |
| jspdf (PDF labels) | 4.2.1 | `jspdf/jspdf.umd.min.js` | 2026-10-24 |
| @fontsource IBM Plex Sans / Mono / Sans Condensed, Barlow Semi Condensed, Public Sans | 5.3.0 | `fonts/` (latin + latin-ext woff2) | 2026-10-24 |

pdf.js is the modern build, not the legacy one, so it needs current browsers. Text reading calls `Promise.try`, `Promise.withResolvers` and `Uint8Array.prototype.toHex` without fallbacks, which sets the minimums listed on the index page (Chrome/Edge 140, Firefox 134, Safari 18.2). `lib/pdf-reader.js` checks for those three and tells older browsers so plainly. A pdf.js update can raise the floor, so re-check which new built-ins it calls and update both places.

To update: `npm install pdfjs-dist@latest jspdf@latest` in a scratch folder, run `npm audit`, copy the files above over these, run `npm run lint`, then load a real PostalMate PDF in each tool.
