// Classic script in <head>: sets <html data-scheme> before the first paint so a dark choice never
// flashes light. Mirrors Core/scheme-model.js resolveScheme (tests/js/scheme.test.mjs keeps them in
// step); Core/scheme.js takes over once the modules load.
(function () {
  var pref = null;
  try { pref = localStorage.getItem("dashboardbuilder.scheme"); } catch (e) { /* storage blocked — follow the OS */ }
  if (pref !== "light" && pref !== "dark") pref = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("data-scheme", pref);
})();
