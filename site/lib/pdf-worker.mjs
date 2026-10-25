/* pdf.js worker entry: install the fallbacks, then start the real worker. Imports run in this order. */
import './pdf-polyfills.mjs';
import '../vendor/pdfjs/pdf.worker.min.mjs';
