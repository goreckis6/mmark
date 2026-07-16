/**
 * Content System — Landing Page Scripts
 * Vanilla JS · IntersectionObserver · No dependencies
 */

(function () {
  "use strict";

  /* ── Header scroll state ── */
  var header = document.getElementById("header");
  if (header) {
    var onScroll = function () {
      header.classList.toggle("scrolled", window.scrollY > 20);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ── Mobile menu ── */
  var menuToggle = document.getElementById("menu-toggle");
  var mobileNav = document.getElementById("mobile-nav");
  var mobileLinks = mobileNav ? mobileNav.querySelectorAll(".mobile-nav__link") : [];

  function closeMobileNav() {
    if (!menuToggle || !mobileNav) return;
    menuToggle.setAttribute("aria-expanded", "false");
    mobileNav.classList.remove("open");
    mobileNav.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  function openMobileNav() {
    if (!menuToggle || !mobileNav) return;
    menuToggle.setAttribute("aria-expanded", "true");
    mobileNav.classList.add("open");
    mobileNav.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  if (menuToggle && mobileNav) {
    menuToggle.addEventListener("click", function () {
      var expanded = menuToggle.getAttribute("aria-expanded") === "true";
      expanded ? closeMobileNav() : openMobileNav();
    });

    mobileLinks.forEach(function (link) {
      link.addEventListener("click", closeMobileNav);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMobileNav();
    });
  }

  /* ── Scroll reveal (IntersectionObserver) ── */
  var revealEls = document.querySelectorAll(".reveal");
  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (prefersReduced) {
    revealEls.forEach(function (el) { el.classList.add("visible"); });
  } else if ("IntersectionObserver" in window) {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach(function (el) { revealObserver.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("visible"); });
  }

  /* ── Scrollspy (active nav link) ── */
  var sections = document.querySelectorAll("section[id]");
  var navLinks = document.querySelectorAll(".nav__link[data-section], .mobile-nav__link[data-section]");

  if ("IntersectionObserver" in window && sections.length) {
    var spyObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var id = entry.target.id;
            navLinks.forEach(function (link) {
              var match = link.getAttribute("data-section") === id;
              link.classList.toggle("active", match);
              if (match) link.setAttribute("aria-current", "true");
              else link.removeAttribute("aria-current");
            });
          }
        });
      },
      { threshold: 0.35, rootMargin: "-20% 0px -55% 0px" }
    );
    sections.forEach(function (section) { spyObserver.observe(section); });
  }

  /* ── Animated counters ── */
  var counters = document.querySelectorAll("[data-counter]");
  var countersDone = false;

  function animateCounter(el) {
    var target = parseInt(el.getAttribute("data-counter"), 10);
    var suffix = el.getAttribute("data-suffix") || "";
    var duration = 1800;
    var start = 0;
    var startTime = null;

    if (prefersReduced) {
      el.textContent = target + suffix;
      return;
    }

    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      var current = Math.floor(start + (target - start) * eased);
      el.textContent = current + suffix;
      if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }

  if (counters.length && "IntersectionObserver" in window) {
    var counterObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && !countersDone) {
            countersDone = true;
            counters.forEach(animateCounter);
            counterObserver.disconnect();
          }
        });
      },
      { threshold: 0.5 }
    );
    var heroStats = document.querySelector(".hero__stats");
    if (heroStats) counterObserver.observe(heroStats);
  }

  /* ── FAQ accordion — single open (optional UX) ── */
  var faqItems = document.querySelectorAll(".faq__item");
  faqItems.forEach(function (item) {
    item.addEventListener("toggle", function () {
      if (item.open) {
        faqItems.forEach(function (other) {
          if (other !== item && other.open) other.open = false;
        });
      }
    });
  });

  /* ── Contact form (client-side success, no fake submit) ── */
  var form = document.getElementById("contact-form");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      /* Optional: open mailto with form data */
      var name = form.querySelector('[name="name"]').value.trim();
      var email = form.querySelector('[name="email"]').value.trim();
      var message = form.querySelector('[name="message"]').value.trim();
      var subject = encodeURIComponent("Content System — prośba o demo");
      var body = encodeURIComponent(
        "Imię: " + name + "\nEmail: " + email + "\n\n" + message
      );

      /* Uncomment to enable mailto fallback:
      window.location.href = "mailto:hello@contentsystem.pl?subject=" + subject + "&body=" + body;
      */

      form.classList.add("is-success");
      var successEl = form.querySelector(".cta-form__success");
      if (successEl) {
        successEl.classList.add("visible");
        successEl.setAttribute("tabindex", "-1");
        successEl.focus();
      }
    });
  }

  /* ── Smooth anchor offset for fixed header ── */
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener("click", function (e) {
      var href = anchor.getAttribute("href");
      if (href === "#" || href.length < 2) return;
      var target = document.querySelector(href);
      if (!target) return;
      e.preventDefault();
      var offset = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--header-h"), 10) || 72;
      var top = target.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: top, behavior: prefersReduced ? "auto" : "smooth" });
    });
  });
})();
