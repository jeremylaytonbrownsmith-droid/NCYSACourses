// SCORM 1.2 exporter. Turns one of our native courses into a standard, portable
// SCORM 1.2 package (a .zip) that plays in ANY LMS — not just GetMatchReady. This
// is the mirror image of the SCORM we already host and track: here we PRODUCE the
// package instead of consuming it.
//
// The package is a single SCO:
//   imsmanifest.xml  — SCORM 1.2 manifest describing the one SCO + its files
//   index.html       — a self-contained player (inline CSS/JS, no server) that
//                      steps through the lessons and grades the quiz
//   scormAPI.js      — a tiny SCORM 1.2 runtime wrapper (finds the host LMS API,
//                      reports lesson_status + score, commits, finishes)
//   assets/*         — any local images referenced by the course, bundled in
//
// Supported lesson types: text (reading), quiz (graded → score + pass/fail),
// slides (images bundled; a video slide becomes a "Watch the video" link), and
// video (link out). Unknown types are skipped gracefully. Completion: if the
// course has a quiz, status is passed/failed by score vs the pass mark; with no
// quiz, status is "completed" once the learner reaches the end and clicks Finish.

const path = require('path');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function xmlEsc(s) { return esc(s); }
// Safe <script> JSON embedding (close-tag + line-separator safety).
function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');
}
function slug(s) { return String(s || 'course').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'course'; }

// The SCORM 1.2 runtime wrapper. Walks up frames (and window.opener) to find the
// LMS API object, then exposes a minimal, forgiving interface. Never throws if
// the LMS isn't there (so the package still renders when opened standalone).
const SCORM_API_JS = `(function(){
  var api=null, started=false;
  function findAPI(win){ var n=0; while(win && !win.API && win.parent && win.parent!==win && n++<12){ win=win.parent; } return (win && win.API) ? win.API : null; }
  function getAPI(){ if(api) return api; try{ api=findAPI(window); }catch(e){} if(!api && window.opener){ try{ api=findAPI(window.opener); }catch(e){} } return api; }
  window.SCORM={
    available:function(){ return !!getAPI(); },
    init:function(){ var a=getAPI(); if(!a) return false; if(started) return true; started=(a.LMSInitialize("")+"")==="true"; return started; },
    set:function(k,v){ var a=getAPI(); if(!a) return false; return (a.LMSSetValue(k,""+v)+"")==="true"; },
    get:function(k){ var a=getAPI(); if(!a) return ""; return a.LMSGetValue(k); },
    commit:function(){ var a=getAPI(); if(!a) return false; return (a.LMSCommit("")+"")==="true"; },
    finish:function(){ var a=getAPI(); if(!a||!started) return false; started=false; return (a.LMSFinish("")+"")==="true"; }
  };
})();`;

// Resolve a referenced image path to a bundled asset. Returns { href } where href
// is the in-package path, after reading the bytes via readPublicFile(relPath).
// Only local same-origin paths ("/media/..", "media/..") are bundled; anything
// else (http(s), data:) is left untouched so it still points where it did.
function collectAssets(course, readPublicFile) {
  const map = new Map(); // originalSrc -> assets/<name>
  const files = [];      // { name, buf }
  const used = new Set();
  function bundle(src) {
    if (!src || typeof src !== 'string') return null;
    if (map.has(src)) return map.get(src);
    if (/^(https?:|data:|\/\/)/i.test(src)) return null; // external — leave as-is
    if (!readPublicFile) return null;
    const rel = src.replace(/^\/+/, '');
    let buf;
    try { buf = readPublicFile(rel); } catch (e) { return null; }
    if (!buf) return null;
    let base = path.basename(rel).replace(/[^A-Za-z0-9._-]/g, '_') || 'img';
    let name = 'assets/' + base;
    let i = 1;
    while (used.has(name)) { name = 'assets/' + i + '-' + base; i++; }
    used.add(name);
    map.set(src, name);
    files.push({ name, buf });
    return name;
  }
  for (const l of (course.lessons || [])) {
    if (l && l.type === 'slides') for (const s of (l.slides || [])) if (s && s.img) bundle(s.img);
    // inline <img src="/..."> inside reading HTML
    if (l && typeof l.html === 'string') {
      l.html.replace(/<img[^>]+src\s*=\s*"([^"]+)"/gi, (m, src) => { bundle(src); return m; });
    }
  }
  return { map, files };
}

