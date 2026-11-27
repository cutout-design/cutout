'use strict';
// Loaded in <head>, before the stylesheet. (A file, not an inline script: the page's content
// security policy allows no inline scripts.)
// Apply the theme before the first paint (no flash). app.js keeps it updated afterwards.
(function () {
  var pref = 'system';
  try { pref = (JSON.parse(localStorage.getItem('cutout.prefs.v1') || '{}').theme) || 'system'; } catch (e) {}
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // Edge app windows color their title bar from theme-color — match Cutout's top bar.
  document.querySelector('meta[name="theme-color"]').content = dark ? '#2b2b2b' : '#ffffff';
})();
