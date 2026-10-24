# Vendored libraries

Served from this site so no report data or visitor traffic touches a third-party CDN.
Check for updates and security advisories every 3 months.

| Library | Version | Files | Updated |
|---|---|---|---|
| pdfjs-dist (PDF reading) | 6.4.299 | `pdfjs/pdf.min.mjs`, `pdfjs/pdf.worker.min.mjs` | 2026-10-24 |
| jspdf (PDF labels) | 4.2.1 | `jspdf/jspdf.umd.min.js` | 2026-10-24 |
| @fontsource IBM Plex Sans / Mono / Sans Condensed, Barlow Semi Condensed, Public Sans | 5.3.0 | `fonts/` (latin + latin-ext woff2) | 2026-10-24 |

To update: `npm install pdfjs-dist@latest jspdf@latest` in a scratch folder, run `npm audit`, copy the files above over these, then load a real PostalMate PDF in each tool.
