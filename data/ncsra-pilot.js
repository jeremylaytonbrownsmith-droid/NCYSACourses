// NCSRA 2026 Recertification Refresher — our tool delivering Step 3 of the NCSRA
// referee recertification. The FULL course is ten no-skip refresher videos; the
// "Laws Check" quiz after a video is optional reinforcement (answers come from the
// 2026/27 Laws of the Game and the NCYSA Law 3 policy update — NOT the video),
// plus a certificate and a dashboard record NCSRA can verify against.
//
// PREVIEW MODE: for Erick Varone's review we surface only Part 1 (the link we
// shared) so he lands straight on the video, watches it, takes one short Laws
// Check, and reaches completion — without sitting through every video. Flip DEMO
// to false (and list the parts in VISIBLE_PARTS) to open the whole course.
//
// Fully code-managed: ensureCourse (server.js) keeps this course — settings AND
// lessons — in sync with this file on each deploy. Manage its content here.

// Preview: land on Part 1's video, one Laws Check, then completion. Parts 2-5 are
// authored below but hidden until we open the full course.
const DEMO = true;
const VISIBLE_PARTS = DEMO ? [1] : [1, 2, 3, 4, 5];

const DOC_LINKS =
  '<ul>' +
  '<li><a href="/docs/NCYSA-Law3-Policy-Update.pdf" target="_blank" rel="noopener">NCYSA — Law 3 Time-Limited Substitution Protocol (policy update)</a></li>' +
  '<li><a href="https://www.theifab.com/laws-of-the-game-documents/" target="_blank" rel="noopener">IFAB — Laws of the Game 2026/27</a></li>' +
  '</ul>';

const checkIntro =
  '<p><strong>Heads up:</strong> these answers are <strong>not in the video.</strong> They come from ' +
  'the <strong>NCYSA Law 3 policy update</strong> and the <strong>2026/27 Laws of the Game</strong> — ' +
  'have them handy and look them up. Miss one and you can retake it right away; you won’t be locked out.</p>' +
  '<h3>Reference documents</h3>' + DOC_LINKS;

