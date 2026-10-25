/* Shared PDF text reader for the tools, built on the self-hosted pdf.js.
   pdf.js loads in the background as soon as the page opens, and every read waits for it, so a
   report dropped early is read as soon as the reader is ready rather than failing.
   Each read is a completely fresh load: the document and its worker are destroyed afterwards,
   so no report data stays in memory and repeated loads don't pile up. */
var PdfReader = (function () {
  'use strict';

  var base = document.currentScript.src;
  var POLYFILLS_URL = new URL('pdf-polyfills.mjs', base).href;
  var LIB_URL = new URL('../vendor/pdfjs/pdf.min.mjs', base).href;
  var WORKER_URL = new URL('pdf-worker.mjs', base).href;

  /* pdf.js 6 calls these without fallbacks, and they are too involved to supply ourselves. Simpler
     missing built-ins are filled in by pdf-polyfills.mjs. See site/vendor/README.md. */
  var supported = typeof Promise.try === 'function' &&
    typeof Promise.withResolvers === 'function' &&
    typeof Uint8Array.prototype.toHex === 'function';

  var TOO_OLD = 'This browser is too old to read the PDFs. Update it, or use a current version of Chrome, Edge, Firefox or Safari.';
  var NOT_LOADED = 'The PDF reader could not be loaded. Check the connection and try again.';

  /* A failed module import is cached by URL for the life of the page, so each retry asks for a fresh URL. */
  var attempt = 0;
  var loading = null;
  function load() {
    if (!supported) return Promise.reject(new Error(TOO_OLD));
    if (!loading) {
      var q = attempt ? '?retry=' + attempt : '';
      attempt++;
      loading = import(POLYFILLS_URL + q)
        .then(function () { return import(LIB_URL + q); })
        .then(function (lib) {
          lib.GlobalWorkerOptions.workerSrc = WORKER_URL + q;
          return lib;
        }, function () {
          loading = null;
          throw new Error(NOT_LOADED);
        });
    }
    return loading;
  }

  /* pdf.js errors are written for developers; say what happened in terms of the report. */
  function plainError(e) {
    var name = e && e.name, msg = (e && e.message) || '';
    if (name === 'PasswordException') return new Error('This PDF is password-protected. Export the report again without a password.');
    if (name === 'InvalidPDFException') return new Error('This file is damaged or is not really a PDF. Export the report from PostalMate again.');
    if (/fake worker|dynamically imported module|importScripts|Failed to fetch/i.test(msg)) {
      loading = null; /* reload pdf.js and its worker from fresh URLs next time */
      return new Error(NOT_LOADED);
    }
    if (/is not a function|is not defined|is not a constructor/.test(msg)) return new Error(TOO_OLD + ' (' + msg + ')');
    return e instanceof Error ? e : new Error(msg || 'The PDF could not be read.');
  }

  /* Returns one array per page of text items: { str, x, y, w } in PDF points, origin bottom-left. */
  async function readPages(file) {
    var lib = await load();
    var task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    try {
      var doc = await task.promise;
      var pages = [];
      for (var p = 1; p <= doc.numPages; p++) {
        var page = await doc.getPage(p);
        var tc = await page.getTextContent();
        pages.push(tc.items.map(function (i) { return { str: i.str || '', x: i.transform[4], y: i.transform[5], w: i.width || 0 }; }));
        page.cleanup();
      }
      return pages;
    } catch (e) {
      throw plainError(e);
    } finally {
      await task.destroy();
    }
  }

  if (supported) load().catch(function () { /* reported when a file is read */ });

  return { readPages: readPages, supported: supported, TOO_OLD: TOO_OLD };
})();
