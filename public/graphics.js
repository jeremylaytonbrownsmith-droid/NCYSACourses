// Instructional illustration library for the module player. Flat-design referee
// characters in the IFAB "Laws of the Game" style — slate head with hair, a
// coloured kit, trousers, hands and a ground shadow — drawn on a consistent light
// plate (the .gmr-fig / .fig frame) so they read the same in light and dark pages.
// Fixed colours (not theme vars) for that reason. A block names one with
// `graphic: "<key>"`; with no match the renderer shows a captioned frame instead.
(function (root) {
  var NS = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 140" preserveAspectRatio="xMidYMid meet" class="gmr-svg"';
  var C = {
    ink: '#222a33', grey: '#5c6672', hair: '#79838f', skin: '#e7c49f',
    shirt: '#1f3b73', shirtD: '#13284f', pants: '#3c4651', shoe: '#232a32',
    shadow: '#cfd6de', red: '#d0342c', yel: '#f3c01c', green: '#1f9d5b', steel: '#8a97a4',
  };
  function wrap(inner) { return '<svg ' + NS + '>' + inner + '</svg>'; }
  function shadow(cx) { return '<ellipse cx="' + cx + '" cy="121" rx="25" ry="5" fill="' + C.shadow + '"/>'; }
  // An arm (shirt sleeve + skin hand) from a shoulder to a hand point.
  function arm(x1, y1, x2, y2, shirt) {
    shirt = shirt || C.shirt;
    return '<path d="M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2 + '" stroke="' + shirt + '" stroke-width="9" stroke-linecap="round" fill="none"/>'
      + '<circle cx="' + x2 + '" cy="' + y2 + '" r="4.4" fill="' + C.skin + '"/>';
  }
  // A standing flat-design figure centred at cx, with its resting (near) arm down.
  // The signalling arm is added per graphic with arm().
  function figure(cx, shirt) {
    shirt = shirt || C.shirt;
    var shY = 47, hipY = 80, headY = 27;
    return shadow(cx)
      // trousers + shoes
      + '<path d="M' + (cx - 3) + ' ' + (hipY - 2) + ' L' + (cx - 10) + ' 114" stroke="' + C.pants + '" stroke-width="12" stroke-linecap="round" fill="none"/>'
      + '<path d="M' + (cx + 3) + ' ' + (hipY - 2) + ' L' + (cx + 10) + ' 114" stroke="' + C.pants + '" stroke-width="12" stroke-linecap="round" fill="none"/>'
      + '<ellipse cx="' + (cx - 12) + '" cy="116" rx="7" ry="4" fill="' + C.shoe + '"/>'
      + '<ellipse cx="' + (cx + 12) + '" cy="116" rx="7" ry="4" fill="' + C.shoe + '"/>'
      // shirt torso
      + '<path d="M' + (cx - 14) + ' ' + shY + ' Q' + cx + ' ' + (shY - 7) + ' ' + (cx + 14) + ' ' + shY + ' L' + (cx + 12) + ' ' + (hipY + 1) + ' Q' + cx + ' ' + (hipY + 7) + ' ' + (cx - 12) + ' ' + (hipY + 1) + ' Z" fill="' + shirt + '"/>'
      // resting (near) arm
      + '<path d="M' + (cx - 12) + ' ' + (shY + 3) + ' L' + (cx - 17) + ' ' + (hipY - 6) + '" stroke="' + shirt + '" stroke-width="9" stroke-linecap="round" fill="none"/>'
      + '<circle cx="' + (cx - 17) + '" cy="' + (hipY - 4) + '" r="4.3" fill="' + C.skin + '"/>'
      // collar + chest pocket
      + '<path d="M' + (cx - 5) + ' ' + (shY + 1) + ' L' + cx + ' ' + (shY + 9) + ' L' + (cx + 5) + ' ' + (shY + 1) + '" fill="none" stroke="' + C.shirtD + '" stroke-width="2.2"/>'
      + '<rect x="' + (cx + 2) + '" y="' + (shY + 11) + '" width="7" height="8" rx="1" fill="none" stroke="' + C.shirtD + '" stroke-width="1.5"/>'
      // neck, head, hair
      + '<rect x="' + (cx - 4) + '" y="' + (headY + 8) + '" width="8" height="9" fill="' + C.skin + '"/>'
      + '<circle cx="' + cx + '" cy="' + headY + '" r="12" fill="' + C.grey + '"/>'
      + '<path d="M' + (cx - 12) + ' ' + (headY - 1) + ' Q' + cx + ' ' + (headY - 17) + ' ' + (cx + 12) + ' ' + (headY - 1) + ' Q' + cx + ' ' + (headY - 7) + ' ' + (cx - 12) + ' ' + (headY - 1) + ' Z" fill="' + C.hair + '"/>';
  }
  // small seated/standing head used in clusters
  function head(cx, cy, r) { r = r || 9; return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + C.grey + '"/><path d="M' + (cx - r) + ' ' + (cy - 1) + ' Q' + cx + ' ' + (cy - r - 5) + ' ' + (cx + r) + ' ' + (cy - 1) + ' Q' + cx + ' ' + (cy - 5) + ' ' + (cx - r) + ' ' + (cy - 1) + ' Z" fill="' + C.hair + '"/>'; }
  function flag(px, py, deg, L) {
    var r = deg * Math.PI / 180, tx = px + Math.cos(r) * L, ty = py - Math.sin(r) * L;
    var fx = Math.cos(r), fy = -Math.sin(r), perp = { x: -fy, y: fx };
    var a = { x: tx, y: ty }, b = { x: tx - fx * 26 + perp.x * 15, y: ty - fy * 26 + perp.y * 15 }, c = { x: tx - fx * 26, y: ty - fy * 26 };
    var mid = { x: (a.x + c.x) / 2 + perp.x * 7.5, y: (a.y + c.y) / 2 + perp.y * 7.5 };
    return '<line x1="' + px + '" y1="' + py + '" x2="' + tx + '" y2="' + ty + '" stroke="' + C.ink + '" stroke-width="3.4" stroke-linecap="round"/>'
      + '<polygon points="' + a.x + ',' + a.y + ' ' + b.x + ',' + b.y + ' ' + c.x + ',' + c.y + '" fill="' + C.red + '"/>'
      + '<polygon points="' + a.x + ',' + a.y + ' ' + mid.x + ',' + mid.y + ' ' + c.x + ',' + c.y + '" fill="' + C.yel + '"/>';
  }
  function arrow(x1, y1, x2, y2, col) {
    col = col || C.shirt; var ang = Math.atan2(y2 - y1, x2 - x1), h = 10;
    var l = { x: x2 - h * Math.cos(ang - 0.5), y: y2 - h * Math.sin(ang - 0.5) }, r = { x: x2 - h * Math.cos(ang + 0.5), y: y2 - h * Math.sin(ang + 0.5) };
    return '<g stroke="' + col + '" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"/><polyline points="' + l.x + ',' + l.y + ' ' + x2 + ',' + y2 + ' ' + r.x + ',' + r.y + '"/></g>';
  }
  function card(x, y, kind, rot) {
    return '<rect x="' + x + '" y="' + y + '" width="22" height="30" rx="3" transform="rotate(' + (rot || 0) + ' ' + (x + 11) + ' ' + (y + 15) + ')" fill="' + (kind === 'red' ? C.red : C.yel) + '" stroke="' + C.ink + '" stroke-width="2"/>';
  }
  function whistle(x, y, s) {
    s = s || 1;
    return '<g transform="translate(' + x + ',' + y + ') scale(' + s + ')"><circle cx="0" cy="0" r="9" fill="none" stroke="' + C.grey + '" stroke-width="3.2"/><rect x="6" y="-6" width="16" height="12" rx="3" fill="none" stroke="' + C.grey + '" stroke-width="3.2"/><circle cx="0" cy="0" r="2.4" fill="' + C.grey + '"/></g>';
  }

  var G = {
    // Referee awards a free kick, no card in hand.
    'free-kick': wrap(figure(70) + arm(82, 49, 148, 32) + arrow(150, 32, 200, 16)
      + whistle(86, 26, 0.8)
      + '<g transform="translate(40,80)">' + card(0, 0, 'yellow') + '<line x1="-5" y1="34" x2="27" y2="-4" stroke="' + C.red + '" stroke-width="4" stroke-linecap="round"/></g>'),
    // Card shown correctly — held high and still.
    'card-high': wrap(figure(92) + arm(104, 49, 130, 24) + card(120, 6, 'yellow', 10) + arrow(182, 58, 182, 22, C.green)),
    'card-high-red': wrap(figure(92) + arm(104, 49, 130, 24) + card(120, 6, 'red', 10) + arrow(182, 58, 182, 22, C.green)),
    // Card too low (at the waist) — the wrong mechanic.
    'card-low': wrap(figure(108) + arm(120, 56, 138, 73) + card(130, 62, 'yellow', 6)),
    // Card pushed into a player's face — too aggressive.
    'card-face': wrap(figure(72) + arm(84, 50, 110, 46) + card(106, 33, 'yellow', 0)
      + figure(154, '#b23b3b')),
    // Card shown inside a cluster of players — no isolation.
    'card-group': wrap(head(66, 60) + head(104, 54) + head(90, 80) + head(132, 70) + head(150, 54) + card(96, 20, 'yellow', -6)),
    // AR flag raised straight up, held still.
    'flag-up': wrap(figure(74) + arm(86, 49, 98, 32) + flag(98, 32, 90, 34) + arrow(152, 100, 152, 50)),
    // AR flag up with a slight wave to catch the eye.
    'flag-wave': wrap(figure(74) + arm(86, 49, 98, 32) + flag(98, 32, 90, 34)
      + '<path d="M130 30 q11 -6 0 -15 M136 44 q15 -8 0 -22" fill="none" stroke="' + C.shirt + '" stroke-width="2.6" stroke-linecap="round"/>'),
    // Flag indicating direction of the restart (~45°).
    'flag-direction': wrap(figure(70) + arm(82, 50, 104, 40) + flag(104, 40, 42, 40) + arrow(126, 52, 182, 28)),
    // Flag lowered — defer to the referee.
    'flag-down': wrap(figure(80) + arm(92, 56, 108, 74) + flag(108, 74, -16, 32)
      + '<path d="M152 40 h34 M152 40 l10 -8 M152 40 l10 8" stroke="' + C.steel + '" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
    // Eye contact between referee and AR before the signal is read.
    'eye-contact': wrap(head(60, 56, 13) + head(180, 56, 13)
      + '<line x1="78" y1="58" x2="162" y2="58" stroke="' + C.shirt + '" stroke-width="2.6" stroke-dasharray="5 5"/>'
      + '<g transform="translate(120,58)"><path d="M-15 0 q15 -13 30 0 q-15 13 -30 0z" fill="#fff" stroke="' + C.shirt + '" stroke-width="2.6"/><circle cx="0" cy="0" r="4.5" fill="' + C.shirt + '"/></g>'),
    // Two players squaring up — confrontation during a stoppage.
    'confrontation': wrap(figure(82, '#2a4c8f') + figure(158, '#b23b3b')
      + arm(92, 52, 116, 60, '#2a4c8f') + arm(148, 52, 124, 60, '#b23b3b')
      + '<path d="M115 40 l9 -8 M124 40 l-9 -8" stroke="' + C.red + '" stroke-width="3.6" stroke-linecap="round"/>'),
    // Substitutes on the bench.
    'bench': wrap('<rect x="48" y="92" width="144" height="9" rx="3" fill="' + C.steel + '"/>'
      + '<rect x="58" y="101" width="7" height="15" rx="2" fill="' + C.steel + '"/><rect x="175" y="101" width="7" height="15" rx="2" fill="' + C.steel + '"/>'
      + [80, 120, 160].map(function (x) { return '<rect x="' + (x - 11) + '" y="64" width="22" height="30" rx="7" fill="' + C.shirt + '"/>' + head(x, 50, 10); }).join('')),
    // A side-on challenge for the ball.
    'challenge-side': wrap(figure(74, '#2a4c8f') + figure(162, '#b23b3b')
      + arm(84, 58, 104, 92, '#2a4c8f') + arm(152, 58, 132, 92, '#b23b3b')
      + '<circle cx="118" cy="104" r="9" fill="#fff" stroke="' + C.ink + '" stroke-width="2.4"/><path d="M111 104 h14 M118 97 v14" stroke="' + C.ink + '" stroke-width="1.5"/>'),
    // Field position: AR on the touchline, referee on the diagonal.
    'field-position': wrap('<rect x="36" y="20" width="168" height="100" rx="4" fill="#eef4ef" stroke="#9bbfa6" stroke-width="2"/>'
      + '<line x1="120" y1="20" x2="120" y2="120" stroke="#9bbfa6" stroke-width="2"/><circle cx="120" cy="70" r="16" fill="none" stroke="#9bbfa6" stroke-width="2"/>'
      + '<line x1="196" y1="20" x2="196" y2="120" stroke="' + C.red + '" stroke-width="1.5" stroke-dasharray="4 4"/>'
      + '<circle cx="196" cy="34" r="6" fill="' + C.red + '"/><text x="196" y="52" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="700" fill="' + C.red + '">AR</text>'
      + '<circle cx="96" cy="92" r="6" fill="' + C.shirt + '"/><text x="96" y="110" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="700" fill="' + C.shirt + '">R</text>'),
    // A lone whistle.
    'whistle': wrap(whistle(104, 60, 2.3)),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = G;
  root.GMR_GRAPHICS = G;
})(typeof window !== 'undefined' ? window : this);