function rewriteImgSrc(html, map) {
  return String(html || '').replace(/(<img[^>]+src\s*=\s*")([^"]+)(")/gi, (m, a, src, b) => {
    const mapped = map.get(src);
    return mapped ? a + mapped + b : m;
  });
}

// Build the player body (one <section> per lesson) + the quiz data for grading.
function renderSections(course, assetMap) {
  const sections = [];
  const quizzes = []; // { idx, passPercent, questions:[{prompt,options,answer}] }
  let idx = 0;
  for (const l of (course.lessons || [])) {
    if (!l) continue;
    const t = l.type;
    if (t === 'text') {
      sections.push(`<section class="lesson" data-idx="${idx}"><h2>${esc(l.title || 'Lesson')}</h2><div class="content">${rewriteImgSrc(l.html, assetMap)}</div></section>`);
      idx++;
    } else if (t === 'slides') {
      const items = (l.slides || []).map((s, i) => {
        if (s && s.video) {
          const link = esc(s.video);
          return `<figure class="slide"><a class="videolink" href="${link}" target="_blank" rel="noopener">▶ Watch the video</a>${s.caption ? `<figcaption>${s.caption}</figcaption>` : ''}</figure>`;
        }
        const src = (s && s.img && assetMap.get(s.img)) || (s && s.img) || '';
        return `<figure class="slide"><img src="${esc(src)}" alt="${esc((s && s.alt) || ('Slide ' + (i + 1)))}" />${s && s.caption ? `<figcaption>${s.caption}</figcaption>` : ''}</figure>`;
      }).join('');
      sections.push(`<section class="lesson" data-idx="${idx}"><h2>${esc(l.title || 'Slides')}</h2>${l.html ? `<div class="content">${rewriteImgSrc(l.html, assetMap)}</div>` : ''}<div class="slides">${items}</div></section>`);
      idx++;
    } else if (t === 'video') {
      const link = esc(l.videoUrl || '');
      sections.push(`<section class="lesson" data-idx="${idx}"><h2>${esc(l.title || 'Video')}</h2>${l.html ? `<div class="content">${l.html}</div>` : ''}${link ? `<p><a class="videolink" href="${link}" target="_blank" rel="noopener">▶ Watch the video</a></p>` : ''}</section>`);
      idx++;
    } else if (t === 'quiz') {
      quizzes.push({ idx, passPercent: Number(l.passPercent) || 80, questions: (l.questions || []).map((q) => ({ prompt: q.prompt, options: q.options || [], answer: Number(q.answer) || 0 })) });
      sections.push(`<section class="lesson quiz" data-idx="${idx}"><h2>${esc(l.title || 'Quiz')}</h2>${l.html ? `<div class="content">${l.html}</div>` : ''}<div class="quizbody"></div><div class="quizresult" hidden></div></section>`);
      idx++;
    }
    // other types (scorm) are skipped — a SCORM can't embed another SCORM package.
  }
  return { sections, quizzes, count: idx };
}

function renderPlayerHtml(course, assetMap) {
  const accent = /^#[0-9a-fA-F]{3,6}$/.test(course.certAccent || '') ? course.certAccent : '#2f5a9e';
  const accent2 = /^#[0-9a-fA-F]{3,6}$/.test(course.certAccent2 || '') ? course.certAccent2 : '#ce2b37';
  const { sections, quizzes, count } = renderSections(course, assetMap);
  const hasQuiz = quizzes.length > 0;
  const brand = esc(course.coBrandName || course.title || 'Course');
  const config = jsonForScript({ quizzes, count, hasQuiz });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(course.title || 'Course')}</title>
