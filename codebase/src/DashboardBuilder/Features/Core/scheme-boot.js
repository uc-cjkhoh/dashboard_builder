// Classic script in <head>: sets <html data-scheme> before the first paint so a dark choice never
// flashes light. Mirrors Core/scheme-model.js normalizePref (tests/js/scheme.test.mjs keeps them in
// step); Core/scheme.js takes over once the modules load.
(function () {
  var pref = null;
  try { pref = localStorage.getItem("dashboardbuilder.scheme"); } catch (e) { /* storage blocked — Light */ }
  if (pref !== "light" && pref !== "dark") pref = "light";
  document.documentElement.setAttribute("data-scheme", pref);
})();
