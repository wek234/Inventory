// Comportements de l'interface (aucun script en ligne : compatible CSP stricte).
(function () {
  'use strict';

  // Confirmation avant les actions destructrices : <form data-confirm="...">
  document.addEventListener('submit', function (e) {
    var f = e.target;
    var s = e.submitter;
    if (s && s.dataset && s.dataset.confirmSubmit) {
      if (!window.confirm(s.dataset.confirmSubmit)) e.preventDefault();
      return;
    }
    if (f && f.dataset && f.dataset.confirm && !window.confirm(f.dataset.confirm)) e.preventDefault();
  });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action]');
    if (!t) return;
    var a = t.dataset.action;
    if (a === 'menu') {
      document.body.classList.toggle('menu-open');
    } else if (a === 'theme') {
      var order = ['auto', 'light', 'dark'];
      var cur = document.documentElement.getAttribute('data-theme') || 'auto';
      var next = order[(order.indexOf(cur) + 1) % order.length];
      document.documentElement.setAttribute('data-theme', next);
      document.cookie = 'inv_theme=' + next + '; path=/; max-age=31536000; samesite=lax' + (location.protocol === 'https:' ? '; secure' : '');
      document.querySelectorAll('[data-theme-label]').forEach(function (el) {
        el.textContent = { auto: 'Thème : automatique', light: 'Thème : clair', dark: 'Thème : sombre' }[next];
      });
    } else if (a === 'remove-row') {
      e.preventDefault();
      var row = t.closest('.attr-row');
      if (row) row.remove();
    } else if (a === 'print') {
      // Mémorise l'impression (étiquettes « jamais imprimées »), puis ouvre la boîte d'impression.
      var ids = t.dataset.printedIds;
      var meta = document.querySelector('meta[name=csrf-token]');
      if (ids && meta && window.fetch) {
        fetch('/etiquettes/imprimees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': meta.content },
          body: 'ids=' + encodeURIComponent(ids),
          credentials: 'same-origin'
        }).catch(function () { /* l'impression reste possible */ });
      }
      window.print();
    } else if (a === 'check-all' || a === 'check-none') {
      document.querySelectorAll('input[data-row-include]').forEach(function (c) {
        c.checked = a === 'check-all';
        c.closest('tr').classList.toggle('excluded', !c.checked);
      });
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches && t.matches('input[data-row-include]')) t.closest('tr').classList.toggle('excluded', !t.checked);
    // Soumission automatique de certains formulaires (ex. bascule de disposition à l'import)
    if (t.matches && t.matches('[data-autosubmit]')) {
      var form = t.form;
      if (t.dataset.anchor && form.querySelector('input[name=anchor]')) form.querySelector('input[name=anchor]').value = t.dataset.anchor;
      var btn = form.querySelector('button[name=action][value=refresh]');
      if (btn && form.requestSubmit) form.requestSubmit(btn);
      else form.submit();
    }
  });


  // ---------- Liste des objets : lignes cliquables ----------
  document.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-href]');
    if (!tr) return;
    if (e.target.closest('a, button, input, select, textarea, label, td.sel')) return;
    if (window.getSelection && String(window.getSelection()).length) return; // sélection de texte en cours
    if (e.ctrlKey || e.metaKey) window.open(tr.dataset.href, '_blank');
    else window.location.href = tr.dataset.href;
  });
  document.addEventListener('auxclick', function (e) {
    var tr = e.target.closest('tr[data-href]');
    if (tr && e.button === 1 && !e.target.closest('a')) window.open(tr.dataset.href, '_blank');
  });

  // ---------- Sélection d'objets (étiquettes, CSV), conservée entre pages et filtres ----------
  var SEL_KEY = 'inv_selection';
  function getSel() {
    try { return JSON.parse(sessionStorage.getItem(SEL_KEY) || '[]'); } catch (err) { return []; }
  }
  function setSel(list) {
    try { sessionStorage.setItem(SEL_KEY, JSON.stringify(list)); } catch (err) { /* stockage indisponible */ }
    syncSel();
  }
  function syncSel() {
    var sel = getSel();
    var set = {};
    sel.forEach(function (id) { set[id] = true; });
    var boxes = document.querySelectorAll('input[data-select-id]');
    boxes.forEach(function (b) { b.checked = !!set[b.dataset.selectId]; });
    var all = document.querySelector('input[data-select-page]');
    if (all) all.checked = boxes.length > 0 && Array.prototype.every.call(boxes, function (b) { return b.checked; });
    var count = document.querySelector('[data-selection-count]');
    var clear = document.querySelector('[data-action=clear-selection]');
    if (count) { count.hidden = !sel.length; count.textContent = sel.length + (sel.length > 1 ? ' objets sélectionnés' : ' objet sélectionné'); }
    if (clear) clear.hidden = !sel.length;
    document.querySelectorAll('a[data-selection-link]').forEach(function (a) {
      if (!a.dataset.hrefAll) a.dataset.hrefAll = a.getAttribute('href');
      if (sel.length) {
        var sort = new URLSearchParams(window.location.search);
        var p = new URLSearchParams();
        p.set('ids', sel.join(','));
        if (sort.get('sort')) p.set('sort', sort.get('sort'));
        if (sort.get('dir')) p.set('dir', sort.get('dir'));
        a.setAttribute('href', a.dataset.selectionLink + '?' + p.toString());
        a.textContent = a.dataset.labelSel + ' (' + sel.length + ')';
        a.classList.add('btn-primary');
      } else {
        a.setAttribute('href', a.dataset.hrefAll);
        a.textContent = a.dataset.labelAll;
        a.classList.remove('btn-primary');
      }
    });
  }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('input[data-select-id]')) {
      var sel = getSel().filter(function (id) { return id !== t.dataset.selectId; });
      if (t.checked) sel.push(t.dataset.selectId);
      setSel(sel);
    } else if (t.matches('input[data-select-page]')) {
      var ids = Array.prototype.map.call(document.querySelectorAll('input[data-select-id]'), function (b) { return b.dataset.selectId; });
      var cur = getSel().filter(function (id) { return ids.indexOf(id) < 0; });
      setSel(t.checked ? cur.concat(ids) : cur);
    }
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-action=clear-selection]')) setSel([]);
  });
  document.body.addEventListener('htmx:afterSettle', function () {
    // Les liens de sélection sont recréés par HTMX : on oublie l'ancienne URL de référence.
    syncSel();
  });

  // ---------- Retour sur la liste : même position de défilement ----------
  var SCROLL_KEY = 'inv_scroll';
  if (window.location.pathname === '/objets') {
    try {
      var saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null');
      if (saved && saved.search === window.location.search) {
        window.scrollTo(0, saved.y);
        setTimeout(function () { window.scrollTo(0, saved.y); }, 50);
      }
    } catch (err) { /* rien */ }
    window.addEventListener('pagehide', function () {
      try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ search: window.location.search, y: window.scrollY })); } catch (err) { /* rien */ }
    });
  }
  syncSel();

  // Jeton CSRF ajouté aux requêtes HTMX
  document.body.addEventListener('htmx:configRequest', function (e) {
    var meta = document.querySelector('meta[name=csrf-token]');
    if (meta) e.detail.headers['X-CSRF-Token'] = meta.content;
  });
})();