<script src="scormAPI.js"></script>
<style>
  :root{ --accent:${accent}; --accent2:${accent2}; }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a2232;background:#eef2f8;line-height:1.55}
  header{background:var(--accent);color:#fff;padding:16px 20px}
  header .brand{font-weight:700;font-size:1.05rem}
  header .title{font-size:.9rem;opacity:.9}
  .bar{height:6px;background:rgba(255,255,255,.3)}
  .bar > div{height:100%;width:0;background:var(--accent2);transition:width .3s}
  main{max-width:860px;margin:0 auto;padding:22px 18px 120px}
  .lesson{display:none;background:#fff;border-radius:14px;padding:26px;box-shadow:0 10px 30px rgba(20,30,50,.08)}
  .lesson.active{display:block}
  .lesson h2{margin:.1em 0 .6em;color:var(--accent)}
  .content h3,.content h4{color:#223}
  .content .callout{background:#fff6f6;border-left:4px solid var(--accent2);padding:12px 14px;border-radius:8px;margin:14px 0}
  .slides figure{margin:0 0 18px}
  .slides img{display:block;width:100%;height:auto;border-radius:10px;box-shadow:0 6px 18px rgba(20,30,50,.12)}
  figcaption{color:#51607a;font-size:.92rem;margin-top:8px}
  .videolink{display:inline-block;background:var(--accent2);color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px}
  .q{margin:0 0 18px;padding:14px 16px;border:1px solid #e3e9f2;border-radius:10px}
  .q .prompt{font-weight:700;margin-bottom:10px}
  .q label{display:block;padding:8px 10px;border-radius:8px;cursor:pointer}
  .q label:hover{background:#f3f6fb}
  .quizresult{margin-top:12px;padding:14px 16px;border-radius:10px;font-weight:700}
  .quizresult.pass{background:#e8f7ec;color:#1b7a3d}
  .quizresult.fail{background:#fdeaea;color:#b3261e}
  footer{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #e3e9f2;padding:12px 18px;display:flex;gap:10px;justify-content:space-between;align-items:center}
  footer .pos{color:#51607a;font-size:.9rem}
  button{font:inherit;font-weight:700;border:0;border-radius:10px;padding:11px 20px;cursor:pointer}
  .btn{background:var(--accent);color:#fff}
  .btn.ghost{background:#eef2f8;color:#2a3550}
  .btn:disabled{opacity:.45;cursor:default}
</style>
</head>
<body>
<header>
  <div class="brand">${brand}</div>
  <div class="title">${esc(course.title || '')}</div>
</header>
<div class="bar"><div id="bar"></div></div>
<main id="main">
${sections.join('\n')}
</main>
<footer>
  <button class="btn ghost" id="back">← Back</button>
  <span class="pos" id="pos"></span>
  <button class="btn" id="next">Next →</button>
</footer>
<script>
(function(){
  var CFG = ${config};
  var sections = Array.prototype.slice.call(document.querySelectorAll('.lesson'));
  var total = sections.length;
  var cur = 0, finished = false, quizPassed = {};
  var back = document.getElementById('back'), next = document.getElementById('next'),
      pos = document.getElementById('pos'), bar = document.getElementById('bar');

  SCORM.init();
  var prior = (SCORM.get('cmi.core.lesson_status')+'').toLowerCase();
  var reviewing = (prior==='completed'||prior==='passed'||prior==='failed');
  if(!reviewing){ SCORM.set('cmi.core.lesson_status','incomplete'); SCORM.commit(); }
  // Resume to the saved spot if any.
  var loc = parseInt(SCORM.get('cmi.core.lesson_location'),10);
  if(!isNaN(loc) && loc>=0 && loc<total) cur = loc;

  function quizFor(idx){ for(var i=0;i<CFG.quizzes.length;i++){ if(CFG.quizzes[i].idx===idx) return CFG.quizzes[i]; } return null; }

  function buildQuiz(section, quiz){
    var body = section.querySelector('.quizbody');
    if(body.dataset.built) return; body.dataset.built='1';
    quiz.questions.forEach(function(q,qi){
      var wrap=document.createElement('div'); wrap.className='q';
      var p=document.createElement('div'); p.className='prompt'; p.textContent=(qi+1)+'. '+q.prompt; wrap.appendChild(p);
      q.options.forEach(function(opt,oi){
        var lab=document.createElement('label');
        var inp=document.createElement('input'); inp.type='radio'; inp.name='q'+qi; inp.value=oi;
        lab.appendChild(inp); lab.appendChild(document.createTextNode(' '+opt)); wrap.appendChild(lab);
      });
      body.appendChild(wrap);
    });
    var res=section.querySelector('.quizresult');
    // The Next button doubles as Submit on a quiz section (see updateNav).
  }

  function gradeQuiz(section, quiz){
    var correct=0;
    quiz.questions.forEach(function(q,qi){
      var sel=section.querySelector('input[name="q'+qi+'"]:checked');
      if(sel && parseInt(sel.value,10)===q.answer) correct++;
    });
    var pct = quiz.questions.length ? Math.round((correct/quiz.questions.length)*100) : 100;
    var passed = pct >= quiz.passPercent;
    var res=section.querySelector('.quizresult');
    res.hidden=false; res.className='quizresult '+(passed?'pass':'fail');
    res.textContent = (passed?'Passed — ':'Not passed — ')+'you scored '+pct+'% ('+correct+'/'+quiz.questions.length+'). '+(passed?'':'Review the lessons and try again.');
    SCORM.set('cmi.core.score.min','0'); SCORM.set('cmi.core.score.max','100'); SCORM.set('cmi.core.score.raw',''+pct);
    SCORM.set('cmi.core.lesson_status', passed?'passed':'failed'); SCORM.commit();
    quizPassed[quiz.idx]=passed;
    return passed;
  }

  function markComplete(){
    if(finished) return; finished=true;
    var anyQuiz = CFG.quizzes.length>0;
    if(!anyQuiz){ SCORM.set('cmi.core.lesson_status','completed'); }
    SCORM.set('cmi.core.lesson_location',''+cur); SCORM.commit();
  }

  function isQuiz(idx){ return !!quizFor(idx); }
  function atEnd(){ return cur===total-1; }

  function show(i){
    cur=Math.max(0,Math.min(total-1,i));
    sections.forEach(function(s){ s.classList.toggle('active', +s.dataset.idx===cur); });
    var q=quizFor(cur); if(q) buildQuiz(sections[cur], q);
    SCORM.set('cmi.core.lesson_location',''+cur); SCORM.commit();
    pos.textContent=(cur+1)+' / '+total;
    bar.style.width=(((cur+1)/total)*100)+'%';
    back.disabled = cur===0;
    updateNav();
    window.scrollTo(0,0);
  }
  function updateNav(){
    var q=quizFor(cur);
    if(q && !reviewing && !(cur in quizPassed)){ next.textContent='Submit answers'; }
    else if(atEnd()){ next.textContent= reviewing ? 'Finish' : 'Finish ✓'; }
    else { next.textContent='Next →'; }
  }

  back.addEventListener('click', function(){ if(cur>0) show(cur-1); });
  next.addEventListener('click', function(){
    var q=quizFor(cur);
    if(q && !reviewing && !(cur in quizPassed)){
      gradeQuiz(sections[cur], q); updateNav(); return; // grade in place; stay so they see the result
    }
    if(atEnd()){ markComplete(); next.disabled=true; next.textContent='Completed ✓'; SCORM.finish(); return; }
    show(cur+1);
  });

  window.addEventListener('beforeunload', function(){ if(!finished){ SCORM.commit(); } SCORM.finish(); });
  show(cur);
})();
</script>
</body>
</html>`;
}

function renderManifest(course, fileHrefs) {
  const id = slug(course.id || course.title);
  const title = xmlEsc(course.title || 'Course');
  const fileEls = fileHrefs.map((h) => `      <file href="${xmlEsc(h)}" />`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST-${id}" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG-${id}">
    <organization identifier="ORG-${id}">
      <title>${title}</title>
      <item identifier="ITEM-${id}" identifierref="RES-${id}">
        <title>${title}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-${id}" type="webcontent" adlcp:scormtype="sco" href="index.html">
${fileEls}
    </resource>
  </resources>
</manifest>`;
}

// Build the SCORM 1.2 package. `readPublicFile(relPath)` returns a Buffer for a
// local asset path (or null/throws if missing); omit it to skip asset bundling
// (fine for text+quiz courses). Returns { buffer, filename }.
function buildScormZip(course, { readPublicFile } = {}) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const hrefs = [];
  const add = (name, content) => { zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')); hrefs.push(name); };

  const { map, files } = collectAssets(course, readPublicFile);
  add('scormAPI.js', SCORM_API_JS);
  add('index.html', renderPlayerHtml(course, map));
  for (const f of files) add(f.name, f.buf);

  // Manifest lists every file in the resource (not itself).
  zip.addFile('imsmanifest.xml', Buffer.from(renderManifest(course, hrefs), 'utf8'));

  return { buffer: zip.toBuffer(), filename: slug(course.id || course.title) + '-scorm12.zip' };
}

module.exports = { buildScormZip, renderPlayerHtml, renderManifest, collectAssets, SCORM_API_JS };
