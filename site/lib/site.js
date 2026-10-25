/* Helpers shared by every tool page. Load before the tool's own script. */
var Site = (function () {
  'use strict';

  /* Escape text for HTML. Everything read from a PDF is untrusted and must go through this before innerHTML. */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  /* Settings saved in this browser. Reads fall back when storage is blocked or holds something unreadable. */
  var store = {
    get: function (key, fallback) { try { var v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set: function (key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ } }
  };

  /* Say up front when the browser can't read PDFs, rather than after a file is dropped. */
  document.addEventListener('DOMContentLoaded', function () {
    var reader = window.PdfReader;
    if (!reader || reader.supported) return;
    var main = document.querySelector('main, .wrap');
    if (!main) return;
    var p = document.createElement('p');
    p.className = 'browser-warning';
    p.setAttribute('role', 'alert');
    p.textContent = reader.TOO_OLD;
    main.prepend(p);
  });

  return { esc: esc, store: store };
})();
