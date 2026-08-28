// NCSRA 2026 Recertification Refresher Course — our tool delivering Step 3 of
// the NCSRA referee recertification: four no-skip refresher videos, each followed
// by a short "Laws Check" (2–3 questions the referee answers by consulting the
// 2026/27 Laws of the Game and the NCYSA Law 3 policy update — NOT the video), a
// certificate, and a dashboard record NCSRA can verify against.
//
// Fully code-managed: ensureCourse (server.js) keeps this course — settings AND
// lessons — in sync with this file on each deploy. Manage its content here.
//
// Questions are drawn from the IFAB Laws of the Game 2026/27 new-law protocols and
// the hosted NCYSA "Law 3 – Time-Limited Substitution Protocol" policy update. The
// topic→video mapping is a first pass — reorder once we know each video's content.
const LAWS_DOCS = 'the <strong>2026/27 Laws of the Game</strong> and the <strong>NCYSA Law 3 policy update</strong> (both linked in “Start Here”)';
const checkIntro =
  '<p><strong>Heads up:</strong> these answers are <strong>not in the video.</strong> They come from ' +
  LAWS_DOCS + ' — have them handy and look them up.</p>';

// Each Laws Check: real questions from the documents.
const CHECKS = {
  1: [ // Law 3 — Time-Limited Substitutions (IFAB + NCYSA policy)
    { id: 'sub-seconds', prompt: 'Under the 2026/27 time-limited substitution protocol, a substituted player must leave the field of play within how many seconds?', options: ['5 seconds', '10 seconds', '15 seconds', '30 seconds'], answer: 1 },
    { id: 'sub-reentry', prompt: 'If a substituted player unnecessarily delays and exceeds the time limit, when may the incoming substitute enter?', options: ['Immediately', 'At the next throw-in', 'At the first stoppage after one minute has elapsed following the restart, with the referee’s permission', 'Not for the rest of the match'], answer: 2 },
    { id: 'ncysa-count', prompt: 'In NCYSA Classic League matches, if a player is exiting normally and not delaying, should the referee start the 10-second count?', options: ['Yes, always', 'No — the count is only for an unnecessary delay', 'Only in the second half', 'Only if the coach asks'], answer: 1 },
  ],
  2: [ // Laws 15 & 16 — Throw-in / Goal-kick Countdown
    { id: 'countdown-seconds', prompt: 'The throw-in and goal-kick countdown protocol is based on a countdown of how many seconds?', options: ['3 seconds', '5 seconds', '8 seconds', '10 seconds'], answer: 1 },
    { id: 'countdown-signal', prompt: 'How does the referee signal the countdown?', options: ['Silently, with no signal', 'By blowing the whistle and visually counting down from five with a raised hand', 'By showing a yellow card', 'By starting a stopwatch'], answer: 1 },
    { id: 'countdown-result', prompt: 'If the ball is not in play at the end of the throw-in countdown, what does the referee award?', options: ['A throw-in to the opposing team', 'A dropped ball', 'A corner kick to the throwing team', 'An indirect free kick'], answer: 0 },
  ],
  3: [ // Law 5 Off-field treatment + Concussion substitutions
    { id: 'offfield-minute', prompt: 'Under the off-field treatment and assessment protocol, an outfield player treated off the field must remain off for how long after the restart?', options: ['30 seconds', 'One minute (running clock)', 'Two minutes', 'Until half-time'], answer: 1 },
    { id: 'concussion-count', prompt: 'How many permanent “concussion substitutes” is each team permitted in a match?', options: ['None', 'One', 'Two', 'Unlimited'], answer: 1 },
    { id: 'concussion-opponent', prompt: 'When a team uses a concussion substitute, what does the opposing team receive?', options: ['Nothing', 'The option to use an additional substitute', 'A penalty kick', 'An extra timeout'], answer: 1 },
  ],
  4: [ // 'Only the captain' + NCYSA exit location
    { id: 'captain-approach', prompt: 'Under the “only the captain” guidelines, which player is permitted to approach the referee to discuss a major decision?', options: ['Any player', 'Only the team captain', 'Only the goalkeeper', 'The head coach'], answer: 1 },
    { id: 'captain-keeper', prompt: 'When the goalkeeper is the captain, by when must the referee be told which player will approach on the goalkeeper’s behalf?', options: ['At half-time', 'No later than the coin toss before kick-off', 'After the first goal', 'It isn’t required'], answer: 1 },
    { id: 'ncysa-exit', prompt: 'In NCYSA Classic matches, substituted players must exit the field at which location (and a delay from this is not a violation of the count)?', options: ['The nearest boundary point', 'At midfield or near their team bench', 'Behind the goal', 'Anywhere they choose'], answer: 1 },
  ],
  5: [ // Law 12 — Goalkeeper holding the ball (8-second protocol)
    { id: 'gk-seconds', prompt: 'Under the current protocol, for how many seconds may a goalkeeper control the ball with the hand(s) before it must be released into play?', options: ['6 seconds', '8 seconds', '10 seconds', '12 seconds'], answer: 1 },
    { id: 'gk-signal', prompt: 'How does the referee warn the goalkeeper that time is running out?', options: ['By blowing the whistle once', 'By raising an arm and visually counting down the final five seconds', 'By showing a yellow card', 'There is no warning'], answer: 1 },
    { id: 'gk-sanction', prompt: 'If the goalkeeper exceeds the time limit, what does the referee now award to the opposing team?', options: ['An indirect free kick', 'A corner kick', 'A penalty kick', 'A dropped ball'], answer: 1 },
  ],
};

