// Instructional illustration library for the module player. Clean, flat SVG
// diagrams in a consistent "referee manual" style — accurate for the mechanic
// (flag angles, card height, field position) rather than stock photos. Theme-aware
// via the player's CSS vars. A block names one with `graphic: "<key>"`; when no key
// matches, the renderer falls back to a captioned frame instead of blank space.
(function (root) {
  var NS = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 140" preserveAspectRatio="xMidYMid meet" class="gmr-svg"';
  // shared pieces
  var turf = '<rect x="1.5" y="1.5" width="237" height="137" rx="12" fill="rgba(46,175,109,.10)" stroke="rgba(46,175,109,.28)"/>'
    + '<line x1="1.5" y1="110" x2="238.5" y2="110" stroke="rgba(46,175,109,.30)" stroke-width="1.5"/>';
  function wrap(inner) { return '<svg ' + NS + '>' + turf + inner + '</svg>'; }
  // a simple referee figure at (x). Head + torso (dark kit). armsInner is extra SVG.
  function ref(x, armsInner) {
    return '<g stroke="var(--ink)" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">'
      + '<circle cx="' + x + '" cy="40" r="9" fill="var(--ink)"/>'
      + '<path d="M' + x + ' 49 L' + x + ' 86" fill="none"/>'                      // spine
      + '<path d="M' + (x - 13) + ' 110 L' + x + ' 86 L' + (x + 13) + ' 110" fill="none"/>' // legs
      + (armsInner || '')
      + '</g>';
  }
  // a flag (pole from px,py at angle deg, length L) — red/gold AR check
  function flag(px, py, deg, L) {
    var r = deg * Math.PI / 180, tx = px + Math.cos(r) * L, ty = py - Math.sin(r) * L;
    // flag triangle hangs off the top
    var fx = Math.cos(r), fy = -Math.sin(r), perp = { x: -fy, y: fx };
    var a = { x: tx, y: ty };
    var b = { x: tx - fx * 26 + perp.x * 14, y: ty - fy * 26 + perp.y * 14 };
    var c = { x: tx - fx * 26, y: ty - fy * 26 };
    var mid = { x: (a.x + c.x) / 2 + perp.x * 7, y: (a.y + c.y) / 2 + perp.y * 7 };
    return '<line x1="' + px + '" y1="' + py + '" x2="' + tx + '" y2="' + ty + '" stroke="var(--ink)" stroke-width="3.4" stroke-linecap="round"/>'
      + '<polygon points="' + a.x + ',' + a.y + ' ' + b.x + ',' + b.y + ' ' + c.x + ',' + c.y + '" fill="var(--accent)"/>'
      + '<polygon points="' + a.x + ',' + a.y + ' ' + mid.x + ',' + mid.y + ' ' + c.x + ',' + c.y + '" fill="var(--gold)"/>';
  }
  function arrow(x1, y1, x2, y2, col) {
    var ang = Math.atan2(y2 - y1, x2 - x1), h = 9;
    var l = { x: x2 - h * Math.cos(ang - 0.5), y: y2 - h * Math.sin(ang - 0.5) };
    var r = { x: x2 - h * Math.cos(ang + 0.5), y: y2 - h * Math.sin(ang + 0.5) };
    return '<g stroke="' + (col || 'var(--brand)') + '" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round">'
      + '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"/>'
      + '<polyline points="' + l.x + ',' + l.y + ' ' + x2 + ',' + y2 + ' ' + r.x + ',' + r.y + '"/></g>';
  }
  function whistle(x, y) {
    return '<g transform="translate(' + x + ',' + y + ')"><circle cx="0" cy="0" r="9" fill="none" stroke="var(--ink-soft)" stroke-width="3"/>'
      + '<rect x="6" y="-6" width="16" height="12" rx="3" fill="none" stroke="var(--ink-soft)" stroke-width="3"/>'
      + '<circle cx="0" cy="0" r="2.4" fill="var(--ink-soft)"/></g>';
  }
  function card(x, y, w, h, kind, rot) {
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="3" transform="rotate(' + (rot || 0) + ' ' + (x + w / 2) + ' ' + (y + h / 2) + ')" fill="' + (kind === 'red' ? 'var(--accent)' : 'var(--gold)') + '" stroke="var(--ink)" stroke-width="2"/>';
  }

  var G = {
    // Referee awards a free kick, no card in hand: whistle + direction arrow + crossed-out card.
    'free-kick': wrap(ref(70, '<path d="M70 58 L96 40" fill="none"/>' /* raised arm */)
      + arrow(100, 44, 168, 30, 'var(--brand)')
      + whistle(92, 92)
      + '<g transform="translate(150,78)">' + card(0, 0, 22, 30, 'yellow') + '<line x1="-6" y1="36" x2="28" y2="-6" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/></g>'),
    // Card shown correctly — held high and still.
    'card-high': wrap(ref(96, '<path d="M96 58 L120 24" fill="none"/>') + card(120, 10, 24, 32, 'yellow', 8)
      + arrow(170, 60, 170, 22, 'var(--success)')),
    'card-high-red': wrap(ref(96, '<path d="M96 58 L120 24" fill="none"/>') + card(120, 10, 24, 32, 'red', 8)
      + arrow(170, 60, 170, 22, 'var(--success)')),
    // Card too low (at the waist) — the wrong mechanic.
    'card-low': wrap(ref(110, '<path d="M110 70 L128 78" fill="none"/>') + card(128, 66, 22, 30, 'yellow', 6)
      + '<text x="120" y="128" text-anchor="middle" font-size="0" fill="transparent">low</text>'),
    // Card pushed into a player's face — too aggressive.
    'card-face': wrap(ref(74, '<path d="M74 56 L104 46" fill="none"/>') + card(104, 34, 22, 28, 'yellow', 0)
      + '<circle cx="150" cy="44" r="10" fill="none" stroke="var(--ink)" stroke-width="3"/><path d="M150 54 L150 86 M137 108 L150 86 L163 108" stroke="var(--ink)" stroke-width="3" fill="none" stroke-linecap="round"/>'),
    // Card shown inside a cluster of players — no isolation.
    'card-group': wrap('<g stroke="var(--ink)" stroke-width="2.6" fill="none">'
      + '<circle cx="70" cy="58" r="8"/><circle cx="104" cy="52" r="8"/><circle cx="92" cy="74" r="8"/><circle cx="130" cy="66" r="8"/><circle cx="150" cy="50" r="8"/></g>'
      + card(100, 24, 20, 26, 'yellow', -6)),
    // AR flag raised straight up, held still.
    'flag-up': wrap(ref(74, '<path d="M74 56 L96 44" fill="none"/>') + flag(96, 44, 90, 34) + arrow(150, 100, 150, 46, 'var(--brand)')),
    // AR flag up with a slight wave to catch the eye.
    'flag-wave': wrap(ref(74, '<path d="M74 56 L96 44" fill="none"/>') + flag(96, 44, 90, 34)
      + '<path d="M128 40 q10 -6 0 -14 M134 52 q14 -8 0 -20" fill="none" stroke="var(--brand)" stroke-width="2.4" stroke-linecap="round"/>'),
    // Flag indicating direction of the restart (~45°).
    'flag-direction': wrap(ref(70, '<path d="M70 56 L92 44" fill="none"/>') + flag(92, 44, 40, 42) + arrow(120, 54, 176, 30, 'var(--brand)')),
    // Flag lowered — defer to the referee.
    'flag-down': wrap(ref(80, '<path d="M80 60 L102 74" fill="none"/>') + flag(102, 74, -18, 34)
      + '<path d="M150 40 h34 M150 40 l10 -8 M150 40 l10 8" stroke="var(--ink-soft)" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".7"/>'),
    // Eye contact between referee and AR before the signal is read.
    'eye-contact': wrap('<circle cx="64" cy="54" r="11" fill="var(--ink)"/><circle cx="176" cy="54" r="11" fill="var(--ink)"/>'
      + '<line x1="78" y1="56" x2="162" y2="56" stroke="var(--brand)" stroke-width="2.4" stroke-dasharray="5 5"/>'
      + '<g transform="translate(120,56)"><path d="M-14 0 q14 -12 28 0 q-14 12 -28 0z" fill="none" stroke="var(--brand)" stroke-width="2.6"/><circle cx="0" cy="0" r="4" fill="var(--brand)"/></g>'),
    // Two players squaring up — confrontation during a stoppage.
    'confrontation': wrap('<g stroke="var(--ink)" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round">'
      + '<circle cx="86" cy="42" r="9" fill="var(--ink)"/><path d="M86 51 L86 84 M74 104 L86 84 L98 104 M86 62 L108 56"/>'
      + '<circle cx="154" cy="42" r="9" fill="var(--ink)"/><path d="M154 51 L154 84 M142 104 L154 84 L166 104 M154 62 L132 56"/></g>'
      + '<path d="M116 46 l8 -6 M124 46 l-8 -6" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/>'),
    // Substitutes on the bench.
    'bench': wrap('<rect x="56" y="78" width="128" height="10" rx="3" fill="var(--ink-soft)"/>'
      + '<line x1="66" y1="88" x2="66" y2="104" stroke="var(--ink-soft)" stroke-width="5"/><line x1="174" y1="88" x2="174" y2="104" stroke="var(--ink-soft)" stroke-width="5"/>'
      + '<g stroke="var(--ink)" stroke-width="3" fill="var(--ink)"><circle cx="86" cy="58" r="8"/><circle cx="120" cy="58" r="8"/><circle cx="154" cy="58" r="8"/></g>'
      + '<g stroke="var(--ink)" stroke-width="3" fill="none"><path d="M86 66 L86 78 M120 66 L120 78 M154 66 L154 78"/></g>'),
    // A side-on challenge for the ball.
    'challenge-side': wrap('<g stroke="var(--ink)" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round">'
      + '<circle cx="80" cy="40" r="9" fill="var(--ink)"/><path d="M80 49 L80 80 L62 100 M80 80 L100 92 M80 60 L62 54"/>'
      + '<circle cx="156" cy="40" r="9" fill="var(--ink)"/><path d="M156 49 L150 80 L168 100 M150 80 L128 96 M156 60 L174 54"/></g>'
      + '<circle cx="118" cy="104" r="8" fill="none" stroke="var(--ink)" stroke-width="2.4"/><path d="M112 104 h12 M118 98 v12" stroke="var(--ink)" stroke-width="1.6"/>'),
    // Field position: AR on the touchline, referee on the diagonal.
    'field-position': wrap('<rect x="40" y="18" width="160" height="104" rx="4" fill="none" stroke="rgba(46,175,109,.55)" stroke-width="2"/>'
      + '<line x1="120" y1="18" x2="120" y2="122" stroke="rgba(46,175,109,.55)" stroke-width="2"/><circle cx="120" cy="70" r="16" fill="none" stroke="rgba(46,175,109,.55)" stroke-width="2"/>'
      + '<circle cx="196" cy="34" r="6" fill="var(--accent)"/><text x="196" y="52" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="700" fill="var(--accent)">AR</text>'
      + '<circle cx="96" cy="92" r="6" fill="var(--brand)"/><text x="96" y="110" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="700" fill="var(--brand)">R</text>'
      + '<line x1="196" y1="18" x2="196" y2="122" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 4"/>'),
    // A lone whistle.
    'whistle': wrap('<g transform="translate(96,56) scale(2.2)">' + whistle(0, 0) + '</g>'),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = G;
  root.GMR_GRAPHICS = G;
})(typeof window !== 'undefined' ? window : this);
