// NCSRA 2026 Recertification Refresher Course — our tool delivering Step 3 of
// the NCSRA referee recertification (the ~1-hour refresher that otherwise lives
// on Brainshark): a no-skip training video, a short comprehension check, a
// certificate, and a dashboard record NCSRA can verify against.
//
// Fully code-managed: ensureCourse (server.js) keeps this course — settings AND
// lessons — in sync with this file on each deploy, so changes here reliably reach
// the live course. Manage its content here rather than in the Course Designer.
module.exports = {
  id: 'ncsra-referee-2026-part-1', // keep — this id is in the link already shared
  title: '2026 NCSRA Recertification Refresher',
  tagline: 'Step 3 of your 2026 referee recertification.',
  description:
    'The 2026 NCSRA Recertification Refresher — Step 3 of your referee recertification. ' +
    'Sign in with the same email you use for Arbiter, watch the refresher in full, and complete a ' +
    'short comprehension check. Your completion is recorded here (with a certificate) for NCSRA to verify.',
  badge: 'Recertification',
  audience: 'referees',
  // Co-branding shown ONLY on this course (the rest of the site stays "NCYSA Learn").
  coBrandName: 'NCSRA Referee Education',
  coLogoUrl: 'https://static.wixstatic.com/media/b61df5_3dd41adc219e426ababb5fc5728475e2~mv2.png',
  // Certificate wording/branding for this course (referees shouldn't get an NCYSA cert).
  certOrg: 'North Carolina Soccer Referee Association',
  certTitle: 'Certificate of Recertification Training',
  certPrefix: 'NCSRA', // certificate IDs read NCSRA-… for this course
  estMinutes: 30,
  heroEmoji: '🟨',
  published: true,
  // FULL experience: referees take the whole course (video + questions +
  // certificate) with a completion recorded on the dashboard, then complete their
  // remaining recert steps and email NCSRA to confirm. (The no-login
  // video→Brainshark redirect flow still exists in the code — set
  // publicVideoGate:true and completionRedirectUrl to a Brainshark URL to switch.)
  publicVideoGate: false,
  completionRedirectUrl: '',
  completionNote:
    'You’ve completed the 2026 NCSRA Recertification Refresher (Step 3). Finish your remaining ' +
    'recertification steps, then email NCSRA Administrator Erick Varone to confirm — your completion ' +
    'is on record here for verification.',
  lessons: [
    {
      id: 'welcome',
      type: 'text',
      title: 'Start Here — How the Refresher Works',
      html:
        '<h2>2026 NCSRA Recertification Refresher</h2>' +
        '<p>Welcome. This is the <strong>Refresher Course — Step 3</strong> of your 2026 referee ' +
        'recertification. It takes just a few minutes:</p>' +
        '<ul>' +
        '<li><strong>Use the same email you use for Arbiter</strong> so your completion lines up with ' +
        'your referee record.</li>' +
        '<li><strong>Watch the refresher video in full</strong> — you can’t skip ahead, and the ' +
        '“continue” button unlocks once you’ve watched it through.</li>' +
        '<li><strong>Answer a short comprehension check</strong> to confirm you covered the material.</li>' +
        '</ul>' +
        '<p>When you finish, you’ll receive a certificate and your completion is recorded here for NCSRA. ' +
        'Then complete your remaining recertification steps and email NCSRA to confirm.</p>' +
        '<p>Ready? Click <strong>Complete &amp; continue</strong> to begin.</p>',
    },
    {
      id: 'part1-video',
      type: 'video',
      title: 'Refresher Video',
      html: '<p>Watch the full refresher below. The <strong>Complete &amp; continue</strong> button unlocks once you’ve watched it to the end.</p>',
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
      title: 'Comprehension Check',
      html: '<p>Answer the questions to confirm you completed the refresher. You can retake it if needed.</p>',
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
