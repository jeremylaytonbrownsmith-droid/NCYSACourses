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
    // Solid filled silhouette (IFAB Laws-of-the-Game style): chunky round-capped
    // limbs + a filled torso and head read as a real figure, not a thin stick.
    return '<g stroke="var(--ink)" stroke-width="9.5" stroke-linecap="round" stroke-linejoin="round" fill="none">'
      + '<circle cx="' + x + '" cy="29" r="12" fill="var(--ink)" stroke="none"/>'                 // head
      + '<path d="M' + x + ' 44 L' + x + ' 74" stroke-width="20"/>'                                // torso (wide)
      + '<path d="M' + x + ' 74 L' + (x - 12) + ' 105"/>'                                          // left leg
      + '<path d="M' + x + ' 74 L' + (x + 12) + ' 105"/>'                                          // right leg
      + (armsInner || '')
      + '</g>';
  }
  // filled head + trunk at (cx) with its head centered at headY — for extra figures
  function body(cx, headY, color) {
    color = color || 'var(--ink)';
    return '<circle cx="' + cx + '" cy="' + headY + '" r="11" fill="' + color + '" stroke="none"/>'
      + '<path d="M' + cx + ' ' + (headY + 13) + ' L' + cx + ' ' + (headY + 42) + '" stroke="' + color + '" stroke-width="19" stroke-linecap="round" fill="none"/>';
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
      + body(152, 40, 'var(--ink-soft)') + '<path d="M152 82 L142 106 M152 82 L162 106" stroke="var(--ink-soft)" stroke-width="8.5" fill="none" stroke-linecap="round"/>'),
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
    'confrontation': wrap(body(88, 32) + body(152, 32)
      + '<g stroke="var(--ink)" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M88 74 L78 104 M88 74 L98 104 M90 52 L114 60"/>'
      + '<path d="M152 74 L142 104 M152 74 L162 104 M150 52 L126 60"/></g>'
      + '<path d="M116 42 l9 -8 M125 42 l-9 -8" stroke="var(--accent)" stroke-width="3.6" stroke-linecap="round"/>'),
    // Substitutes on the bench.
    'bench': wrap('<rect x="56" y="78" width="128" height="10" rx="3" fill="var(--ink-soft)"/>'
      + '<line x1="66" y1="88" x2="66" y2="104" stroke="var(--ink-soft)" stroke-width="5"/><line x1="174" y1="88" x2="174" y2="104" stroke="var(--ink-soft)" stroke-width="5"/>'
      + '<g stroke="var(--ink)" stroke-width="3" fill="var(--ink)"><circle cx="86" cy="58" r="8"/><circle cx="120" cy="58" r="8"/><circle cx="154" cy="58" r="8"/></g>'
      + '<g stroke="var(--ink)" stroke-width="3" fill="none"><path d="M86 66 L86 78 M120 66 L120 78 M154 66 L154 78"/></g>'),
    // A side-on challenge for the ball.
    'challenge-side': wrap(body(76, 34) + body(160, 34)
      + '<g stroke="var(--ink)" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M76 78 L64 102 M76 78 L104 92 M78 54 L60 60"/>'
      + '<path d="M160 78 L172 102 M160 78 L132 92 M158 54 L176 60"/></g>'
      + '<circle cx="118" cy="98" r="9" fill="#fff" stroke="var(--ink)" stroke-width="2.6"/><path d="M111 98 h14 M118 91 v14" stroke="var(--ink)" stroke-width="1.5"/>'),
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
