// Pages opened straight from disk (file://) can't run this app's scripts, so hand
// off to the local server, or explain how to start it if it isn't running.
(function () {
  if (location.protocol !== "file:") return;
  var page = location.pathname.split("/").pop() || "index.html";
  var server = "http://localhost:8000/";

  function explain() {
    document.title = "Start PeterParker";
    document.body.style.cssText = "margin:0;min-height:100vh;background:#f6f7fa";
    document.body.innerHTML =
      '<main style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem;color:#14182b">' +
      '<h1 style="font-size:1.5rem;margin:0 0 .5rem">The PeterParker server isn’t running</h1>' +
      "<p>This page needs the app server. In a terminal, from the project folder, run:</p>" +
      '<pre style="background:#f3f5fa;padding:.75rem 1rem;border-radius:8px">make dev</pre>' +
      '<p>Then open <a href="' + server + '" style="color:#4f6db8">' + server + "</a>. " +
      "This page will also open it automatically once the server is up.</p></main>";
  }

  function tryServer() {
    fetch("http://127.0.0.1:8000/api/health", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error(res.status);
        location.replace(server + (page === "index.html" ? "" : page));
      })
      .catch(function () {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", explain);
        else explain();
        setTimeout(tryServer, 3000);
      });
  }
  tryServer();
})();
