// Smooth page-to-page transitions. Loaded as a classic script in <head> so the
// view-transition events are hooked before the page first renders.
//
// Browsers with cross-document View Transitions (Chrome/Edge 126+, Safari 18.2+)
// animate natively (see css/motion.css); others get a quick fade out/in.
(function () {
  var supportsViewTransitions = "onpagereveal" in window;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Page "depth" decides the slide direction: sign-in < map < settings.
  var DEPTH = { "": 0, "index.html": 0, "map.html": 1, "settings.html": 2, "issues.html": 2 };
  function depth(url) {
    var page = new URL(url, location.href).pathname.split("/").pop();
    return DEPTH[page] !== undefined ? DEPTH[page] : 0;
  }
  function transitionType(from, to) {
    var a = depth(from);
    var b = depth(to);
    if (a === 0 || b === 0) return "fade"; // to/from sign-in: cross-fade
    return b > a ? "forward" : b < a ? "back" : "fade";
  }

  if (supportsViewTransitions) {
    window.addEventListener("pageswap", function (e) {
      var to = e.viewTransition && e.activation && e.activation.entry && e.activation.entry.url;
      if (to) e.viewTransition.types.add(transitionType(location.href, to));
    });
    window.addEventListener("pagereveal", function (e) {
      var from = window.navigation && navigation.activation && navigation.activation.from;
      if (e.viewTransition && from && from.url) e.viewTransition.types.add(transitionType(from.url, location.href));
    });
  } else {
    document.documentElement.classList.add("no-vt");
    // Coming back via the back button: don't stay faded out.
    window.addEventListener("pageshow", function () {
      document.documentElement.classList.remove("page-leaving");
    });
  }

  // Use for in-app navigations instead of location.href / location.replace.
  window.ppNavigate = function (url, options) {
    var replace = options && options.replace;
    function go() {
      if (replace) location.replace(url);
      else location.assign(url);
    }
    if (supportsViewTransitions || reduceMotion) return go();
    document.documentElement.classList.add("page-leaving");
    setTimeout(go, 170);
  };

  // Plain links between app pages get the fallback fade too.
  if (!supportsViewTransitions) {
    document.addEventListener("click", function (e) {
      var link = e.target.closest && e.target.closest("a[href]");
      if (!link || link.target || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var url = new URL(link.href, location.href);
      if (url.origin !== location.origin || !/(\/|\.html)$/.test(url.pathname)) return;
      e.preventDefault();
      window.ppNavigate(url.href);
    });
  }
})();
