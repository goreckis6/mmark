/**
 * Content System — klient auth (token + API fetch)
 */
(function (global) {
  "use strict";

  var TOKEN_KEY = "content-system-auth-token";
  var USER_KEY = "content-system-auth-user";

  function getAppBase() {
    var path = global.location.pathname;
    if (path === "/Panel" || path.indexOf("/Panel/") === 0) return "/Panel";
    return "";
  }

  function getLoginUrl() {
    return getAppBase() + "/login.html";
  }

  function getHomeUrl() {
    return getAppBase() + "/";
  }

  function getApiBase() {
    if (global.BrandKit) {
      var fromBrand = (global.BrandKit.getUploadProxy() || "").replace(/\/$/, "");
      if (fromBrand) return fromBrand;
    }
    if (global.location.protocol === "file:") return "http://localhost:8787";
    if (global.location.port === "8080") return "http://localhost:8787";
    return global.location.origin.replace(/\/$/, "");
  }

  function detectAuthRequired() {
    return fetch(getApiBase() + "/health", { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) return false;
        return res.json();
      })
      .then(function (data) {
        return !!(data && data.auth);
      })
      .catch(function () { return false; });
  }

  function isServerMode() {
    return global.location.protocol !== "file:";
  }

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user || {}));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function getUser() {
    try {
      var raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function apiFetch(path, options) {
    options = options || {};
    var headers = Object.assign({ Accept: "application/json" }, options.headers || {});
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    var token = getToken();
    if (token) headers.Authorization = "Bearer " + token;

    return fetch(getApiBase() + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && path !== "/auth/login") {
          clearSession();
          if (isServerMode() && !/login\.html$/i.test(global.location.pathname)) {
            global.location.href = getLoginUrl();
          }
        }
        if (!res.ok) {
          var err = new Error((data && data.error) || ("HTTP " + res.status));
          err.status = res.status;
          if (res.status === 404 && path.indexOf("/auth/") === 0) {
            err.message = "API niedostępne (404). W Hostingerze: Node.js → startup file: server.js, redeploy.";
          }
          throw err;
        }
        return data;
      });
    });
  }

  function login(username, password) {
    return apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: username, password: password })
    }).then(function (data) {
      setSession(data.token, data.user);
      return data;
    });
  }

  function logout() {
    return apiFetch("/auth/logout", { method: "POST" }).catch(function () { /* ignore */ })
      .finally(function () {
        clearSession();
        global.location.href = getLoginUrl();
      });
  }

  function requireAuth(options) {
    options = options || {};
    var redirect = options.redirect !== false;
    if (!getToken()) {
      if (redirect && isServerMode() && !/login\.html$/i.test(global.location.pathname)) {
        global.location.href = getLoginUrl();
      }
      return Promise.reject(new Error("redirect"));
    }
    return apiFetch("/auth/me").then(function (data) {
      setSession(getToken(), data.user);
      return data.user;
    }).catch(function (err) {
      if (redirect && err.message !== "redirect" && isServerMode()) {
        global.location.href = getLoginUrl();
      }
      throw err;
    });
  }

  global.AuthClient = {
    getAppBase: getAppBase,
    getLoginUrl: getLoginUrl,
    getHomeUrl: getHomeUrl,
    getApiBase: getApiBase,
    isServerMode: isServerMode,
    detectAuthRequired: detectAuthRequired,
    getToken: getToken,
    getUser: getUser,
    login: login,
    logout: logout,
    requireAuth: requireAuth,
    apiFetch: apiFetch
  };
})(window);
