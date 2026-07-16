/**
 * Content System — motyw marki, tematy, proxy uploadu
 */
(function (global) {
  "use strict";

  var BRAND_KEY = "content-system-brand";
  var TOPICS_KEY = "content-system-topics";
  var UPLOAD_PROXY_KEY = "content-system-upload-proxy";

  var DEFAULT_TOPICS = [
    "IT / AWS",
    "Rekrutacja",
    "Case study",
    "Edukacja",
    "Ogłoszenie",
    "News tygodnia"
  ];

  var DEFAULT_BRAND = {
    logoPath: "media/brand/logo.png",
    primaryColor: "#6366f1",
    accentColor: "#8b5cf6",
    motifNote: "Indygo + fiolet · geometria · minimalistyczny layout"
  };

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, "&#39;");
  }

  function getBrand() {
    try {
      var raw = localStorage.getItem(BRAND_KEY);
      return raw ? Object.assign({}, DEFAULT_BRAND, JSON.parse(raw)) : Object.assign({}, DEFAULT_BRAND);
    } catch (e) {
      return Object.assign({}, DEFAULT_BRAND);
    }
  }

  function saveBrand(data) {
    localStorage.setItem(BRAND_KEY, JSON.stringify(Object.assign({}, DEFAULT_BRAND, data)));
  }

  function getTopics() {
    try {
      var raw = localStorage.getItem(TOPICS_KEY);
      if (raw) {
        var list = JSON.parse(raw);
        return Array.isArray(list) && list.length ? list : DEFAULT_TOPICS.slice();
      }
    } catch (e) { /* ignore */ }
    return DEFAULT_TOPICS.slice();
  }

  function saveTopics(list) {
    localStorage.setItem(TOPICS_KEY, JSON.stringify(list));
  }

  function defaultUploadProxy() {
    if (global.location && global.location.protocol !== "file:") {
      return global.location.origin.replace(/\/$/, "");
    }
    return "http://localhost:8787";
  }

  function getUploadProxy() {
    var stored = (localStorage.getItem(UPLOAD_PROXY_KEY) || "").trim();
    var fallback = defaultUploadProxy();
    // Stare lokalne ustawienie z dev nie może nadpisywać produkcji
    if (stored && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(stored)) {
      if (fallback.indexOf("localhost") === -1 && fallback.indexOf("127.0.0.1") === -1) {
        localStorage.setItem(UPLOAD_PROXY_KEY, fallback);
        return fallback;
      }
    }
    if (stored) return stored;
    return fallback;
  }

  function saveUploadProxy(url) {
    var next = (url || "").trim() || defaultUploadProxy();
    localStorage.setItem(UPLOAD_PROXY_KEY, next);
  }

  function renderBrandHTML() {
    var b = getBrand();
    var topics = getTopics();
    var topicTags = topics.map(function (t) {
      return '<span class="brand-topic-tag">' + escapeHtml(t) + "</span>";
    }).join("");

    var logoPreview = b.logoPath
      ? '<img src="' + escapeAttr(b.logoPath) + '" alt="Logo" class="brand-logo-preview">'
      : '<div class="brand-logo-empty">Brak logo · wgraj do <code>media/brand/</code></div>';

    return (
      '<div class="brand-page">' +
        '<div class="brand-intro">' +
          "<strong>Motyw marki</strong> — logotyp i kolory jako odniesienie przy tworzeniu własnych grafik. " +
          "Panel nie generuje grafik — tylko trzyma wytyczne." +
        "</div>" +
        '<div class="brand-grid">' +
          '<section class="brand-card">' +
            "<h2 class=\"brand-card-title\">Logotyp</h2>" +
            logoPreview +
            '<div class="brand-field">' +
              '<label class="brand-label" for="brand-logo">Ścieżka logo</label>' +
              '<input class="brand-input" id="brand-logo" value="' + escapeAttr(b.logoPath) + '" placeholder="media/brand/logo.png">' +
            "</div>" +
            '<div class="brand-swatches">' +
              '<span class="brand-swatch" style="background:' + escapeAttr(b.primaryColor) + '" title="Primary"></span>' +
              '<span class="brand-swatch" style="background:' + escapeAttr(b.accentColor) + '" title="Accent"></span>' +
            "</div>" +
            '<div class="brand-field">' +
              '<label class="brand-label" for="brand-primary">Kolor główny</label>' +
              '<input class="brand-input" id="brand-primary" value="' + escapeAttr(b.primaryColor) + '">' +
            "</div>" +
            '<div class="brand-field">' +
              '<label class="brand-label" for="brand-accent">Kolor akcentu</label>' +
              '<input class="brand-input" id="brand-accent" value="' + escapeAttr(b.accentColor) + '">' +
            "</div>" +
            '<div class="brand-field">' +
              '<label class="brand-label" for="brand-motif">Motyw / notatka dla grafika</label>' +
              '<textarea class="brand-textarea" id="brand-motif" rows="3">' + escapeHtml(b.motifNote) + "</textarea>" +
            "</div>" +
          "</section>" +
          '<section class="brand-card">' +
            "<h2 class=\"brand-card-title\">Tematy postów</h2>" +
            '<p class="brand-card-desc">Używane w formularzu posta i filtrach panelu.</p>' +
            '<div class="brand-topics-list" id="brand-topics-list">' + topicTags + "</div>" +
            '<div class="brand-field">' +
              '<label class="brand-label" for="brand-topic-new">Dodaj temat</label>' +
              '<div class="brand-topic-add">' +
                '<input class="brand-input" id="brand-topic-new" placeholder="np. DevOps">' +
                '<button type="button" class="gen-btn" id="brand-topic-add">Dodaj</button>' +
              "</div>" +
            "</div>" +
            '<div class="brand-field">' +
              '<label class="brand-label" for="brand-upload-proxy">URL serwera uploadu (opcjonalnie)</label>' +
              '<input class="brand-input" id="brand-upload-proxy" value="' + escapeAttr(getUploadProxy()) + '" placeholder="http://localhost:8787">' +
              '<p class="brand-hint">Do wgrywania JPG/PNG/WEBP i tłumaczeń Bedrock: <code>cd Panel && npm install && npm start</code></p>' +
              '<p class="brand-hint">AWS credentials: plik <code>Panel/.env</code> (skopiuj z <code>.env.example</code>) lub <code>aws configure</code>. Kluczy nie wpisuj w panelu ani na czacie.</p>' +
            "</div>" +
          "</section>" +
        "</div>" +
        '<button type="button" class="gen-btn gen-btn-primary" id="brand-save">Zapisz motyw marki</button>' +
        '<p class="brand-msg" id="brand-msg"></p>' +
      "</div>"
    );
  }

  function renderEditorBrandHint() {
    var b = getBrand();
    var logo = b.logoPath
      ? '<img src="' + escapeAttr(b.logoPath) + '" alt="" class="editor-brand-logo">'
      : "";
    return (
      '<div class="editor-brand-hint">' +
        '<div class="editor-label">Motyw marki</div>' +
        logo +
        '<div class="editor-brand-colors">' +
          '<span class="editor-brand-dot" style="background:' + escapeAttr(b.primaryColor) + '"></span>' +
          '<span class="editor-brand-dot" style="background:' + escapeAttr(b.accentColor) + '"></span>' +
        "</div>" +
        '<p class="editor-brand-note">' + escapeHtml(b.motifNote) + "</p>" +
        '<p class="editor-brand-path"><code>' + escapeHtml(b.logoPath) + "</code></p>" +
      "</div>"
    );
  }

  function renderTopicOptions(selected) {
    var opts = '<option value="">— wybierz temat —</option>';
    getTopics().forEach(function (t) {
      var sel = t === selected ? " selected" : "";
      opts += '<option value="' + escapeAttr(t) + '"' + sel + ">" + escapeHtml(t) + "</option>";
    });
    return opts;
  }

  function bindBrandEvents(showToast) {
    var saveBtn = document.getElementById("brand-save");
    var addBtn = document.getElementById("brand-topic-add");
    var msg = document.getElementById("brand-msg");
    var topics = getTopics();

    function renderTopicTags() {
      var list = document.getElementById("brand-topics-list");
      if (!list) return;
      list.innerHTML = topics.map(function (t, i) {
        return '<span class="brand-topic-tag">' + escapeHtml(t) +
          ' <button type="button" class="brand-topic-remove" data-i="' + i + '" aria-label="Usuń">×</button></span>';
      }).join("");
      list.querySelectorAll(".brand-topic-remove").forEach(function (btn) {
        btn.addEventListener("click", function () {
          topics.splice(parseInt(btn.dataset.i, 10), 1);
          saveTopics(topics);
          renderTopicTags();
        });
      });
    }

    if (addBtn) {
      addBtn.addEventListener("click", function () {
        var input = document.getElementById("brand-topic-new");
        var val = (input.value || "").trim();
        if (!val) return;
        if (topics.indexOf(val) === -1) topics.push(val);
        saveTopics(topics);
        input.value = "";
        renderTopicTags();
      });
    }

    renderTopicTags();

    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        saveBrand({
          logoPath: (document.getElementById("brand-logo") || {}).value || DEFAULT_BRAND.logoPath,
          primaryColor: (document.getElementById("brand-primary") || {}).value || DEFAULT_BRAND.primaryColor,
          accentColor: (document.getElementById("brand-accent") || {}).value || DEFAULT_BRAND.accentColor,
          motifNote: (document.getElementById("brand-motif") || {}).value || DEFAULT_BRAND.motifNote
        });
        saveUploadProxy((document.getElementById("brand-upload-proxy") || {}).value);
        if (msg) {
          msg.textContent = "Zapisano motyw marki i tematy.";
          msg.className = "brand-msg ok";
        }
        if (showToast) showToast("Motyw marki zapisany");
      });
    }

    var logoInput = document.getElementById("brand-logo");
    if (logoInput) {
      logoInput.addEventListener("input", function () {
        var preview = document.querySelector(".brand-logo-preview, .brand-logo-empty");
        if (!preview) return;
        if (logoInput.value.trim()) {
          preview.outerHTML = '<img src="' + escapeAttr(logoInput.value.trim()) + '" alt="Logo" class="brand-logo-preview">';
        }
      });
    }
  }

  global.BrandKit = {
    getBrand: getBrand,
    getTopics: getTopics,
    getUploadProxy: getUploadProxy,
    renderBrandHTML: renderBrandHTML,
    renderEditorBrandHint: renderEditorBrandHint,
    renderTopicOptions: renderTopicOptions,
    bindBrandEvents: bindBrandEvents
  };
})(window);
