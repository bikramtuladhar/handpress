/* The site's own script. Two jobs: render the data file, and load the editor for editors. */
(function () {
  function render() {
    var d = window.BAKERY || {};
    var list = document.querySelector('[data-markets]');
    if (list) {
      list.innerHTML = (d.markets || []).map(function (m) {
        return '<li><strong>' + m.day + '</strong> · ' + m.place + ' · ' + m.hours + '</li>';
      }).join('');
    }
  }
  render();
  window.renderSite = render;

  // How the editor fits this site (README → Hooks). Harmless for visitors: only editor.js reads it.
  window.EDITOR_HOOKS = {
    // The markets list is drawn from data.js: handles on each market, and "+ Add".
    dataRegions: [['[data-markets]', 'data.js', 'markets', 'Markets']],
    // Redraw from unsaved edits, so they show before Save.
    dataChanged: function (path, obj) { if (path === 'data.js') { window.BAKERY = obj; render(); } },
    guide: {
      'index.html': [
        ['The headline and the text under it: click and type.', 'h1'],
        ['Products: hover a card to duplicate, move or remove it. Click a picture to replace it.', '.cards'],
        ['Markets come from data.js: “+ Add”, or the handles on each market.', '[data-markets]']
      ]
    }
  };
})();