// Each Laws Check: real questions from the documents.
const CHECKS = {
  1: [ // Law 3 — Time-Limited Substitutions (IFAB + NCYSA policy) — the preview quiz (5 Qs)
    { id: 'sub-seconds', prompt: 'Under the 2026/27 time-limited substitution protocol, a substituted player must leave the field of play within how many seconds?', options: ['5 seconds', '10 seconds', '15 seconds', '30 seconds'], answer: 1 },
    { id: 'sub-law', prompt: 'The time-limited substitution procedure is a change to which Law of the Game?', options: ['Law 3 — The Players', 'Law 5 — The Referee', 'Law 11 — Offside', 'Law 14 — The Penalty Kick'], answer: 0 },
    { id: 'sub-reentry', prompt: 'If a substituted player unnecessarily delays and exceeds the time limit, when may the incoming substitute enter?', options: ['Immediately', 'At the next throw-in', 'At the first stoppage after one minute has elapsed following the restart, with the referee’s permission', 'Not for the rest of the match'], answer: 2 },
    { id: 'ncysa-count', prompt: 'In NCYSA Classic League matches, if a player is exiting normally and not delaying, should the referee start the 10-second count?', options: ['Yes, always', 'No — the count is only for an unnecessary delay', 'Only in the second half', 'Only if the coach asks'], answer: 1 },
    { id: 'sub-purpose', prompt: 'What is the main purpose of the time-limited substitution protocol?', options: ['To speed up substitutions and reduce time-wasting', 'To allow unlimited substitutions', 'To eliminate substitutions', 'To give coaches extra timeouts'], answer: 0 },
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

// A short preview banner shown on the first video so a reviewer immediately
// understands this is one part of a ten-video platform.
const previewBanner = DEMO
  ? '<div style="border-left:4px solid #1f3a5f;background:#eef3fa;padding:12px 16px;border-radius:6px;margin:0 0 14px">' +
    '<p style="margin:0"><strong>Preview.</strong> You’re seeing <strong>Part 1</strong> — one of the ' +
    '<strong>10 refresher videos</strong> the full platform holds. Watch it in full, then take a short ' +
    'Laws Check to see how the whole experience works.</p></div>'
  : '';

const lessons = [];
if (!DEMO) {
  lessons.push({
    id: 'welcome',
    type: 'text',
    title: 'Start Here — How the Refresher Works',
    html:
      '<h2>2026 NCSRA Recertification Refresher</h2>' +
      '<p>Welcome. This is the <strong>Refresher Course — Step 3</strong> of your 2026 referee ' +
      'recertification. For each part you’ll:</p>' +
      '<ul>' +
      '<li><strong>Use the same email you use for Arbiter</strong> so your completion lines up with your referee record.</li>' +
      '<li><strong>Watch the video in full</strong> — no skipping ahead.</li>' +
      '<li><strong>Answer a short Laws Check</strong> (optional reinforcement). These questions are ' +
      '<strong>not in the video</strong> — keep the documents below handy and look them up.</li>' +
      '</ul>' +
      '<h3>Reference documents</h3>' + DOC_LINKS +
      '<p>When you finish you’ll receive a certificate and your completion is recorded here for NCSRA.</p>' +
      '<p>Ready? Click <strong>Complete &amp; continue</strong> to begin.</p>',
  });
}
for (const part of VISIBLE_PARTS) {
  const v = VIDEOS.find((x) => x.part === part);
  lessons.push({
    id: `part${part}-video`,
    type: 'video',
    title: `Part ${part} — Refresher Video`,
    html:
      previewBanner +
      `<p>Watch Part ${part} in full. The <strong>Complete &amp; continue</strong> button unlocks once you’ve watched it to the end.</p>` +
      '<h3>Reference documents (for the Laws Check that follows)</h3>' + DOC_LINKS,
    videoUrl: v.url, // Dropbox direct-file link; watch requirement auto-adapts to the real length.
    durationSeconds: 600, // nominal fallback; real length auto-detected on play
    minWatchSeconds: 594,
  });
  lessons.push({
    id: `part${part}-check`,
    type: 'quiz',
    title: `Part ${part} — Laws Check`,
    html: checkIntro,
    passPercent: 80, // miss one of five; unlimited immediate retakes
    questions: CHECKS[part],
  });
}

module.exports = {
  id: 'ncsra-referee-2026-part-1', // keep — this id is in the link already shared
  title: '2026 NCSRA Recertification Refresher',
  tagline: 'Step 3 of your 2026 referee recertification.',
  description:
    'The 2026 NCSRA Recertification Refresher — Step 3 of your referee recertification. Sign in with the ' +
    'same email you use for Arbiter, watch the refresher video(s) in full, and complete a short Laws ' +
    'Check (optional reinforcement; answers found in the 2026/27 Laws of the Game and the NCYSA Law 3 ' +
    'policy update, not the video). Your completion is recorded here, with a certificate, for NCSRA.',
  badge: 'Recertification',
  audience: 'referees',
  coBrandName: 'NCSRA Referee Education',
  coLogoUrl: 'https://static.wixstatic.com/media/b61df5_3dd41adc219e426ababb5fc5728475e2~mv2.png',
  certOrg: 'North Carolina Soccer Referee Association',
  certTitle: 'Certificate of Recertification Training',
  certPrefix: 'NCSRA',
  estMinutes: DEMO ? 15 : 60,
  heroEmoji: '🟨',
  published: true,
  publicVideoGate: false,
  completionRedirectUrl: '',
  completionNote:
    'That’s the preview. What you just experienced — a no-skip video, then a short Laws Check with ' +
    'instant grading, unlimited retakes, a certificate, and a completion recorded here for NCSRA to ' +
    'verify — is exactly how the full platform works. In the complete course, all 10 recertification ' +
    'videos live inside this platform for referees to watch. Advanced referees would simply watch all ' +
    '10 videos to recertify; the Laws Check is optional reinforcement we can turn on wherever NCSRA ' +
    'wants a knowledge check, and we can add a final test at the end if you’d like one. Every completion ' +
    'lands on the NCSRA dashboard so Erick can verify it at a glance.',
  lessons,
};
