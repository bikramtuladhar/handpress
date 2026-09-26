/* The site's own script. Two jobs: render the data file, and load the editor for editors. */
(function () {
  window.renderSite = render;
  function render() {
  var d = window.BAKERY || {};
  var list = document.querySelector('[data-markets]');
  if (list && (d.markets || []).length) {
    list.innerHTML = d.markets.map(function (m) {
      return '<li><strong>' + m.day + '</strong> · ' + m.place + ' · ' + m.hours + '</li>';
    }).join('');
  }
  }
  render();
})();
