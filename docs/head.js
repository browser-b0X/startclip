// Runs before the first paint, so the page does not flash its finished state before the load sequence.
(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var root = document.documentElement;
  root.classList.add('seq');
  // If site.js never arrives, show the finished page.
  setTimeout(function () {
    if (!window.startclipSite) root.classList.remove('seq');
  }, 2000);
})();
