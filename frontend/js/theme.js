// Light / dark mode. Loaded as a classic script in <head>, before the stylesheets
// paint, so pages never flash the wrong theme.
//
// The choice ("system", "light" or "dark") is a per-device preference kept in
// localStorage; "system" follows the device setting and updates live when it changes.
(function () {
  var KEY = "pp_theme";
  var root = document.documentElement;
  var media = window.matchMedia("(prefers-color-scheme: dark)");

  function preference() {
    try {
      var saved = localStorage.getItem(KEY);
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch (e) {
      return "system";
    }
  }

  function apply(pref) {
    var dark = pref === "dark" || (pref === "system" && media.matches);
    root.dataset.theme = dark ? "dark" : "light";
    root.style.colorScheme = dark ? "dark" : "light";
  }

  apply(preference());
  media.addEventListener("change", function () {
    if (preference() === "system") apply("system");
  });
  // Another tab changed it.
  window.addEventListener("storage", function (e) {
    if (e.key === KEY) apply(preference());
  });

  window.ppTheme = {
    get: preference,
    resolved: function () { return root.dataset.theme; },
    // Saves and applies a preference. `origin` ({x, y}) is where the change started,
    // e.g. the clicked button: the new theme spreads out from there as a circle.
    set: function (pref, origin) {
      try {
        if (pref === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, pref);
      } catch (e) { /* private mode: still applies for this page */ }
      var before = root.dataset.theme;
      var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      var willChange = (pref === "dark" || (pref === "system" && media.matches)) !== (before === "dark");
      if (!willChange || reduce || !document.startViewTransition) {
        apply(pref);
        return;
      }
      var x = origin ? origin.x : innerWidth / 2;
      var y = origin ? origin.y : innerHeight / 2;
      var radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.classList.add("theme-switching");
      var transition = document.startViewTransition(function () { apply(pref); });
      transition.ready.then(function () {
        root.animate(
          { clipPath: ["circle(0px at " + x + "px " + y + "px)", "circle(" + radius + "px at " + x + "px " + y + "px)"] },
          { duration: 520, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" },
        );
      });
      transition.finished.finally(function () { root.classList.remove("theme-switching"); });
    },
  };
})();
