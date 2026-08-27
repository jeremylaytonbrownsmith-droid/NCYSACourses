// NCSRA referee pilot course — a working example that fulfills the request:
// a gated training video, a short completion check (quiz), and an automatic
// completion record + certificate. Added at startup if it doesn't already
// exist (see ensureCourse in server.js), so it deploys without wiping or
// overwriting anything an editor has already created. Safe to delete in the
// Course Designer once it's been reviewed.
module.exports = {
  id: 'ncsra-referee-2026-part-1',
  title: '2026 NCSRA Referee Course — Part 1',
  tagline: 'Required 2026 training for North Carolina soccer referees.',
  description:
    'Part 1 of the 2026 North Carolina State Referee Association course. Watch the training ' +
    'video in full, then pass a short check. Your completion is recorded automatically and you ' +
    'receive a certificate — no separate sign-off needed.',
  badge: 'Referee',
  audience: 'referees',
  // Co-branding shown ONLY on this course (the rest of the site stays "NCYSA Learn").
  coBrandName: 'NCYSA + NCSRA Learn',
  coLogoUrl: 'https://static.wixstatic.com/media/b61df5_3dd41adc219e426ababb5fc5728475e2~mv2.png',
  estMinutes: 15,
  heroEmoji: '🟨',
  published: true,
  // Public "watch & redirect" flow: referees open a link, watch the video (no
  // login, no skip, sound required), then are sent to the Brainshark
  // comprehension test — Brainshark credits their eligibility in Arbiter.
  publicVideoGate: true,
  // Where to send them when the video ends (the Brainshark test for this course;
  // editable per course in the Course Designer — each course has its own URL).
  completionRedirectUrl: 'https://www.brainshark.com/1/player/arbitersports?pi=zGwzPQFt3zDQjYz0&r3f1=3309772428257D6F3F7516747D36353432712F0E713776302E2C75711470227635282D3F',
  lessons: [
    {
      id: 'welcome',
      type: 'text',
      title: 'Welcome & How This Works',
      html:
        '<h2>Welcome, referees</h2>' +
        '<p>This is <strong>Part 1</strong> of the 2026 NCSRA referee training. Here’s how it works:</p>' +
        '<ul>' +
        '<li><strong>Watch the training video</strong> in full — you can’t skip ahead, and the ' +
        '“continue” button unlocks once you’ve watched it to the end.</li>' +
        '<li><strong>Pass a short 2-question check</strong> to confirm you completed the material.</li>' +
        '<li>Your <strong>completion is recorded automatically</strong> and you get a certificate — ' +
        'NCSRA can see who has finished.</li>' +
        '</ul>' +
        '<p>When you’re ready, click <strong>Complete &amp; continue</strong> to begin.</p>',
    },
    {
      id: 'part1-video',
      type: 'video',
      title: 'Training Video — 2026 NCSRA Part 1',
      html: '<p>Watch the full video below. The <strong>Complete &amp; continue</strong> button unlocks once you’ve watched it to the end.</p>',
      // Dropbox direct-file link (dl.dropboxusercontent.com serves the raw MP4 so
      // the no-skip player can stream and track it). The watch requirement adapts
      // to the video's real length automatically.
      videoUrl: 'https://dl.dropboxusercontent.com/scl/fi/uqbt7dpimoj99mpjstydn/2026-NCSRA-Part-1-compressed.mp4?rlkey=va2fb7nu2jgjn5xkfh90qvp0c',
      durationSeconds: 600, // nominal fallback; the real length is auto-detected on play
      minWatchSeconds: 594,
    },
    {
      id: 'part1-check',
      type: 'quiz',
      title: 'Completion Check',
      html: '<p>Answer both questions to confirm you completed Part 1. You can retake it if needed.</p>',
      passPercent: 80,
      questions: [
        {
          id: 'q1',
          prompt: 'North Carolina is the ______ largest state soccer association in the country.',
          options: ['Largest', 'Second', 'Third', 'Fifth'],
          answer: 2,
        },
        {
          id: 'q2',
          prompt: 'North Carolina soccer changed its registration and operating system to ______.',
          options: ['PlayMetrics', 'GotSport', 'Sports Connect', 'TeamSnap'],
          answer: 0,
        },
      ],
    },
  ],
};
