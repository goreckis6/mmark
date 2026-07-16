/**
 * Content System — specyfikacje formatów graficznych social media
 */
(function (global) {
  "use strict";

  var FILE_TYPES = "JPG, PNG, WEBP";
  var MAX_SIZE = "do 8 MB";

  var PLATFORMS = {
    ig: {
      name: "Instagram",
      color: "#E1306C",
      formats: [
        { label: "Post pionowy (zalecany)", size: "1080×1350", ratio: "4:5", placement: "Feed", note: "Najlepszy zasięg w feedzie" },
        { label: "Post kwadratowy", size: "1080×1080", ratio: "1:1", placement: "Feed, karuzela", note: "Uniwersalny format" },
        { label: "Post poziomy", size: "1080×566", ratio: "1.91:1", placement: "Feed", note: "Szerokie zdjęcia, mniejszy kadr w siatce" },
        { label: "Story / Reels okładka", size: "1080×1920", ratio: "9:16", placement: "Story, Reels", note: "Pełny ekran pionowy" }
      ]
    },
    fb: {
      name: "Facebook",
      color: "#1877F2",
      formats: [
        { label: "Post ze zdjęciem", size: "1200×630", ratio: "1.91:1", placement: "Feed", note: "Standard link preview i postów" },
        { label: "Post kwadratowy", size: "1080×1080", ratio: "1:1", placement: "Feed", note: "Dobry na grafiki z tekstem" },
        { label: "Story", size: "1080×1920", ratio: "9:16", placement: "Story", note: "Pełnoekranowa story" }
      ]
    },
    li: {
      name: "LinkedIn",
      color: "#0A66C2",
      formats: [
        { label: "Obraz w poście", size: "1200×627", ratio: "1.91:1", placement: "Feed", note: "Zalecany format na LinkedIn" },
        { label: "Post kwadratowy", size: "1080×1080", ratio: "1:1", placement: "Feed", note: "Cytaty, infografiki" },
        { label: "Karuzela / dokument", size: "1080×1080", ratio: "1:1", placement: "Karuzela PDF", note: "Slajdy 1080×1080 px" },
        { label: "Okładka artykułu", size: "1200×644", ratio: "1.91:1", placement: "Newsletter / artykuł", note: "Nagłówek publikacji" }
      ]
    },
    tt: {
      name: "TikTok",
      color: "#00F2EA",
      formats: [
        { label: "Wideo / okładka", size: "1080×1920", ratio: "9:16", placement: "Feed", note: "Wyłącznie pionowo" },
        { label: "Miniatura profilu", size: "200×200", ratio: "1:1", placement: "Profil", note: "Kwadrat, min. 200 px" }
      ]
    },
    x: {
      name: "X (Twitter)",
      color: "#E7E9EA",
      formats: [
        { label: "Obraz w poście", size: "1200×675", ratio: "16:9", placement: "Feed", note: "Poziomy — zalecany" },
        { label: "Pojedynczy obraz", size: "1080×1080", ratio: "1:1", placement: "Feed", note: "Kwadrat do 4096×4096 px" },
        { label: "Nagłówek profilu", size: "1500×500", ratio: "3:1", placement: "Profil", note: "Banner u góry profilu" }
      ]
    }
  };

  var EXPORT_PRESETS = [
    { id: "feed-portrait", label: "Post pionowy IG", size: "1080×1350", ratio: "4:5", platforms: ["ig"], folder: "media/posty/" },
    { id: "feed-square", label: "Kwadrat uniwersalny", size: "1080×1080", ratio: "1:1", platforms: ["ig", "fb", "li", "x"], folder: "media/posty/" },
    { id: "feed-landscape", label: "Poziomy LI / FB", size: "1200×627", ratio: "1.91:1", platforms: ["li", "fb"], folder: "media/posty/" },
    { id: "story-vertical", label: "Story / Reels / TikTok", size: "1080×1920", ratio: "9:16", platforms: ["ig", "fb", "tt"], folder: "media/posty/" }
  ];

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function platformLabel(code) {
    var labels = { ig: "IG", fb: "FB", li: "LI", tt: "TT", x: "X" };
    return labels[code] || code.toUpperCase();
  }

  function getFormatsForPlatforms(platforms) {
    if (!platforms || !platforms.length) return [];
    return platforms.map(function (code) {
      var p = PLATFORMS[code];
      if (!p) return null;
      return { code: code, name: p.name, color: p.color, formats: p.formats };
    }).filter(Boolean);
  }

  function getPresetsForPlatforms(platforms) {
    if (!platforms || !platforms.length) return EXPORT_PRESETS;
    return EXPORT_PRESETS.filter(function (preset) {
      return preset.platforms.some(function (p) { return platforms.indexOf(p) !== -1; });
    });
  }

  function getRecommendation(platforms) {
    if (!platforms || !platforms.length) {
      return { size: "1080×1080", ratio: "1:1", note: "Wybierz platformy, aby zobaczyć zalecenia." };
    }
    var hasIg = platforms.indexOf("ig") !== -1;
    var hasLi = platforms.indexOf("li") !== -1;
    var hasFb = platforms.indexOf("fb") !== -1;
    var hasTt = platforms.indexOf("tt") !== -1;

    if (hasTt && platforms.length === 1) {
      return { size: "1080×1920", ratio: "9:16", note: "TikTok wymaga formatu pionowego 9:16." };
    }
    if (hasIg && hasLi && !hasFb) {
      return {
        size: "1080×1350 (IG) · 1200×627 (LI)",
        ratio: "4:5 / 1.91:1",
        note: "Przygotuj dwie wersje grafiki albo użyj kwadratu 1080×1080 jako kompromisu."
      };
    }
    if (hasIg) {
      return { size: "1080×1350", ratio: "4:5", note: "Zalecany format feedu Instagram." };
    }
    if (hasLi || hasFb) {
      return { size: "1200×627", ratio: "1.91:1", note: "Optymalny dla LinkedIn i Facebook feed." };
    }
    return { size: "1080×1080", ratio: "1:1", note: "Uniwersalny kwadrat na większość platform." };
  }

  function renderFormatTable(formats) {
    if (!formats.length) return "";
    return (
      '<table class="fmt-table">' +
        "<thead><tr><th>Format</th><th>Wymiary</th><th>Proporcje</th><th>Gdzie</th></tr></thead>" +
        "<tbody>" +
        formats.map(function (f) {
          return (
            "<tr>" +
              "<td>" + escapeHtml(f.label) + (f.note ? '<span class="fmt-note">' + escapeHtml(f.note) + "</span>" : "") + "</td>" +
              "<td><code>" + escapeHtml(f.size) + "</code></td>" +
              "<td>" + escapeHtml(f.ratio) + "</td>" +
              "<td>" + escapeHtml(f.placement) + "</td>" +
            "</tr>"
          );
        }).join("") +
        "</tbody>" +
      "</table>"
    );
  }

  function renderFormatsHTML() {
    var platformBlocks = Object.keys(PLATFORMS).map(function (code) {
      var p = PLATFORMS[code];
      return (
        '<section class="formats-card">' +
          '<h2 class="formats-card-title" style="--platform-color:' + p.color + '">' +
            '<span class="fmt-platform-dot"></span>' + escapeHtml(p.name) +
          "</h2>" +
          '<p class="formats-card-desc">Pliki: <strong>' + FILE_TYPES + "</strong> · " + MAX_SIZE + "</p>" +
          renderFormatTable(p.formats) +
        "</section>"
      );
    }).join("");

    var presetsHtml = EXPORT_PRESETS.map(function (pr) {
      var pl = pr.platforms.map(platformLabel).join(", ");
      return (
        '<div class="fmt-preset">' +
          '<div class="fmt-preset-head">' +
            "<strong>" + escapeHtml(pr.label) + "</strong>" +
            '<span class="fmt-preset-meta"><code>' + escapeHtml(pr.size) + "</code> · " + escapeHtml(pr.ratio) + "</span>" +
          "</div>" +
          '<div class="fmt-preset-foot">' +
            "<span>" + escapeHtml(pl) + "</span>" +
            '<span class="fmt-preset-folder">' + escapeHtml(pr.folder) + "</span>" +
          "</div>" +
        "</div>"
      );
    }).join("");

    return (
      '<div class="formats-page">' +
        '<div class="formats-intro">' +
          "<strong>Formaty graficzne social media</strong> — wymiary akceptowane przez platformy. " +
          "Przygotuj grafiki we wskazanych rozmiarach i zapisuj do <code>media/posty/</code>." +
        "</div>" +
        '<section class="formats-card formats-card--wide">' +
          "<h2 class=\"formats-card-title\">Presety rozmiarów</h2>" +
          '<p class="formats-card-desc">Gotowe ustawienia canvasu — wybierz preset pasujący do platform docelowych.</p>' +
          '<div class="fmt-presets">' + presetsHtml + "</div>" +
        "</section>" +
        '<div class="formats-grid">' + platformBlocks + "</div>" +
        '<p class="formats-footer">Instagram API wymaga publicznego HTTPS URL grafiki przy publikacji. Lokalne pliki działają w panelu i podglądzie.</p>' +
      "</div>"
    );
  }

  function renderDetailFormatsHTML(platforms) {
    if (!platforms || !platforms.length) return "";
    var rec = getRecommendation(platforms);
    var groups = getFormatsForPlatforms(platforms);
    var primary = groups.map(function (g) {
      var top = g.formats[0];
      return (
        '<span class="fmt-chip" style="--platform-color:' + g.color + '">' +
          platformLabel(g.code) + " · " + escapeHtml(top.size) +
        "</span>"
      );
    }).join("");

    var tables = groups.map(function (g) {
      return (
        '<div class="fmt-detail-group">' +
          '<div class="fmt-detail-platform">' + escapeHtml(g.name) + "</div>" +
          renderFormatTable(g.formats.slice(0, 3)) +
        "</div>"
      );
    }).join("");

    return (
      '<div class="detail-formats">' +
        '<div class="detail-text-label">Format graficzny</div>' +
        '<div class="fmt-recommend">' +
          '<strong>Zalecenie:</strong> <code>' + escapeHtml(rec.size) + "</code> (" + escapeHtml(rec.ratio) + ") — " + escapeHtml(rec.note) +
        "</div>" +
        '<div class="fmt-chips">' + primary + "</div>" +
        tables +
        '<p class="fmt-detail-hint">Pliki: ' + FILE_TYPES + " · " + MAX_SIZE + '</p>' +
      "</div>"
    );
  }

  function renderGeneratorHintHTML(platforms) {
    var rec = getRecommendation(platforms);
    var presets = getPresetsForPlatforms(platforms);
    var presetList = presets.slice(0, 3).map(function (p) {
      return "<li><code>" + escapeHtml(p.size) + "</code> — " + escapeHtml(p.label) + "</li>";
    }).join("");

    return (
      '<p class="gen-image-hint">' +
        "Zalecany rozmiar: <strong>" + escapeHtml(rec.size) + "</strong> (" + escapeHtml(rec.ratio) + "). " +
        escapeHtml(rec.note) +
        (presetList ? "<ul class=\"fmt-gen-list\">" + presetList + "</ul>" : "") +
        " Zapisz do <code>Panel/media/posty/</code> i ustaw ścieżkę poniżej." +
      "</p>"
    );
  }

  global.ImageFormats = {
    PLATFORMS: PLATFORMS,
    EXPORT_PRESETS: EXPORT_PRESETS,
    getFormatsForPlatforms: getFormatsForPlatforms,
    getPresetsForPlatforms: getPresetsForPlatforms,
    getRecommendation: getRecommendation,
    renderFormatsHTML: renderFormatsHTML,
    renderDetailFormatsHTML: renderDetailFormatsHTML,
    renderGeneratorHintHTML: renderGeneratorHintHTML
  };
})(window);
