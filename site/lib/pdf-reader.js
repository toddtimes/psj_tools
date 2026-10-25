/* Shared PDF text reader for the tools, built on the self-hosted pdf.js.
   pdf.js loads in the background as soon as the page opens, and every read waits for it, so a
   report dropped early is read as soon as the reader is ready rather than failing.
   Each read is a completely fresh load: the document and its worker are destroyed afterwards,
   so no report data stays in memory and repeated loads don't pile up. */
var PdfReader = (function () {
  'use strict';

  var base = document.currentScript.src;
  var LIB_URL = new URL('../vendor/pdfjs/pdf.min.mjs', base).href;
  var WORKER_URL = new URL('../vendor/pdfjs/pdf.worker.min.mjs', base).href;

  /* pdf.js 6 calls these without fallbacks; they set the minimum browser versions listed on the index page. */
  var supported = typeof Promise.try === 'function' &&
    typeof Promise.withResolvers === 'function' &&
    typeof Uint8Array.prototype.toHex === 'function';

  var TOO_OLD = 'This browser is too old to read the PDF. Update it, or use a current version of Chrome, Edge, Firefox or Safari.';
  var NOT_LOADED = 'The PDF reader could not be loaded. Reload the page and try again.';

  var loading = null;
  function load() {
    if (!supported) return Promise.reject(new Error(TOO_OLD));
    if (!loading) {
      loading = import(LIB_URL).then(function (lib) {
        lib.GlobalWorkerOptions.workerSrc = WORKER_URL;
        return lib;
      }, function () {
        loading = null; /* let the next read try again */
        throw new Error(NOT_LOADED);
      });
    }
    return loading;
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
    } finally {
      await task.destroy();
    }
  }

  if (supported) load().catch(function () { /* reported when a file is read */ });

  return { readPages: readPages, supported: supported };
})();