const VIDEOS = [
  { part: 1, url: 'https://dl.dropboxusercontent.com/scl/fi/uqbt7dpimoj99mpjstydn/2026-NCSRA-Part-1-compressed.mp4?rlkey=va2fb7nu2jgjn5xkfh90qvp0c' },
  { part: 2, url: 'https://dl.dropboxusercontent.com/scl/fi/22k64a0fi0hq2ykfbjb82/2026-NCSRA-Part-2-compressed.mp4?rlkey=41tamhcemrh5vbp1pb306vigd' },
  { part: 3, url: 'https://dl.dropboxusercontent.com/scl/fi/1wbw72f01hcfl68l9n2mo/2026-NCSRA-Part-3-compressed.mp4?rlkey=i9smgemvzrg6jon5x1cyhup0y' },
  { part: 4, url: 'https://dl.dropboxusercontent.com/scl/fi/1qvlh4w2dv3h11vpxmwy4/2026-NCSRA-Part-4-compressed.mp4?rlkey=0jw2anqcl8kawky7u4ezps94u' },
  { part: 5, url: 'https://dl.dropboxusercontent.com/scl/fi/04jjvljdq05dx51krvro5/2026-NCSRA-Part-5-compressed.mp4?rlkey=jt5ke5wfxnggu736gyu1henav' },
];

const lessons = [
  {
    id: 'welcome',
    type: 'text',
    title: 'Start Here — How the Refresher Works',
    html:
      '<h2>2026 NCSRA Recertification Refresher</h2>' +
      '<p>Welcome. This is the <strong>Refresher Course — Step 3</strong> of your 2026 referee ' +
      'recertification. It’s in <strong>four short parts</strong>. For each part you’ll:</p>' +
      '<ul>' +
      '<li><strong>Use the same email you use for Arbiter</strong> so your completion lines up with your referee record.</li>' +
      '<li><strong>Watch the video in full</strong> — no skipping ahead.</li>' +
      '<li><strong>Answer a short Laws Check.</strong> These questions are <strong>not in the video</strong> — ' +
      'they confirm you’ve reviewed this year’s law changes. Keep the documents below handy and look them up.</li>' +
      '</ul>' +
      '<h3>Reference documents</h3>' +
      '<ul>' +
      '<li><a href="/docs/NCYSA-Law3-Policy-Update.pdf" target="_blank" rel="noopener">NCYSA — Law 3 Time-Limited Substitution Protocol (policy update)</a></li>' +
      '<li><a href="https://www.theifab.com/laws-of-the-game-documents/" target="_blank" rel="noopener">IFAB — Laws of the Game 2026/27</a></li>' +
      '</ul>' +
      '<p>When you finish all four parts you’ll receive a certificate and your completion is recorded here for NCSRA. ' +
      'Then complete your remaining recertification steps and email NCSRA to confirm.</p>' +
      '<p>Ready? Click <strong>Complete &amp; continue</strong> to begin.</p>',
  },
];
for (const v of VIDEOS) {
  lessons.push({
    id: `part${v.part}-video`,
    type: 'video',
    title: `Part ${v.part} — Refresher Video`,
    html: `<p>Watch Part ${v.part} in full. The <strong>Complete &amp; continue</strong> button unlocks once you’ve watched it to the end.</p>`,
    videoUrl: v.url, // Dropbox direct-file link; watch requirement auto-adapts to the real length.
    durationSeconds: 600, // nominal fallback; real length auto-detected on play
    minWatchSeconds: 594,
  });
  lessons.push({
    id: `part${v.part}-check`,
    type: 'quiz',
    title: `Part ${v.part} — Laws Check`,
    html: checkIntro,
    passPercent: 80,
    questions: CHECKS[v.part],
  });
}

module.exports = {
  id: 'ncsra-referee-2026-part-1', // keep — this id is in the link already shared
  title: '2026 NCSRA Recertification Refresher',
  tagline: 'Step 3 of your 2026 referee recertification.',
  description:
    'The 2026 NCSRA Recertification Refresher — Step 3 of your referee recertification, in four short ' +
    'parts. Sign in with the same email you use for Arbiter, watch each part in full, and complete a ' +
    'short Laws Check after each (answers found in the 2026/27 Laws of the Game and the NCYSA Law 3 ' +
    'policy update, not the video). Your completion is recorded here (with a certificate) for NCSRA.',
  badge: 'Recertification',
  audience: 'referees',
  coBrandName: 'NCSRA Referee Education',
  coLogoUrl: 'https://static.wixstatic.com/media/b61df5_3dd41adc219e426ababb5fc5728475e2~mv2.png',
  certOrg: 'North Carolina Soccer Referee Association',
  certTitle: 'Certificate of Recertification Training',
  certPrefix: 'NCSRA',
  estMinutes: 60,
  heroEmoji: '🟨',
  published: true,
  publicVideoGate: false,
  completionRedirectUrl: '',
  completionNote:
    'You’ve completed the 2026 NCSRA Recertification Refresher (Step 3). Finish your remaining ' +
    'recertification steps, then email NCSRA Administrator Erick Varone to confirm — your completion ' +
    'is on record here for verification.',
  lessons,
};
