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
    // Format d'étiquette : affiche la taille personnalisée, applique sinon directement.
    if (t.matches && t.matches('[data-autosubmit-get]')) {
      var custom = t.form.querySelector('[data-custom-size]');
      if (custom) custom.hidden = t.value !== 'perso';
      if (t.value !== 'perso') t.form.submit();
    }
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
      if (a.hasAttribute('data-selection-only')) a.hidden = !sel.length;
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
        if (a.dataset.labelAll) a.textContent = a.dataset.labelAll;
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


  // ---------- Clés d'accès (passkeys) ----------
  function csrfHeader() {
    var m = document.querySelector('meta[name=csrf-token]');
    return m ? m.content : '';
  }
  function postJSON(url, data) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfHeader() },
      body: JSON.stringify(data || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.erreur || 'Erreur ' + r.status); return j; });
    });
  }
  function passkeyError(msg) {
    var el = document.querySelector('[data-passkey-error]');
    if (el) { el.hidden = !msg; el.textContent = msg || ''; }
  }
  function webauthnMessage(err) {
    if (err && err.name === 'NotAllowedError') return 'Opération annulée ou délai dépassé.';
    if (err && err.name === 'InvalidStateError') return 'Cette clé est déjà enregistrée.';
    return (err && err.message) || 'Erreur inattendue.';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action=passkey-register], [data-action=passkey-login]');
    if (!t) return;
    var W = window.SimpleWebAuthnBrowser;
    if (!W || !window.PublicKeyCredential) { passkeyError('Ce navigateur ne prend pas en charge les clés d’accès.'); return; }
    passkeyError('');
    t.disabled = true;
    if (t.dataset.action === 'passkey-register') {
      var nameInput = document.querySelector('[data-passkey-name]');
      postJSON('/compte/passkeys/options').then(function (opts) {
        return W.startRegistration({ optionsJSON: opts });
      }).then(function (resp) {
        return postJSON('/compte/passkeys/verifier', { response: resp, name: nameInput ? nameInput.value : '' });
      }).then(function () {
        window.location.href = '/compte#passkeys';
        window.location.reload();
      }).catch(function (err) { passkeyError(webauthnMessage(err)); t.disabled = false; });
    } else {
      postJSON('/login/passkey/options').then(function (opts) {
        return W.startAuthentication({ optionsJSON: opts });
      }).then(function (resp) {
        return postJSON('/login/passkey/verifier', { response: resp });
      }).then(function (r) {
        window.location.href = r.next || '/';
      }).catch(function (err) { passkeyError(webauthnMessage(err)); t.disabled = false; });
    }
  });

  // ---------- Recherche rapide (Ctrl+K) ----------
  var qs = null;
  function closeQuick() { if (qs) { qs.root.remove(); qs = null; } }
  function renderQuick(items) {
    qs.items = items;
    qs.active = items.length ? 0 : -1;
    qs.list.innerHTML = '';
    if (!items.length) {
      var li = document.createElement('li');
      li.className = 'qs-empty';
      li.textContent = qs.input.value.trim() ? 'Aucun résultat' : 'Tapez pour chercher un objet, un emplacement, une catégorie, une personne ou une page';
      qs.list.appendChild(li);
      return;
    }
    items.forEach(function (it, i) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = it.href;
      a.className = 'qs-item' + (i === 0 ? ' active' : '');
      var type = document.createElement('span'); type.className = 'qs-type'; type.textContent = it.type;
      var label = document.createElement('span'); label.className = 'qs-label'; label.textContent = it.label;
      a.appendChild(type); a.appendChild(label);
      if (it.sub) { var sub = document.createElement('span'); sub.className = 'qs-sub'; sub.textContent = it.sub; a.appendChild(sub); }
      li.appendChild(a);
      qs.list.appendChild(li);
    });
  }
  function moveQuick(d) {
    if (!qs || !qs.items.length) return;
    var links = qs.list.querySelectorAll('.qs-item');
    links[qs.active].classList.remove('active');
    qs.active = (qs.active + d + links.length) % links.length;
    links[qs.active].classList.add('active');
    links[qs.active].scrollIntoView({ block: 'nearest' });
  }
  function openQuick() {
    if (qs) return;
    var root = document.createElement('div');
    root.className = 'qs-backdrop';
    root.innerHTML = '<div class="qs-box" role="dialog" aria-modal="true" aria-label="Recherche rapide"><input class="qs-input" type="search" placeholder="Rechercher…" aria-label="Rechercher" autocomplete="off"><ul class="qs-list" role="listbox"></ul><div class="qs-help">↑ ↓ pour naviguer · Entrée pour ouvrir · Échap pour fermer</div></div>';
    document.body.appendChild(root);
    qs = { root: root, input: root.querySelector('.qs-input'), list: root.querySelector('.qs-list'), items: [], active: -1, timer: null, seq: 0 };
    renderQuick([]);
    qs.input.focus();
    root.addEventListener('mousedown', function (e) { if (e.target === root) closeQuick(); });
    qs.input.addEventListener('input', function () {
      clearTimeout(qs.timer);
      var q = qs.input.value.trim();
      var seq = ++qs.seq;
      qs.timer = setTimeout(function () {
        if (!q) { renderQuick([]); return; }
        fetch('/recherche.json?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (qs && seq === qs.seq) renderQuick(j.resultats || []); })
          .catch(function () {});
      }, 150);
    });
    qs.input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveQuick(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveQuick(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (qs.items[qs.active]) window.location.href = qs.items[qs.active].href; }
      else if (e.key === 'Escape') { closeQuick(); }
    });
  }
  if (document.body.hasAttribute('data-app')) {
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (qs) closeQuick(); else openQuick(); }
      else if (e.key === 'Escape' && qs) closeQuick();
    });
    document.addEventListener('click', function (e) { if (e.target.closest('[data-action=quick-search]')) openQuick(); });
  }


  // ---------- Mode rangement : scanner QR ----------
  var scanRoot = document.querySelector('[data-scan]');
  if (scanRoot) {
    var target = null; // { id, chemin }
    var lastCode = '', lastAt = 0, moved = 0, stream = null, busy = false;
    var video = scanRoot.querySelector('[data-scan-video]');
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var targetEl = scanRoot.querySelector('[data-scan-target]');
    var logEl = scanRoot.querySelector('[data-scan-log]');
    var countEl = scanRoot.querySelector('[data-scan-count]');
    var selectEl = scanRoot.querySelector('[data-scan-select]');
    var hintEl = scanRoot.querySelector('[data-scan-hint]');
    function setTarget(t) {
      target = t;
      targetEl.innerHTML = '';
      var strong = document.createElement('strong'); strong.textContent = t.chemin;
      targetEl.appendChild(document.createTextNode('Ranger dans : ')); targetEl.appendChild(strong);
      targetEl.classList.add('ok');
      selectEl.value = String(t.id);
    }
    function log(text, kind) {
      if (moved === 0 && logEl.querySelector('.muted')) logEl.innerHTML = '';
      var li = document.createElement('li');
      li.className = 'scan-' + (kind || 'ok');
      li.textContent = text;
      logEl.insertBefore(li, logEl.firstChild);
    }
    function beep(ok) {
      try {
        var ac = new (window.AudioContext || window.webkitAudioContext)();
        var o = ac.createOscillator(); o.frequency.value = ok ? 880 : 220; o.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.12);
      } catch (e) { /* son indisponible */ }
      if (navigator.vibrate) navigator.vibrate(ok ? 60 : [60, 40, 60]);
    }
    function handle(code) {
      code = String(code || '').trim();
      if (!code || busy) return;
      var now = Date.now();
      if (code === lastCode && now - lastAt < 2500) return;
      lastCode = code; lastAt = now;
      // « E12 » (étiquette d'emplacement) -> adresse d'emplacement
      var m = /^E(\d+)$/i.exec(code);
      if (m) code = '/emplacements/' + m[1];
      busy = true;
      postJSON('/rangement/resoudre', { code: code }).then(function (r) {
        if (r.type === 'emplacement') { setTarget({ id: r.id, chemin: r.chemin }); beep(true); return; }
        if (!target) { log('« ' + r.nom + ' » : scannez d’abord un emplacement.', 'warn'); beep(false); return; }
        return postJSON('/rangement/deplacer', { item_id: r.id, location_id: target.id }).then(function (d) {
          moved++; countEl.textContent = String(moved);
          log(d.deja ? '« ' + d.nom + ' » était déjà dans ' + d.chemin : '« ' + d.nom + ' » → ' + d.chemin + (d.avant ? ' (venait de ' + d.avant + ')' : ''), d.deja ? 'info' : 'ok');
          beep(true);
        });
      }).catch(function (err) { log(err.message, 'warn'); beep(false); }).then(function () { busy = false; });
    }
    function tick() {
      if (!stream) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA && window.jsQR) {
        var w = video.videoWidth, h = video.videoHeight;
        var scale = Math.min(1, 640 / Math.max(w, h));
        canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (res && res.data) handle(res.data);
      }
      setTimeout(function () { requestAnimationFrame(tick); }, 120);
    }
    scanRoot.querySelector('[data-action=scan-start]').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; scanRoot.querySelector('[data-scan-view]').hidden = true; btn.textContent = 'Démarrer la caméra'; return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { hintEl.textContent = 'Caméra indisponible : connexion non sécurisée (HTTPS requis) ou navigateur non compatible.'; return; }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(function (s) {
        stream = s; video.srcObject = s; video.play();
        scanRoot.querySelector('[data-scan-view]').hidden = false;
        btn.textContent = 'Arrêter la caméra';
        hintEl.textContent = 'Visez une étiquette QR.';
        tick();
      }).catch(function () { hintEl.textContent = 'Accès à la caméra refusé ou impossible.'; });
    });
    scanRoot.querySelector('[data-scan-manual]').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = e.currentTarget.querySelector('input');
      lastCode = ''; handle(input.value); input.value = ''; input.focus();
    });
    selectEl.addEventListener('change', function () {
      var o = selectEl.options[selectEl.selectedIndex];
      if (o && o.value) setTarget({ id: Number(o.value), chemin: o.dataset.path });
    });
  }

  // ---------- Groupe « Outils » du menu : ouvert ou replié, retenu dans ce navigateur ----------
  document.querySelectorAll('details[data-nav-group]').forEach(function (d) {
    var key = 'inv_nav_' + d.dataset.navGroup;
    if (!d.hasAttribute('data-forced')) {
      try { if (localStorage.getItem(key) === '1') d.open = true; } catch (e) {}
    }
    d.addEventListener('toggle', function () {
      try { localStorage.setItem(key, d.open ? '1' : '0'); } catch (e) {}
    });
  });

  // ---------- Page catégorie : nouvelles lignes de caractéristiques ----------
  var addDef = document.querySelector('[data-action=add-def]');
  var newDefIndex = 100 + document.querySelectorAll('#new-defs [data-def-row]').length;
  if (addDef) {
    addDef.addEventListener('click', function () {
      var tpl = document.getElementById('def-template');
      var box = document.getElementById('new-defs');
      if (!tpl || !box) return;
      newDefIndex += 1;
      var holder = document.createElement('div');
      holder.innerHTML = tpl.innerHTML.replace(/__N__/g, String(newDefIndex));
      var node = holder.firstElementChild;
      var empty = document.querySelector('[data-empty-defs]');
      if (empty) empty.remove();
      box.appendChild(node);
      var first = node.querySelector('input[type=text]');
      if (first) first.focus();
      markDirty();
    });
  }
  document.addEventListener('click', function (e) {
    var rm = e.target.closest('[data-action=remove-new-def]');
    if (rm) rm.closest('.def-row').remove();
  });
  // Le type choisi affiche le bon champ (unité pour un nombre, options pour une liste).
  document.addEventListener('change', function (e) {
    var sel = e.target.closest('select[data-def-type]');
    if (sel) sel.closest('[data-def-row]').dataset.type = sel.value;
  });
  // Avertit avant de quitter la page avec des modifications non enregistrées.
  var dirtyForm = document.querySelector('form[data-dirty-check]');
  var dirty = false;
  function markDirty() { dirty = true; }
  if (dirtyForm) {
    dirtyForm.addEventListener('input', markDirty);
    dirtyForm.addEventListener('change', markDirty);
    dirtyForm.addEventListener('submit', function () { dirty = false; });
    // Suppression immédiate d'une caractéristique : prévient si d'autres modifications seraient perdues.
    document.addEventListener('submit', function (e) {
      if (e.target.matches('form[data-def-delete]') && !e.defaultPrevented) dirty = false;
    });
    document.querySelectorAll('form[data-def-delete]').forEach(function (f) {
      var base = f.dataset.confirm;
      document.addEventListener('input', function () { if (dirty) f.dataset.confirm = base + '\n\nLes autres modifications non enregistrées de la page seront perdues.'; });
      document.addEventListener('change', function () { if (dirty) f.dataset.confirm = base + '\n\nLes autres modifications non enregistrées de la page seront perdues.'; });
    });
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  // PWA : enregistrement du service worker (fichiers statiques et page hors ligne uniquement).
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }

  // Jeton CSRF ajouté aux requêtes HTMX
  document.body.addEventListener('htmx:configRequest', function (e) {
    var meta = document.querySelector('meta[name=csrf-token]');
    if (meta) e.detail.headers['X-CSRF-Token'] = meta.content;
  });
})();
