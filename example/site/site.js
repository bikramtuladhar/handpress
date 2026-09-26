/* The site's own script. Two jobs: render the data file, and load the editor for editors. */
(function () {
  var d = window.BAKERY || {};
  var list = document.querySelector('[data-markets]');
  if (list && (d.markets || []).length) {
    list.innerHTML = d.markets.map(function (m) {
      return '<li><strong>' + m.day + '</strong> · ' + m.place + ' · ' + m.hours + '</li>';
    }).join('');
  }

  // The editor is loaded only for signed in editors: the "ed" cookie is set by /api/login.
  if (/(?:^|;\s*)ed=1/.test(document.cookie)) {
    var s = document.createElement('script');
    s.src = '/editor.js';
    s.defer = true;
    document.head.appendChild(s);
  }
})();
