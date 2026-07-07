// Course catalog. Content lives in code so it can be versioned and reviewed
// like everything else; a CMS/admin editor can replace this later.
//
// Lesson types:
//   text  – rich reading content (html)
//   video – gated video; learner must watch `minWatchSeconds` of real playback
//   quiz  – graded exam; must score >= passPercent to complete

module.exports = [
  {
    id: 'grassroots-coaching-license',
    title: 'NCYSA Grassroots Soccer Coaching License',
    tagline: 'The required entry-level license for every NCYSA youth coach.',
    description:
      'This course prepares new and returning volunteers to coach youth soccer in North Carolina. ' +
      'You will learn the role of the grassroots coach, how kids develop as players, how to keep every ' +
      'player safe, the laws of the small-sided game, and how to design a practice using the ' +
      'Play–Practice–Play model. The course ends with a graded final exam and an official ' +
      'certificate of completion.',
    badge: 'Coaching License',
    estMinutes: 45,
    heroEmoji: '⚽',
    lessons: [
      {
        id: 'welcome',
        type: 'text',
        title: 'Welcome & How This Course Works',
        html: `
          <h2>Welcome, Coach!</h2>
          <p>On behalf of the <strong>North Carolina Youth Soccer Association</strong>, thank you for
          stepping up to coach. Youth coaches are the single biggest influence on whether a child
          falls in love with the game — this course exists to set you (and your players) up for success.</p>
          <h3>How this course works</h3>
          <ul>
            <li>Lessons unlock <strong>in order</strong>. You must complete each lesson before the next one opens.</li>
            <li>The video lesson requires you to actually watch it — skipping ahead is disabled and
                you must watch nearly the entire video before you can continue.</li>
            <li>The course ends with a <strong>final exam</strong>. You need <strong>80%</strong> to pass.</li>
            <li>When you finish, you will receive a certificate, and NCYSA is automatically notified
                so your license can be recorded.</li>
          </ul>
          <p>Mark this lesson complete to begin.</p>`,
      },
      {
        id: 'role-of-coach',
        type: 'text',
        title: 'The Role of the Grassroots Coach',
        html: `
          <h2>Your Job Is Bigger Than Soccer</h2>
          <p>A grassroots coach wears four hats:</p>
          <ol>
            <li><strong>Safety officer</strong> — every player goes home healthy.</li>
            <li><strong>Environment builder</strong> — practices are fun, active, and welcoming.</li>
            <li><strong>Teacher of the game</strong> — small, age-appropriate lessons, not lectures.</li>
            <li><strong>Role model</strong> — players copy how you treat referees, opponents, and mistakes.</li>
          </ol>
          <h3>The 3 F's of grassroots soccer</h3>
          <p><strong>Fun. Freedom. Fair play.</strong> Kids quit organized sports primarily because it
          stops being fun. Your success is measured by how many of your players sign up again next season.</p>
          <blockquote>“Ask yourself after every practice: did every kid touch the ball a lot,
          smile a lot, and learn one thing?”</blockquote>`,
      },
      {
        id: 'player-development',
        type: 'text',
        title: 'Player Development & Age-Appropriate Training',
        html: `
          <h2>Coach the Kid in Front of You</h2>
          <p>Children are not miniature adults. Training must match their stage of development:</p>
          <h3>U6–U8: “Me and my ball”</h3>
          <ul><li>Maximum touches; every player has a ball.</li>
              <li>Games disguised as fun (tag, sharks &amp; minnows).</li>
              <li>Short attention spans — change activities every 5–8 minutes.</li></ul>
          <h3>U9–U12: “The golden age of learning”</h3>
          <ul><li>Skill acquisition peaks — dribbling, passing, receiving under light pressure.</li>
              <li>Small-sided games (4v4 to 7v7) maximize decisions and touches.</li></ul>
          <h3>U13+: “Training to compete”</h3>
          <ul><li>Introduce team shape, roles, and game-model concepts.</li>
              <li>Growth spurts affect coordination — be patient with temporary awkwardness.</li></ul>
          <p>Rule of thumb: in any activity, every player should be <strong>active more than 70% of the
          time</strong>. Lines, laps, and lectures are the enemies of development.</p>`,
      },
      {
        id: 'safety',
        type: 'text',
        title: 'Player Health, Safety & Risk Management',
        html: `
          <h2>Safety Is Non-Negotiable</h2>
          <h3>Before every session</h3>
          <ul>
            <li>Inspect the field: holes, glass, unanchored goals. <strong>Unanchored goals kill —
                never let players hang on goals.</strong></li>
            <li>Have your emergency action plan: phone, first-aid kit, and each player's emergency contact.</li>
          </ul>
          <h3>Heat &amp; hydration</h3>
          <ul><li>Mandatory water breaks at least every 20–30 minutes; more in summer.</li>
              <li>Know the signs of heat illness: cramps, dizziness, confusion, no sweating.</li></ul>
          <h3>Concussions — when in doubt, sit them out</h3>
          <p>Any player with a suspected head injury must be removed immediately and may not return
          the same day. Return to play requires written medical clearance. This is North Carolina law
          (the Gfeller-Waller Act) and NCYSA policy.</p>
          <h3>Safe environment</h3>
          <p>Follow the U.S. Soccer Safe Soccer framework: two-adult rule, observable and interruptible
          interactions, and mandatory reporting of suspected abuse. Complete your abuse-prevention
          training at the <a href="https://uscenterforsafesport.org/" target="_blank" rel="noopener">U.S.
          Center for SafeSport</a>.</p>`,
      },
      {
        id: 'laws',
        type: 'text',
        title: 'Laws of the Game for Small-Sided Play',
        html: `
          <h2>Small-Sided Games, Simplified Laws</h2>
          <table>
            <tr><th>Age</th><th>Format</th><th>Ball</th><th>Notes</th></tr>
            <tr><td>U6–U8</td><td>4v4, no GK</td><td>Size 3</td><td>No heading, build-out line n/a</td></tr>
            <tr><td>U9–U10</td><td>7v7</td><td>Size 4</td><td>Build-out line, no punting, no heading</td></tr>
            <tr><td>U11–U12</td><td>9v9</td><td>Size 4</td><td>Offside enforced</td></tr>
            <tr><td>U13+</td><td>11v11</td><td>Size 5</td><td>Full FIFA Laws of the Game</td></tr>
          </table>
          <h3>Key points every coach gets wrong</h3>
          <ul>
            <li><strong>Build-out line (7v7):</strong> when the goalkeeper has the ball, opponents retreat
                behind the line until the ball is put into play. Encourages playing out of the back.</li>
            <li><strong>Heading:</strong> banned for U11 and younger in both practice and games.</li>
            <li><strong>Sideline behavior:</strong> coaches may instruct only from their own technical area,
                and positive encouragement beats joystick coaching every time.</li>
          </ul>
          <p>Read the official, current laws for free at
          <a href="https://www.theifab.com/laws-of-the-game-documents/" target="_blank" rel="noopener">IFAB —
          Laws of the Game</a>.</p>`,
      },
      {
        id: 'session-video',
        type: 'video',
        title: 'Video: A Grassroots Training Session in Action',
        videoUrl: '/media/lesson-video.mp4',
        videoUrlWebm: '/media/lesson-video.webm',
        durationSeconds: 93,
        // The watch gate: the learner must watch all but the last 2 seconds of
        // real playback (generalized as duration - 2 seconds).
        minWatchSeconds: 91,
        html: `
          <p>Watch this training session demonstration from start to finish. As you watch, look for:</p>
          <ul>
            <li>How quickly players get a ball at their feet (no lines, no laps, no lectures),</li>
            <li>Water breaks and safety checkpoints,</li>
            <li>The coach teaching through short “freeze” moments instead of long speeches.</li>
          </ul>
          <p><strong>Note:</strong> skipping ahead is disabled. You must watch almost the entire
          video before you can continue to the next lesson.</p>`,
      },
      {
        id: 'session-design',
        type: 'text',
        title: 'Designing Your Practice: Play–Practice–Play',
        html: `
          <h2>The Play–Practice–Play Model</h2>
          <p>U.S. Soccer's grassroots methodology structures every session in three phases:</p>
          <ol>
            <li><strong>Play (15 min):</strong> players arrive and immediately play small-sided soccer.
                No warm-up lines — the game is the warm-up.</li>
            <li><strong>Practice (30 min):</strong> a focused activity targeting one theme
                (e.g., dribbling to beat a defender). Keep it game-like: direction, opponents, goals.</li>
            <li><strong>Play (15 min):</strong> finish with the game again. Let them play — observe,
                and save your coaching for one or two teachable moments.</li>
          </ol>
          <h3>Session checklist</h3>
          <ul>
            <li>One theme per session — not five.</li>
            <li>Every activity has a ball, a decision, and a way to “win.”</li>
            <li>Talk less than 30 seconds at a time.</li>
            <li>End on time, end positive, name one thing each player did well.</li>
          </ul>`,
      },
      {
        id: 'resources',
        type: 'text',
        title: 'Coaching Resources & Where to Learn More',
        html: `
          <h2>Keep Growing as a Coach</h2>
          <p>This course is your starting point. The resources below — all free — will help you plan
          better sessions, keep players safe, and continue your coaching education. We recommend
          bookmarking these and returning to them throughout the season.</p>

          <h3>⚽ U.S. Soccer coaching education</h3>
          <ul>
            <li><a href="https://learning.ussoccer.com/" target="_blank" rel="noopener">U.S. Soccer Learning Center</a>
                — the official home for coaching licenses and courses, including the free
                <strong>Introduction to Grassroots Coaching</strong> module.</li>
            <li><a href="https://learning.ussoccer.com/coach/courses" target="_blank" rel="noopener">Grassroots Coaching Licenses</a>
                — the 4v4, 7v7, 9v9, and 11v11 license pathways for youth coaches.</li>
            <li><a href="https://www.ussoccer.com/coaching-education" target="_blank" rel="noopener">U.S. Soccer Coaching Education overview</a>
                — how the licensing pathway fits together, from grassroots to pro.</li>
          </ul>

          <h3>🥅 Session plans &amp; activities</h3>
          <ul>
            <li><a href="https://www.usyouthsoccer.org/coaches/" target="_blank" rel="noopener">US Youth Soccer — Coaches Hub</a>
                — age-appropriate drills, practice plans, and player-development guidance.</li>
            <li><a href="https://www.ussoccer.com/coaching-education/play-practice-play" target="_blank" rel="noopener">Play–Practice–Play</a>
                — a deeper look at the session model from this course.</li>
          </ul>

          <h3>🛡️ Player safety</h3>
          <ul>
            <li><a href="https://uscenterforsafesport.org/" target="_blank" rel="noopener">U.S. Center for SafeSport</a>
                — abuse-prevention training and the standards every NCYSA coach follows.</li>
            <li><a href="https://www.ncsoccer.org/" target="_blank" rel="noopener">NCYSA — North Carolina Youth Soccer</a>
                — state-specific policies, background checks, and coach registration.</li>
          </ul>

          <h3>📖 Laws of the game</h3>
          <ul>
            <li><a href="https://www.theifab.com/laws-of-the-game-documents/" target="_blank" rel="noopener">IFAB — Laws of the Game</a>
                — the official, current laws, free to read online.</li>
          </ul>

          <p style="margin-top:16px"><em>Tip: links open in a new tab so you won't lose your place here.
          When you're ready, continue to the final exam.</em></p>`,
      },
      {
        id: 'final-exam',
        type: 'quiz',
        title: 'Final Exam',
        passPercent: 80,
        html: `<p>Answer all questions. You need <strong>80% or higher</strong> to pass and earn your
               license certificate. You may retake the exam if needed.</p>`,
        questions: [
          {
            id: 'q1',
            prompt: 'A player takes a knock to the head and seems dizzy. What must you do?',
            options: [
              'Give them water and let them play if they say they feel fine',
              'Remove them immediately; no return the same day without medical clearance',
              'Have them play goalkeeper for the rest of the game',
              'Let a parent decide whether they keep playing',
            ],
            answer: 1,
          },
          {
            id: 'q2',
            prompt: 'In the Play–Practice–Play model, how should a session begin?',
            options: [
              'Warm-up laps and static stretching',
              'A tactics lecture with a whiteboard',
              'Players immediately playing small-sided soccer',
              'Fitness testing',
            ],
            answer: 2,
          },
          {
            id: 'q3',
            prompt: 'Heading the ball is prohibited for which players?',
            options: [
              'U11 and younger, in both practices and games',
              'Only U6 players',
              'Only in games, practice heading is fine at any age',
              'No age group — heading is always allowed',
            ],
            answer: 0,
          },
          {
            id: 'q4',
            prompt: 'What is the best measure of success for a grassroots coach?',
            options: [
              'Winning the league',
              'How many players return to play next season',
              'How disciplined the players stand in line',
              'Number of drills covered per practice',
            ],
            answer: 1,
          },
          {
            id: 'q5',
            prompt: 'At 7v7 (U9–U10), what does the build-out line require?',
            options: [
              'Goalkeepers must punt the ball past midfield',
              'Defenders must stay behind it at all times',
              'Opponents retreat behind it until the goalkeeper puts the ball in play',
              'All goal kicks are taken from the midfield line',
            ],
            answer: 2,
          },
        ],
      },
    ],
  },

  // ---- Staff / volunteer training (audience: 'staff') ---------------------
  {
    id: 'staff-onboarding',
    title: 'NCYSA Staff Onboarding & Policies',
    tagline: 'Required orientation for NCYSA staff, board members, and office volunteers.',
    description:
      'A short onboarding for everyone who works or volunteers with the North Carolina Youth ' +
      'Soccer Association. It covers our mission, the SafeSport and mandatory-reporting policies ' +
      'every staff member must follow, and how we handle member data. Finish with a short check ' +
      'for understanding and receive your completion certificate.',
    badge: 'Staff Training',
    audience: 'staff',
    estMinutes: 20,
    heroEmoji: '🗂️',
    lessons: [
      {
        id: 'staff-welcome',
        type: 'text',
        title: 'Welcome to the NCYSA Team',
        html: `
          <h2>Welcome aboard!</h2>
          <p>Whether you're on staff, on the board, or volunteering in the office, you're part of the
          team that makes youth soccer happen across North Carolina. This short onboarding gets you
          set up with the essentials.</p>
          <h3>Our mission</h3>
          <p>NCYSA develops and promotes the game of soccer for the youth of North Carolina — building
          players, coaches, referees, and communities. Every role in the association exists to keep
          kids playing, safe, and having fun.</p>
          <p>Mark this lesson complete to continue.</p>`,
      },
      {
        id: 'staff-safesport',
        type: 'text',
        title: 'SafeSport & Mandatory Reporting',
        html: `
          <h2>Keeping Every Participant Safe</h2>
          <p>All NCYSA staff and volunteers operate under the U.S. Center for SafeSport standards:</p>
          <ul>
            <li><strong>Two-adult rule</strong> — interactions with minors are observable and interruptible.</li>
            <li><strong>Background screening</strong> — required for anyone in a covered role.</li>
            <li><strong>Mandatory reporting</strong> — suspected abuse or misconduct must be reported
                immediately. When in doubt, report.</li>
          </ul>
          <p>Complete your training and review the standards at the
          <a href="https://uscenterforsafesport.org/" target="_blank" rel="noopener">U.S. Center for SafeSport</a>.</p>
          <h3>Data &amp; privacy</h3>
          <p>Member data (names, contact info, registrations) is confidential. Access only what your role
          requires, never share it outside NCYSA business, and report any suspected data exposure to
          the office right away.</p>`,
      },
      {
        id: 'staff-check',
        type: 'quiz',
        title: 'Onboarding Check',
        passPercent: 100,
        html: `<p>A quick two-question check. You need <strong>100%</strong> — you can retake it.</p>`,
        questions: [
          {
            id: 'q1',
            prompt: 'You suspect a child may be being harmed. What is the NCYSA expectation?',
            options: [
              'Wait to see if it happens again before doing anything',
              'Report it immediately — when in doubt, report',
              'Only tell another volunteer',
              'Handle it yourself privately',
            ],
            answer: 1,
          },
          {
            id: 'q2',
            prompt: 'How should NCYSA member data be treated?',
            options: [
              'Shared freely to get work done faster',
              'Confidential — accessed only as your role requires and never shared outside NCYSA',
              'Posted publicly for transparency',
              'Kept on personal devices without restriction',
            ],
            answer: 1,
          },
        ],
      },
    ],
  },
];
