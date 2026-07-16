/**
 * Content System — zarządzanie postami (formularz, statusy, upload)
 */
(function (global) {
  "use strict";

  var USER_POSTS_KEY = "content-system-user-posts";
  var LEGACY_GENERATED_KEY = "content-system-generated-posts";
  var DELETED_IDS_KEY = "content-system-deleted-ids";

  var serverMode = false;
  var postsCache = null;
  var deletedIdsCache = null;

  var STATUS_LABELS = {
    draft: "Szkic",
    ready: "Gotowy",
    published: "Opublikowany",
    partial: "Częściowo"
  };

  var PUBLISH_PLATFORMS = [
    { code: "fb", label: "Facebook" },
    { code: "ig", label: "Instagram" },
    { code: "li", label: "LinkedIn" }
  ];

  var ALLOWED_IMAGE_EXT = ["jpg", "jpeg", "png", "webp"];
  var ALLOWED_IMAGE_MIME = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  };

  function getImageFileKind(file) {
    if (!file) return null;
    var mime = (file.type || "").toLowerCase();
    if (ALLOWED_IMAGE_MIME[mime]) return ALLOWED_IMAGE_MIME[mime];

    var ext = (file.name || "").split(".").pop().toLowerCase();
    if (ext === "jpeg") ext = "jpg";
    if (ALLOWED_IMAGE_EXT.indexOf(ext) !== -1) return ext;
    return null;
  }

  function buildUploadFilename(file) {
    var kind = getImageFileKind(file);
    if (!kind) return null;
    var base = (file.name || "grafika." + kind)
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!base) base = "grafika";
    return base + "." + kind;
  }

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

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function normalizePost(item) {
    if (!item) return null;
    var master = item.textMaster || item.text || "";
    var plats = Array.isArray(item.platforms) ? item.platforms.slice() : [];
    var done = item.donePlatforms || item.publishedPlatforms || [];
    var textLi = item.textLi || "";
    var textFb = item.textFb || "";
    var textIg = item.textIg || "";

    if (!textLi && !textFb && !textIg && master) {
      if (plats.length === 1 && plats[0] === "li") textLi = master;
      else if (plats.length === 1 && plats[0] === "fb") textFb = master;
      else if (plats.length === 1 && plats[0] === "ig") textIg = master;
      else {
        textLi = textLi || master;
        textFb = textFb || master;
        textIg = textIg || master;
      }
    }

    return {
      id: String(item.id),
      type: "post",
      title: item.title || "",
      topic: item.topic || "",
      date: item.date || todayISO(),
      platforms: plats,
      image: item.image || "",
      textMaster: master,
      textLi: textLi,
      textFb: textFb,
      textIg: textIg,
      text: master,
      status: item.status || "draft",
      donePlatforms: Array.isArray(done) ? done.slice() : []
    };
  }

  function getTextForPlatform(item, code) {
    if (code === "li") return item.textLi || item.textMaster || item.text || "";
    if (code === "fb") return item.textFb || item.textMaster || item.text || "";
    if (code === "ig") return item.textIg || item.textMaster || item.text || "";
    return item.textMaster || item.text || "";
  }

  function trimTo(text, max) {
    text = (text || "").trim();
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + "…";
  }

  function formatForLinkedIn(text) {
    return (text || "").trim();
  }

  function formatForFacebook(text) {
    return trimTo(text, 1500);
  }

  function formatForInstagram(text) {
    var t = (text || "").trim().replace(/\n{3,}/g, "\n\n");
    return trimTo(t, 2200);
  }

  function getDeletedIdsLocal() {
    try {
      var raw = localStorage.getItem(DELETED_IDS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveDeletedIdsLocal(ids) {
    localStorage.setItem(DELETED_IDS_KEY, JSON.stringify(ids || []));
  }

  function getDeletedIds() {
    if (serverMode && deletedIdsCache !== null) return deletedIdsCache.slice();
    return getDeletedIdsLocal();
  }

  function saveDeletedIds(ids, skipServer) {
    var list = ids || [];
    if (serverMode && !skipServer && global.AuthClient) {
      deletedIdsCache = list.slice();
      return global.AuthClient.apiFetch("/api/deleted-ids", {
        method: "PUT",
        body: JSON.stringify({ deletedIds: list })
      }).catch(function () {
        saveDeletedIdsLocal(list);
      });
    }
    saveDeletedIdsLocal(list);
    return Promise.resolve();
  }

  function enableServerMode(data) {
    serverMode = true;
    postsCache = (data && data.posts ? data.posts : []).map(normalizePost);
    deletedIdsCache = (data && data.deletedIds) ? data.deletedIds.slice() : [];
  }

  function initFromServer() {
    if (!global.AuthClient || !global.AuthClient.isServerMode()) {
      return Promise.resolve(null);
    }
    return global.AuthClient.apiFetch("/api/posts").then(function (data) {
      enableServerMode(data);
      return data;
    });
  }

  function isServerMode() {
    return serverMode;
  }

  function getEffectiveStatus(item) {
    var plats = item.platforms || [];
    var done = item.donePlatforms || [];
    if (plats.length && done.length >= plats.length) return "published";
    if (done.length > 0) return "partial";
    return item.status || "draft";
  }

  function getUserPosts() {
    if (serverMode && postsCache !== null) return postsCache.map(normalizePost);
    try {
      var raw = localStorage.getItem(USER_POSTS_KEY);
      if (raw) {
        return JSON.parse(raw).map(normalizePost);
      }
      var legacy = localStorage.getItem(LEGACY_GENERATED_KEY);
      if (legacy) {
        var migrated = JSON.parse(legacy).map(function (p) {
          var n = normalizePost(p);
          n.status = "draft";
          return n;
        });
        saveUserPosts(migrated);
        return migrated;
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  function saveUserPosts(posts) {
    var normalized = posts.map(normalizePost);
    if (serverMode && global.AuthClient) {
      postsCache = normalized;
      return;
    }
    localStorage.setItem(USER_POSTS_KEY, JSON.stringify(normalized));
  }

  function persistPostToServer(post) {
    if (!serverMode || !global.AuthClient) return Promise.resolve(post);
    var normalized = normalizePost(post);
    return global.AuthClient.apiFetch("/api/posts", {
      method: "PUT",
      body: JSON.stringify({ post: normalized })
    }).then(function () {
      var posts = getUserPosts();
      var idx = posts.findIndex(function (p) { return p.id === normalized.id; });
      if (idx === -1) posts.unshift(normalized);
      else posts[idx] = normalized;
      postsCache = posts;
      return normalized;
    });
  }

  function isUserManaged(id) {
    var sid = String(id);
    return sid.indexOf("user-") === 0 || sid.indexOf("gen-") === 0 ||
      getUserPosts().some(function (p) { return p.id === sid; });
  }

  function getAllItems(content, deletedIds) {
    var deleted = deletedIds || [];
    var userMap = {};
    getUserPosts().forEach(function (p) { userMap[p.id] = p; });

    var items = [];
    var seen = {};

    (content || []).forEach(function (item) {
      if (deleted.indexOf(item.id) !== -1) return;
      var merged = userMap[item.id] ? userMap[item.id] : normalizePost(item);
      if (!merged.status || merged.status === "draft" && !userMap[item.id]) {
        merged.status = "ready";
      }
      items.push(merged);
      seen[item.id] = true;
    });

    getUserPosts().forEach(function (p) {
      if (!seen[p.id] && deleted.indexOf(p.id) === -1) {
        items.push(p);
      }
    });

    return items;
  }

  function savePost(post) {
    var normalized = normalizePost(post);
    if (serverMode && global.AuthClient) {
      return persistPostToServer(normalized);
    }
    var posts = getUserPosts();
    var idx = posts.findIndex(function (p) { return p.id === normalized.id; });
    if (idx === -1) {
      posts.unshift(normalized);
    } else {
      posts[idx] = normalized;
    }
    saveUserPosts(posts);
    return Promise.resolve(normalized);
  }

  function createNewPost() {
    var ts = Date.now();
    return normalizePost({
      id: "user-" + ts,
      title: "",
      topic: "",
      date: todayISO(),
      platforms: ["li", "fb", "ig"],
      image: "",
      textMaster: "",
      textLi: "",
      textFb: "",
      textIg: "",
      text: "",
      status: "draft",
      donePlatforms: []
    });
  }

  function deletePost(id, deletedIds, saveDeletedIdsFn) {
    if (isUserManaged(id)) {
      if (serverMode && global.AuthClient) {
        postsCache = getUserPosts().filter(function (p) { return p.id !== id; });
        return global.AuthClient.apiFetch("/api/posts/" + encodeURIComponent(id), {
          method: "DELETE"
        }).catch(function () { /* ignore */ });
      }
      saveUserPosts(getUserPosts().filter(function (p) { return p.id !== id; }));
    } else {
      var ids = deletedIds.slice();
      if (ids.indexOf(id) === -1) ids.push(id);
      saveDeletedIdsFn(ids);
    }
  }

  function togglePlatformDone(id, platform, sourceItem) {
    var posts = getUserPosts();
    var post = posts.find(function (p) { return p.id === id; });
    if (!post && sourceItem) post = normalizePost(sourceItem);
    if (!post) post = normalizePost({ id: id, status: "ready" });

    var idx = post.donePlatforms.indexOf(platform);
    if (idx === -1) post.donePlatforms.push(platform);
    else post.donePlatforms.splice(idx, 1);

    savePost(post);
    return post;
  }

  function suggestNextId(content) {
    var max = 0;
    getAllItems(content, []).forEach(function (item) {
      var n = parseInt(String(item.id).replace(/\D/g, ""), 10);
      if (!isNaN(n) && n > max) max = n;
    });
    return String(max + 1).padStart(3, "0");
  }

  function proxyBase() {
    if (global.AuthClient) return global.AuthClient.getApiBase();
    if (global.location && global.location.protocol !== "file:") {
      return global.location.origin.replace(/\/$/, "");
    }
    return "http://localhost:8787";
  }

  function authHeaders(extra) {
    var headers = Object.assign({}, extra || {});
    if (global.AuthClient && global.AuthClient.getToken()) {
      headers.Authorization = "Bearer " + global.AuthClient.getToken();
    }
    return headers;
  }

  function uploadImage(file) {
    var base = proxyBase();
    if (!base) {
      return Promise.reject(new Error("Uruchom serwer: npm start (brak URL API)"));
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = reader.result;
        var base64 = dataUrl.split(",")[1] || "";
        var safeName = buildUploadFilename(file);
        if (!safeName) {
          reject(new Error("Dozwolone formaty: JPG, PNG, WEBP"));
          return;
        }

        fetch(base + "/upload/image", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ filename: safeName, data: base64, mime: file.type || "" })
        }).then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok || body.error) throw new Error(body.error || "Błąd uploadu");
            resolve(body);
          });
        }).catch(reject);
      };
      reader.onerror = function () { reject(new Error("Nie udało się odczytać pliku")); };
      reader.readAsDataURL(file);
    });
  }

  function renderStatusBadge(item, inline) {
    var eff = getEffectiveStatus(item);
    var inlineCls = inline ? " post-status--inline" : "";
    return '<span class="post-status post-status--' + eff + inlineCls + '">' +
      escapeHtml(STATUS_LABELS[eff] || eff) + "</span>";
  }

  function renderPlatformPublishStatus(item, platformLabels) {
    var plats = item.platforms || [];
    if (!plats.length) return "";
    var done = item.donePlatforms || [];
    return plats.map(function (code) {
      var isDone = done.indexOf(code) !== -1;
      var label = (platformLabels && platformLabels[code]) || code.toUpperCase();
      return '<span class="pub-platform' + (isDone ? " pub-platform--done" : "") + '">' +
        label + (isDone ? " ✓" : "") + "</span>";
    }).join("");
  }

  function renderReadyChecklistHTML(item) {
    var plats = item.platforms || [];
    var checks = [];
    checks.push({ ok: !!(item.textMaster || "").trim(), label: "Tekst źródłowy (master)" });
    plats.forEach(function (code) {
      var label = code === "li" ? "LinkedIn" : code === "fb" ? "Facebook" : code === "ig" ? "Instagram" : code;
      checks.push({ ok: !!getTextForPlatform(item, code).trim(), label: "Treść " + label });
    });
    checks.push({ ok: !!item.image, label: item.image ? "Grafika przypisana" : "Grafika (opcjonalnie)", optional: !item.image });
    checks.push({ ok: item.status !== "draft", label: item.status !== "draft" ? "Status: Gotowy" : 'Ustaw status „Gotowy”' });

    var rows = checks.map(function (c) {
      var cls = c.ok ? "ok" : (c.optional ? "warn" : "err");
      return '<li class="pub-check pub-check--' + cls + '"><span class="pub-check-icon">' +
        (c.ok ? "✓" : (c.optional ? "○" : "✕")) + "</span>" + escapeHtml(c.label) + "</li>";
    }).join("");

    return (
      '<div class="pub-checklist">' +
        '<div class="detail-text-label">Checklist przed wrzuceniem</div>' +
        '<ul class="pub-checklist-list">' + rows + "</ul>" +
      "</div>"
    );
  }

  function renderDoneTogglesHTML(item, platformLabels) {
    var plats = item.platforms || [];
    if (!plats.length) return "";
    var done = item.donePlatforms || [];
    var rows = plats.map(function (code) {
      var label = (platformLabels && platformLabels[code]) || code.toUpperCase();
      var on = done.indexOf(code) !== -1 ? " checked" : "";
      return '<label class="done-toggle"><input type="checkbox" data-done-platform="' + code + '"' + on +
        "> Wrzucone na " + escapeHtml(label) + "</label>";
    }).join("");
    return (
      '<div class="done-toggles">' +
        '<div class="detail-text-label">Oznacz ręcznie (publikacja poza panelem)</div>' +
        rows +
      "</div>"
    );
  }

  function bindDoneToggles(item, onUpdate) {
    document.querySelectorAll("[data-done-platform]").forEach(function (el) {
      el.addEventListener("change", function () {
        togglePlatformDone(item.id, el.getAttribute("data-done-platform"), item);
        if (onUpdate) onUpdate(item.id);
      });
    });
  }

  function renderDetailTextsHTML(item, platformLabels) {
    var plats = (item.platforms || []).filter(function (p) {
      return ["li", "fb", "ig"].indexOf(p) !== -1;
    });
    if (!plats.length) {
      return '<div class="detail-text-label">Treść</div><div class="detail-text">' +
        escapeHtml(item.textMaster || item.text || "") + "</div>";
    }

    var tabs = plats.map(function (p, i) {
      var label = (platformLabels && platformLabels[p]) || p.toUpperCase();
      return '<button type="button" class="preview-tab detail-text-tab' + (i === 0 ? " active" : "") +
        '" data-text-tab="' + p + '">' + escapeHtml(label) + "</button>";
    }).join("");

    var panels = plats.map(function (p, i) {
      var body = escapeHtml(getTextForPlatform(item, p));
      return '<div class="detail-text-panel' + (i === 0 ? " active" : "") + '" data-text-panel="' + p + '">' +
        '<div class="detail-text">' + body + "</div>" +
        '<button type="button" class="detail-copy-btn detail-copy-plat" data-copy-plat="' + p + '">Kopiuj ' +
        escapeHtml((platformLabels && platformLabels[p]) || p.toUpperCase()) + "</button></div>";
    }).join("");

    return (
      '<div class="detail-text-label">Treści per platforma</div>' +
      '<div class="preview-tabs">' + tabs + "</div>" +
      panels
    );
  }

  function bindDetailTextTabs(copyHandler) {
    document.querySelectorAll(".detail-text-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        var p = tab.getAttribute("data-text-tab");
        document.querySelectorAll(".detail-text-tab").forEach(function (t) {
          t.classList.toggle("active", t.getAttribute("data-text-tab") === p);
        });
        document.querySelectorAll(".detail-text-panel").forEach(function (panel) {
          panel.classList.toggle("active", panel.getAttribute("data-text-panel") === p);
        });
      });
    });
    if (copyHandler) {
      document.querySelectorAll(".detail-copy-plat").forEach(function (btn) {
        btn.addEventListener("click", function () {
          copyHandler(btn.getAttribute("data-copy-plat"));
        });
      });
    }
  }

  function renderEditorHTML(post) {
    var p = normalizePost(post);
    var isNew = !post || (String(post.id).indexOf("user-") === 0 && !post.title && !p.textMaster);

    var platformChecks = PUBLISH_PLATFORMS.map(function (pl) {
      var on = p.platforms.indexOf(pl.code) !== -1 ? " checked" : "";
      return '<label class="editor-platform"><input type="checkbox" name="editor-platform" value="' +
        pl.code + '"' + on + "> " + escapeHtml(pl.label) + "</label>";
    }).join("");

    var statusOpts = ["draft", "ready"].map(function (s) {
      var sel = p.status === s ? " selected" : "";
      return '<option value="' + s + '"' + sel + ">" + STATUS_LABELS[s] + "</option>";
    }).join("");

    var defaultTopics = [
      "IT / AWS", "Rekrutacja", "Case study", "Edukacja", "Ogłoszenie", "News tygodnia"
    ];
    var topicOpts = '<option value="">— wybierz temat —</option>';
    defaultTopics.forEach(function (t) {
      var sel = t === p.topic ? " selected" : "";
      topicOpts += '<option value="' + escapeAttr(t) + '"' + sel + ">" + escapeHtml(t) + "</option>";
    });
    if (p.topic && defaultTopics.indexOf(p.topic) === -1) {
      topicOpts += '<option value="' + escapeAttr(p.topic) + '" selected>' + escapeHtml(p.topic) + "</option>";
    }

    var preview = p.image
      ? '<img src="' + escapeAttr(p.image) + '" alt="" class="editor-preview-img">'
      : '<div class="editor-drop-placeholder">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
          '<polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
          "<span>Przeciągnij grafikę lub kliknij</span></div>";

    var platPanels = PUBLISH_PLATFORMS.map(function (pl, i) {
      var val = pl.code === "li" ? p.textLi : pl.code === "fb" ? p.textFb : p.textIg;
      return '<div class="editor-plat-panel' + (i === 0 ? " active" : "") + '" data-editor-plat="' + pl.code + '">' +
        '<label class="editor-label" for="editor-text-' + pl.code + '">Treść · ' + escapeHtml(pl.label) + "</label>" +
        '<textarea class="editor-textarea editor-textarea--sm" id="editor-text-' + pl.code +
        '" rows="8" placeholder="Wersja na ' + escapeHtml(pl.label) + '…">' + escapeHtml(val) + "</textarea></div>";
    }).join("");

    var platTabs = PUBLISH_PLATFORMS.map(function (pl, i) {
      return '<button type="button" class="preview-tab editor-plat-tab' + (i === 0 ? " active" : "") +
        '" data-editor-plat-tab="' + pl.code + '">' + escapeHtml(pl.label) + "</button>";
    }).join("");

    return (
      '<div class="post-editor">' +
        '<div class="post-editor-intro">' +
          "<strong>" + (isNew ? "Nowy post" : "Edycja posta") + "</strong> — tekst źródłowy → 3 wersje (LI / FB / IG). " +
          "Publikujesz ręcznie poza panelem." +
        "</div>" +
        '<form class="post-editor-form" id="post-editor-form">' +
          '<div class="editor-grid">' +
            '<div class="editor-main">' +
              '<div class="editor-field">' +
                '<label class="editor-label" for="editor-title">Tytuł (wewnętrzny)</label>' +
                '<input class="editor-input" id="editor-title" value="' + escapeAttr(p.title) +
                '" placeholder="np. News tygodnia · marzec" required>' +
              "</div>" +
              '<div class="editor-row-2">' +
                '<div class="editor-field">' +
                  '<label class="editor-label" for="editor-topic">Temat</label>' +
                  '<select class="editor-input" id="editor-topic">' + topicOpts + "</select>" +
                "</div>" +
                '<div class="editor-field">' +
                  '<label class="editor-label" for="editor-date">Data</label>' +
                  '<input type="date" class="editor-input" id="editor-date" value="' + escapeAttr(p.date) + '">' +
                "</div>" +
              "</div>" +
              '<div class="editor-row-2">' +
                '<div class="editor-field">' +
                  '<label class="editor-label" for="editor-status">Status</label>' +
                  '<select class="editor-input" id="editor-status">' + statusOpts + "</select>" +
                "</div>" +
                '<div class="editor-field">' +
                  '<span class="editor-label">Platformy</span>' +
                  '<div class="editor-platforms">' + platformChecks + "</div>" +
                "</div>" +
              "</div>" +
              '<div class="editor-field">' +
                '<label class="editor-label" for="editor-text-master">Tekst źródłowy (master)</label>' +
                '<textarea class="editor-textarea" id="editor-text-master" rows="8" placeholder="Surowy tekst, notatki, bullet points…">' +
                  escapeHtml(p.textMaster) + "</textarea>" +
              "</div>" +
              '<div class="editor-transform-row">' +
                '<button type="button" class="gen-btn" id="editor-apply-all">Rozłóż master na platformy</button>' +
                '<button type="button" class="gen-btn" id="editor-fmt-li">Dopasuj LinkedIn</button>' +
                '<button type="button" class="gen-btn" id="editor-fmt-fb">Dopasuj Facebook</button>' +
                '<button type="button" class="gen-btn" id="editor-fmt-ig">Dopasuj Instagram</button>' +
              "</div>" +
              '<div class="editor-field">' +
                '<span class="editor-label">Treści per platforma</span>' +
                '<div class="preview-tabs">' + platTabs + "</div>" +
                platPanels +
              "</div>" +
            "</div>" +
            '<div class="editor-side">' +
              '<div class="editor-field">' +
                '<span class="editor-label">Grafika</span>' +
                '<div class="editor-drop" id="editor-drop">' + preview + "</div>" +
                '<input type="file" id="editor-file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden>' +
                '<p class="editor-drop-hint">JPG, PNG, WEBP · <code>node publish-server.mjs</code></p>' +
                '<input class="editor-input editor-input--sm" id="editor-image" value="' + escapeAttr(p.image) +
                '" placeholder="media/posty/nazwa.jpg">' +
              "</div>" +
              (global.ImageFormats && p.platforms.length
                ? '<div class="editor-format-tip">' +
                    global.ImageFormats.renderGeneratorHintHTML(p.platforms) + "</div>"
                : "") +
            "</div>" +
          "</div>" +
          '<div class="editor-actions">' +
            '<button type="button" class="gen-btn" id="editor-cancel">Anuluj</button>' +
            '<button type="submit" class="gen-btn gen-btn-primary" id="editor-save">Zapisz post</button>' +
          "</div>" +
          '<p class="editor-msg" id="editor-msg"></p>' +
        "</form>" +
      "</div>"
    );
  }

  function collectEditorForm(postId) {
    var plats = [];
    document.querySelectorAll('input[name="editor-platform"]:checked').forEach(function (el) {
      plats.push(el.value);
    });
    var master = (document.getElementById("editor-text-master") || {}).value || "";
    return normalizePost({
      id: postId,
      title: (document.getElementById("editor-title") || {}).value || "",
      topic: (document.getElementById("editor-topic") || {}).value || "",
      date: (document.getElementById("editor-date") || {}).value || todayISO(),
      platforms: plats,
      image: (document.getElementById("editor-image") || {}).value || "",
      textMaster: master,
      textLi: (document.getElementById("editor-text-li") || {}).value || "",
      textFb: (document.getElementById("editor-text-fb") || {}).value || "",
      textIg: (document.getElementById("editor-text-ig") || {}).value || "",
      text: master,
      status: (document.getElementById("editor-status") || {}).value || "draft"
    });
  }

  function bindEditorEvents(postId, callbacks) {
    var cb = callbacks || {};
    var drop = document.getElementById("editor-drop");
    var fileInput = document.getElementById("editor-file");
    var imageInput = document.getElementById("editor-image");
    var msg = document.getElementById("editor-msg");

    function setMsg(text, type) {
      if (!msg) return;
      msg.textContent = text;
      msg.className = "editor-msg" + (type ? " editor-msg--" + type : "");
    }

    function updatePreview(path) {
      if (!drop) return;
      if (path) {
        drop.innerHTML = '<img src="' + escapeAttr(path) + '" alt="" class="editor-preview-img">';
      }
    }

    function handleFile(file) {
      if (!getImageFileKind(file)) {
        setMsg("Wybierz plik JPG, PNG lub WEBP", "err");
        return;
      }
      setMsg("Wgrywam grafikę…", "");
      uploadImage(file).then(function (res) {
        if (imageInput) imageInput.value = res.path;
        updatePreview(res.path);
        setMsg("Grafika zapisana: " + res.path, "ok");
        if (cb.onToast) cb.onToast("Grafika wgrana");
      }).catch(function (err) {
        setMsg(err.message, "err");
      });
    }

    if (drop) {
      drop.addEventListener("click", function () {
        if (fileInput) fileInput.click();
      });
      drop.addEventListener("dragover", function (e) {
        e.preventDefault();
        drop.classList.add("editor-drop--over");
      });
      drop.addEventListener("dragleave", function () {
        drop.classList.remove("editor-drop--over");
      });
      drop.addEventListener("drop", function (e) {
        e.preventDefault();
        drop.classList.remove("editor-drop--over");
        var file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) handleFile(file);
      });
    }

    if (fileInput) {
      fileInput.addEventListener("change", function () {
        if (fileInput.files[0]) handleFile(fileInput.files[0]);
      });
    }

    if (imageInput) {
      imageInput.addEventListener("input", function () {
        if (imageInput.value.trim()) updatePreview(imageInput.value.trim());
      });
    }

    document.querySelectorAll('input[name="editor-platform"]').forEach(function (el) {
      el.addEventListener("change", function () {
        var plats = [];
        document.querySelectorAll('input[name="editor-platform"]:checked').forEach(function (c) {
          plats.push(c.value);
        });
        var tip = document.querySelector(".editor-format-tip");
        if (tip && global.ImageFormats) {
          tip.innerHTML = plats.length ? global.ImageFormats.renderGeneratorHintHTML(plats) : "";
        }
      });
    });

    document.querySelectorAll(".editor-plat-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        var code = tab.getAttribute("data-editor-plat-tab");
        document.querySelectorAll(".editor-plat-tab").forEach(function (t) {
          t.classList.toggle("active", t.getAttribute("data-editor-plat-tab") === code);
        });
        document.querySelectorAll(".editor-plat-panel").forEach(function (panel) {
          panel.classList.toggle("active", panel.getAttribute("data-editor-plat") === code);
        });
      });
    });

    function getMaster() {
      var el = document.getElementById("editor-text-master");
      return el ? el.value : "";
    }

    function setPlatText(code, text) {
      var el = document.getElementById("editor-text-" + code);
      if (el) el.value = text;
    }

    var applyAll = document.getElementById("editor-apply-all");
    if (applyAll) {
      applyAll.addEventListener("click", function () {
        var m = getMaster();
        setPlatText("li", formatForLinkedIn(m));
        setPlatText("fb", formatForFacebook(m));
        setPlatText("ig", formatForInstagram(m));
        setMsg("Rozłożono master na LI / FB / IG", "ok");
      });
    }
    var fmtLi = document.getElementById("editor-fmt-li");
    if (fmtLi) fmtLi.addEventListener("click", function () {
      setPlatText("li", formatForLinkedIn(getMaster()));
      setMsg("Dopasowano LinkedIn", "ok");
    });
    var fmtFb = document.getElementById("editor-fmt-fb");
    if (fmtFb) fmtFb.addEventListener("click", function () {
      setPlatText("fb", formatForFacebook(getMaster()));
      setMsg("Dopasowano Facebook", "ok");
    });
    var fmtIg = document.getElementById("editor-fmt-ig");
    if (fmtIg) fmtIg.addEventListener("click", function () {
      setPlatText("ig", formatForInstagram(getMaster()));
      setMsg("Dopasowano Instagram", "ok");
    });

    var cancelBtn = document.getElementById("editor-cancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        if (cb.onCancel) cb.onCancel();
      });
    }

    var form = document.getElementById("post-editor-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var data = collectEditorForm(postId);
        if (callbacks.getExisting) {
          var ex = callbacks.getExisting(postId);
          if (ex && ex.donePlatforms) data.donePlatforms = ex.donePlatforms.slice();
        } else {
          var existing = getUserPosts().find(function (p) { return p.id === postId; });
          if (existing && existing.donePlatforms) data.donePlatforms = existing.donePlatforms.slice();
        }
        if (!data.title.trim()) {
          setMsg("Podaj tytuł posta", "err");
          return;
        }
        if (!data.platforms.length) {
          setMsg("Wybierz co najmniej jedną platformę", "err");
          return;
        }
        savePost(data);
        if (cb.onSave) cb.onSave(data);
      });
    }
  }

  function needsPublish(item) {
    if (!item || item.status === "draft") return false;
    var plats = item.platforms || [];
    var done = item.donePlatforms || [];
    return plats.some(function (p) { return done.indexOf(p) === -1; });
  }

  function countQueueItems(items) {
    return items.filter(needsPublish).length;
  }

  function renderPreviewPanel(item, platform, platformLabels) {
    var label = (platformLabels && platformLabels[platform]) || platform.toUpperCase();
    var text = escapeHtml(getTextForPlatform(item, platform)).replace(/\n/g, "<br>");
    var img = item.image
      ? '<img src="' + escapeAttr(item.image) + '" alt="" class="mock-img">'
      : '<div class="mock-img mock-img--empty">Brak grafiki</div>';

    if (platform === "ig") {
      return (
        '<div class="mock mock--ig">' +
          '<div class="mock-header"><span class="mock-avatar"></span><strong>twoja_marka</strong></div>' +
          img +
          '<div class="mock-caption">' + (text || "<em>Brak treści</em>") + "</div>" +
        "</div>"
      );
    }
    if (platform === "li") {
      return (
        '<div class="mock mock--li">' +
          '<div class="mock-header"><span class="mock-avatar mock-avatar--li"></span>' +
            '<div><strong>Twoja Firma</strong><span> · ' + escapeHtml(label) + "</span></div></div>" +
          '<div class="mock-body">' + (text || "<em>Brak treści</em>") + "</div>" +
          img +
        "</div>"
      );
    }
    return (
      '<div class="mock mock--fb">' +
        '<div class="mock-header"><span class="mock-avatar mock-avatar--fb"></span><strong>Twoja Strona</strong></div>' +
        '<div class="mock-body">' + (text || "<em>Brak treści</em>") + "</div>" +
        img +
      "</div>"
    );
  }

  function renderPlatformPreviewSection(item, platformLabels) {
    var plats = (item.platforms || []).filter(function (p) {
      return ["fb", "ig", "li"].indexOf(p) !== -1;
    });
    if (!plats.length) return "";

    var tabs = plats.map(function (p, i) {
      var label = (platformLabels && platformLabels[p]) || p.toUpperCase();
      return '<button type="button" class="preview-tab' + (i === 0 ? " active" : "") +
        '" data-preview="' + p + '">' + escapeHtml(label) + "</button>";
    }).join("");

    var panels = plats.map(function (p, i) {
      return '<div class="preview-panel' + (i === 0 ? " active" : "") +
        '" data-preview-panel="' + p + '">' +
        renderPreviewPanel(item, p, platformLabels) + "</div>";
    }).join("");

    return (
      '<div class="platform-preview">' +
        '<div class="detail-text-label">Podgląd na platformie</div>' +
        '<div class="preview-tabs">' + tabs + "</div>" +
        '<div class="preview-panels">' + panels + "</div>" +
      "</div>"
    );
  }

  function bindPlatformPreviewEvents() {
    document.querySelectorAll(".preview-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        var p = tab.getAttribute("data-preview");
        document.querySelectorAll(".preview-tab").forEach(function (t) {
          t.classList.toggle("active", t.getAttribute("data-preview") === p);
        });
        document.querySelectorAll(".preview-panel").forEach(function (panel) {
          panel.classList.toggle("active", panel.getAttribute("data-preview-panel") === p);
        });
      });
    });
  }

  global.PostManager = {
    normalizePost: normalizePost,
    getEffectiveStatus: getEffectiveStatus,
    getUserPosts: getUserPosts,
    getAllItems: getAllItems,
    savePost: savePost,
    createNewPost: createNewPost,
    deletePost: deletePost,
    getDeletedIds: getDeletedIds,
    saveDeletedIds: saveDeletedIds,
    initFromServer: initFromServer,
    isServerMode: isServerMode,
    togglePlatformDone: togglePlatformDone,
    getTextForPlatform: getTextForPlatform,
    formatForLinkedIn: formatForLinkedIn,
    formatForFacebook: formatForFacebook,
    formatForInstagram: formatForInstagram,
    isUserManaged: isUserManaged,
    suggestNextId: suggestNextId,
    uploadImage: uploadImage,
    renderStatusBadge: renderStatusBadge,
    renderPlatformPublishStatus: renderPlatformPublishStatus,
    renderReadyChecklistHTML: renderReadyChecklistHTML,
    renderDoneTogglesHTML: renderDoneTogglesHTML,
    bindDoneToggles: bindDoneToggles,
    renderDetailTextsHTML: renderDetailTextsHTML,
    bindDetailTextTabs: bindDetailTextTabs,
    needsPublish: needsPublish,
    countQueueItems: countQueueItems,
    renderPlatformPreviewSection: renderPlatformPreviewSection,
    bindPlatformPreviewEvents: bindPlatformPreviewEvents,
    renderEditorHTML: renderEditorHTML,
    bindEditorEvents: bindEditorEvents,
    STATUS_LABELS: STATUS_LABELS
  };
})(window);
