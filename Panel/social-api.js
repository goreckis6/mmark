/**
 * Content System — integracje social (Meta / LinkedIn)
 * Wymaga opcjonalnego proxy: node publish-server.mjs
 */
(function (global) {
  "use strict";

  var CONFIG_KEY = "content-system-social-config";

  var DEFAULT_CONFIG = {
    proxyUrl: "http://localhost:8787",
    meta: {
      appId: "",
      pageId: "",
      pageAccessToken: "",
      igAccountId: ""
    },
    linkedin: {
      accessToken: "",
      authorUrn: ""
    }
  };

  function getConfig() {
    try {
      var raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      var parsed = JSON.parse(raw);
      return {
        proxyUrl: parsed.proxyUrl || DEFAULT_CONFIG.proxyUrl,
        meta: Object.assign({}, DEFAULT_CONFIG.meta, parsed.meta || {}),
        linkedin: Object.assign({}, DEFAULT_CONFIG.linkedin, parsed.linkedin || {})
      };
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  function saveConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }

  function proxyBase() {
    var url = (getConfig().proxyUrl || "").replace(/\/$/, "");
    return url;
  }

  function apiPost(path, body) {
    var base = proxyBase();
    if (!base) return Promise.reject(new Error("Ustaw URL proxy w Integracjach"));
    return fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || data.error) {
          throw new Error(data.error || data.message || "Błąd API (" + res.status + ")");
        }
        return data;
      });
    });
  }

  function isMetaConfigured() {
    var m = getConfig().meta;
    return !!(m.pageId && m.pageAccessToken);
  }

  function isInstagramConfigured() {
    var m = getConfig().meta;
    return !!(m.igAccountId && m.pageAccessToken);
  }

  function isLinkedInConfigured() {
    var li = getConfig().linkedin;
    return !!(li.accessToken && li.authorUrn);
  }

  function getConnectionStatus() {
    return {
      facebook: isMetaConfigured(),
      instagram: isInstagramConfigured(),
      linkedin: isLinkedInConfigured()
    };
  }

  function resolveImageUrl(imagePath) {
    if (!imagePath) return "";
    if (imagePath.indexOf("http") === 0) return imagePath;
    try {
      return new URL(imagePath, window.location.href).href;
    } catch (e) {
      return imagePath;
    }
  }

  function publishFacebook(text) {
    var m = getConfig().meta;
    return apiPost("/publish/facebook", {
      pageId: m.pageId,
      accessToken: m.pageAccessToken,
      message: text
    });
  }

  function publishInstagram(text, imagePath) {
    var m = getConfig().meta;
    var imageUrl = resolveImageUrl(imagePath);
    if (!imageUrl || imageUrl.indexOf("http") !== 0) {
      return Promise.reject(new Error("Instagram wymaga publicznego URL grafiki (https://…)"));
    }
    return apiPost("/publish/instagram", {
      igAccountId: m.igAccountId,
      accessToken: m.pageAccessToken,
      caption: text,
      imageUrl: imageUrl
    });
  }

  function publishLinkedIn(text, imagePath) {
    var li = getConfig().linkedin;
    return apiPost("/publish/linkedin", {
      accessToken: li.accessToken,
      authorUrn: li.authorUrn,
      text: text,
      imageUrl: imagePath ? resolveImageUrl(imagePath) : ""
    });
  }

  function publishToplatform(platform, item) {
    var text = item.text || "";
    var image = item.image || "";
    if (platform === "fb") return publishFacebook(text);
    if (platform === "ig") return publishInstagram(text, image);
    if (platform === "li") return publishLinkedIn(text, image);
    return Promise.reject(new Error("Nieobsługiwana platforma"));
  }

  function testProxy() {
    var base = proxyBase();
    if (!base) return Promise.reject(new Error("Brak URL proxy"));
    return fetch(base + "/health").then(function (res) {
      return res.json();
    }).then(function (data) {
      if (!data.ok) throw new Error("Proxy nie odpowiada");
      return data;
    });
  }

  function renderIntegrationsHTML() {
    var cfg = getConfig();
    var st = getConnectionStatus();
    function dot(ok) {
      return '<span class="int-status-dot' + (ok ? " ok" : "") + '"></span>';
    }

    return (
      '<div class="integrations">' +
        '<div class="integrations-intro">' +
          '<strong>Publikacja przez API</strong> — podłącz konta i wrzucaj posty na Facebook, Instagram i LinkedIn. ' +
          'Uruchom lokalnie: <code>node publish-server.mjs</code> w folderze Panel/.' +
        '</div>' +
        '<div class="integrations-grid">' +
          '<section class="integrations-card">' +
            '<h2 class="integrations-card-title">Serwer proxy</h2>' +
            '<p class="integrations-card-desc">Omija ograniczenia CORS przeglądarki. Domyślnie port 8787.</p>' +
            '<div class="int-field">' +
              '<label class="int-label" for="int-proxy">URL proxy</label>' +
              '<input class="int-input" id="int-proxy" value="' + escapeHtml(cfg.proxyUrl) + '" placeholder="http://localhost:8787">' +
            '</div>' +
            '<div class="int-btn-row">' +
              '<button type="button" class="int-btn" id="int-test-proxy">Test połączenia</button>' +
            '</div>' +
            '<div class="int-msg" id="int-proxy-msg"></div>' +
          '</section>' +
          '<section class="integrations-card">' +
            '<h2 class="integrations-card-title">' + dot(st.facebook) + ' Meta (Facebook + Instagram)</h2>' +
            '<p class="integrations-card-desc">Token strony z Meta Developer · uprawnienia: pages_manage_posts, instagram_content_publish</p>' +
            '<div class="int-field"><label class="int-label" for="int-meta-app">App ID (opcjonalnie)</label>' +
              '<input class="int-input" id="int-meta-app" value="' + escapeHtml(cfg.meta.appId) + '"></div>' +
            '<div class="int-field"><label class="int-label" for="int-meta-page">Page ID</label>' +
              '<input class="int-input" id="int-meta-page" value="' + escapeHtml(cfg.meta.pageId) + '"></div>' +
            '<div class="int-field"><label class="int-label" for="int-meta-token">Page Access Token</label>' +
              '<input class="int-input" id="int-meta-token" type="password" value="' + escapeHtml(cfg.meta.pageAccessToken) + '" placeholder="EAAG…"></div>' +
            '<div class="int-field"><label class="int-label" for="int-meta-ig">Instagram Business Account ID</label>' +
              '<input class="int-input" id="int-meta-ig" value="' + escapeHtml(cfg.meta.igAccountId) + '"></div>' +
          '</section>' +
          '<section class="integrations-card">' +
            '<h2 class="integrations-card-title">' + dot(st.linkedin) + ' LinkedIn</h2>' +
            '<p class="integrations-card-desc">Token z LinkedIn Developer · scope: w_member_social · author URN np. urn:li:person:ABC</p>' +
            '<div class="int-field"><label class="int-label" for="int-li-token">Access Token</label>' +
              '<input class="int-input" id="int-li-token" type="password" value="' + escapeHtml(cfg.linkedin.accessToken) + '"></div>' +
            '<div class="int-field"><label class="int-label" for="int-li-urn">Author URN</label>' +
              '<input class="int-input" id="int-li-urn" value="' + escapeHtml(cfg.linkedin.authorUrn) + '" placeholder="urn:li:person:…"></div>' +
          '</section>' +
        '</div>' +
        '<div class="int-btn-row">' +
          '<button type="button" class="int-btn int-btn-primary" id="int-save">Zapisz integracje</button>' +
        '</div>' +
        '<div class="int-msg" id="int-save-msg"></div>' +
      '</div>'
    );
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function collectConfigFromDOM() {
    return {
      proxyUrl: (document.getElementById("int-proxy") || {}).value || DEFAULT_CONFIG.proxyUrl,
      meta: {
        appId: (document.getElementById("int-meta-app") || {}).value || "",
        pageId: (document.getElementById("int-meta-page") || {}).value || "",
        pageAccessToken: (document.getElementById("int-meta-token") || {}).value || "",
        igAccountId: (document.getElementById("int-meta-ig") || {}).value || ""
      },
      linkedin: {
        accessToken: (document.getElementById("int-li-token") || {}).value || "",
        authorUrn: (document.getElementById("int-li-urn") || {}).value || ""
      }
    };
  }

  function bindIntegrationsEvents(showToast) {
    var saveBtn = document.getElementById("int-save");
    var testBtn = document.getElementById("int-test-proxy");
    var saveMsg = document.getElementById("int-save-msg");
    var proxyMsg = document.getElementById("int-proxy-msg");

    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        saveConfig(collectConfigFromDOM());
        if (saveMsg) {
          saveMsg.textContent = "Zapisano. Tokeny trzymane lokalnie w przeglądarce.";
          saveMsg.className = "int-msg ok";
        }
        if (showToast) showToast("Integracje zapisane");
      });
    }

    if (testBtn) {
      testBtn.addEventListener("click", function () {
        saveConfig(collectConfigFromDOM());
        if (proxyMsg) {
          proxyMsg.textContent = "Sprawdzam proxy…";
          proxyMsg.className = "int-msg";
        }
        testProxy().then(function () {
          if (proxyMsg) {
            proxyMsg.textContent = "Proxy działa — możesz publikować posty.";
            proxyMsg.className = "int-msg ok";
          }
        }).catch(function (err) {
          if (proxyMsg) {
            proxyMsg.textContent = err.message + " — uruchom: node publish-server.mjs";
            proxyMsg.className = "int-msg err";
          }
        });
      });
    }
  }

  function renderPublishButtons(item) {
    var st = getConnectionStatus();
    var platforms = item.platforms || [];
    var buttons = [];
    var canPub = global.PostManager ? global.PostManager.canPublish(item) : true;
    var pending = getPendingPlatforms(item);

    if (platforms.indexOf("fb") !== -1 && st.facebook) {
      var fbDone = (item.publishedPlatforms || []).indexOf("fb") !== -1;
      buttons.push(
        '<button type="button" class="publish-btn publish-btn--fb" data-publish="fb"' +
        (fbDone ? " disabled" : "") + (canPub ? "" : " disabled") + ">" +
        (fbDone ? "Opublikowano na Facebook" : "Opublikuj na Facebook") + "</button>"
      );
    }
    if (platforms.indexOf("ig") !== -1 && st.instagram) {
      var igDone = (item.publishedPlatforms || []).indexOf("ig") !== -1;
      buttons.push(
        '<button type="button" class="publish-btn publish-btn--ig" data-publish="ig"' +
        (igDone ? " disabled" : "") + (canPub ? "" : " disabled") + ">" +
        (igDone ? "Opublikowano na Instagram" : "Opublikuj na Instagram") + "</button>"
      );
    }
    if (platforms.indexOf("li") !== -1 && st.linkedin) {
      var liDone = (item.publishedPlatforms || []).indexOf("li") !== -1;
      buttons.push(
        '<button type="button" class="publish-btn publish-btn--li" data-publish="li"' +
        (liDone ? " disabled" : "") + (canPub ? "" : " disabled") + ">" +
        (liDone ? "Opublikowano na LinkedIn" : "Opublikuj na LinkedIn") + "</button>"
      );
    }

    var checklist = global.PostManager
      ? global.PostManager.renderChecklistHTML(item)
      : "";

    if (!buttons.length) {
      return (
        checklist +
        '<div class="detail-publish">' +
          '<div class="detail-text-label">Publikacja</div>' +
          '<p class="detail-publish-hint">Skonfiguruj integracje (Facebook / Instagram / LinkedIn), aby publikować stąd posty.</p>' +
        '</div>'
      );
    }

    return (
      checklist +
      '<div class="detail-publish">' +
        '<div class="detail-text-label">Publikacja API</div>' +
        (pending.length > 1 && canPub
          ? '<button type="button" class="publish-btn publish-btn--all" data-publish-all>Opublikuj wszędzie (' + pending.length + ")</button>"
          : "") +
        '<div class="publish-btns">' + buttons.join("") + '</div>' +
        '<div class="publish-status" id="publish-status"></div>' +
      '</div>'
    );
  }

  function publishAllPlatforms(item) {
    var pending = getPendingPlatforms(item);
    return pending.reduce(function (chain, platform) {
      return chain.then(function (results) {
        return publishToplatform(platform, item).then(function (data) {
          if (global.PostManager) {
            global.PostManager.markPlatformPublished(item.id, platform, item);
          }
          results.push({ platform: platform, ok: true, id: data.id });
          return results;
        }).catch(function (err) {
          results.push({ platform: platform, ok: false, error: err.message });
          return results;
        });
      });
    }, Promise.resolve([]));
  }

  function getPendingPlatforms(item) {
    var st = getConnectionStatus();
    return (item.platforms || []).filter(function (p) {
      if ((item.publishedPlatforms || []).indexOf(p) !== -1) return false;
      if (p === "fb") return st.facebook;
      if (p === "ig") return st.instagram;
      if (p === "li") return st.linkedin;
      return false;
    });
  }

  function platformName(code) {
    return code === "fb" ? "Facebook" : code === "ig" ? "Instagram" : code === "li" ? "LinkedIn" : code;
  }

  function bindPublishEvents(item, showToast, onPublished) {
    var publishAllBtn = document.querySelector("[data-publish-all]");
    if (publishAllBtn) {
      publishAllBtn.addEventListener("click", function () {
        if (global.PostManager && !global.PostManager.canPublish(item)) {
          if (showToast) showToast("Uzupełnij checklistę przed publikacją");
          return;
        }
        var status = document.getElementById("publish-status");
        publishAllBtn.disabled = true;
        document.querySelectorAll("[data-publish]").forEach(function (b) { b.disabled = true; });
        if (status) {
          status.textContent = "Publikuję na wszystkich platformach…";
          status.className = "publish-status";
        }
        publishAllPlatforms(item).then(function (results) {
          var ok = results.filter(function (r) { return r.ok; }).length;
          var total = results.length;
          item.publishedPlatforms = item.publishedPlatforms || [];
          results.forEach(function (r) {
            if (r.ok && item.publishedPlatforms.indexOf(r.platform) === -1) {
              item.publishedPlatforms.push(r.platform);
            }
          });
          var lines = results.map(function (r) {
            return platformName(r.platform) + ": " + (r.ok ? "OK" : r.error);
          });
          if (status) {
            status.innerHTML = "Wynik: " + ok + "/" + total + "<br>" + lines.join("<br>");
            status.className = ok === total ? "publish-status ok" : "publish-status err";
          }
          if (showToast) showToast("Publikacja: " + ok + "/" + total);
          if (onPublished) onPublished(item.id);
        }).catch(function (err) {
          publishAllBtn.disabled = false;
          if (status) {
            status.textContent = err.message;
            status.className = "publish-status err";
          }
        });
      });
    }

    document.querySelectorAll("[data-publish]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.disabled) return;
        if (global.PostManager && !global.PostManager.canPublish(item)) {
          if (showToast) showToast("Uzupełnij checklistę przed publikacją");
          return;
        }
        var platform = btn.getAttribute("data-publish");
        var status = document.getElementById("publish-status");
        btn.disabled = true;
        if (status) {
          status.textContent = "Publikuję…";
          status.className = "publish-status";
        }
        publishToplatform(platform, item).then(function (data) {
          if (global.PostManager) {
            global.PostManager.markPlatformPublished(item.id, platform, item);
            item.publishedPlatforms = item.publishedPlatforms || [];
            if (item.publishedPlatforms.indexOf(platform) === -1) {
              item.publishedPlatforms.push(platform);
            }
          }
          if (onPublished) onPublished(item.id, platform);
          if (status) {
            status.textContent = "Opublikowano pomyślnie" + (data.id ? " · ID: " + data.id : "");
            status.className = "publish-status ok";
          }
          if (showToast) showToast("Post opublikowany");
          btn.textContent = "Opublikowano na " + (platform === "fb" ? "Facebook" : platform === "ig" ? "Instagram" : "LinkedIn");
        }).catch(function (err) {
          btn.disabled = false;
          if (status) {
            status.textContent = err.message;
            status.className = "publish-status err";
          }
          if (showToast) showToast("Błąd publikacji");
        });
      });
    });
  }

  global.SocialAPI = {
    getConfig: getConfig,
    saveConfig: saveConfig,
    getConnectionStatus: getConnectionStatus,
    publishToplatform: publishToplatform,
    publishAllPlatforms: publishAllPlatforms,
    testProxy: testProxy,
    renderIntegrationsHTML: renderIntegrationsHTML,
    bindIntegrationsEvents: bindIntegrationsEvents,
    renderPublishButtons: renderPublishButtons,
    bindPublishEvents: bindPublishEvents
  };
})(window);
