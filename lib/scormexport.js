// Course exporter / publisher. Turns one of our native courses into a portable
// package in several formats — the "Save As…" / Articulate-style publish menu:
//
//   scorm12   — SCORM 1.2 .zip for any LMS (window.API / cmi.core.*)
//   scorm2004 — SCORM 2004 .zip for newer LMSs (window.API_1484_11 / cmi.*)
//   web       — a standalone HTML .zip that needs NO LMS: open index.html in any
//               browser; progress/resume is kept in the browser (localStorage)
//
// Every format ships the SAME self-contained player (index.html) and the SAME
// rendered content; only a small `runtime.js` adapter and the manifest differ.
// The player talks to one interface (window.LMS) so its logic never branches on
// format — the runtime behind that interface is what changes. This is the mirror
// image of the SCORM we already host and track: here we PRODUCE packages.
//
// Supported lesson types: text (reading), quiz (graded → score + pass/fail),
// slides (images bundled; a video slide becomes a "Watch the video" link), and
// video (link out). `scorm` lessons are skipped (a package can't nest a package).

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

const FORMATS = {
  scorm12: { ext: 'scorm12', manifest: '1.2' },
  scorm2004: { ext: 'scorm2004', manifest: '2004' },
  web: { ext: 'web', manifest: null },
};

// ---- per-format runtime adapters (window.LMS) ------------------------------
// Each defines the same interface so the player code is identical everywhere:
//   init() -> bool         getStatus() -> 'completed'|'passed'|'failed'|''
//   getLocation()/setLocation(i)   report(scoreOrNull, 'passed'|'failed'|'completed')
//   commit()   finish()

const RUNTIME_SCORM12 = `(function(){
  var api=null, started=false;
  function find(w){ var n=0; while(w && !w.API && w.parent && w.parent!==w && n++<12){ w=w.parent; } return (w&&w.API)?w.API:null; }
  function get(){ if(api) return api; try{api=find(window);}catch(e){} if(!api&&window.opener){ try{api=find(window.opener);}catch(e){} } return api; }
  window.LMS={
    init:function(){ api=get(); if(!api) return false; started=(api.LMSInitialize("")+"")==="true"; var s=(api.LMSGetValue("cmi.core.lesson_status")+"").toLowerCase(); if(!(s==="completed"||s==="passed"||s==="failed")){ api.LMSSetValue("cmi.core.lesson_status","incomplete"); api.LMSCommit(""); } return started; },
    getStatus:function(){ return api?((api.LMSGetValue("cmi.core.lesson_status")+"").toLowerCase()):""; },
    getLocation:function(){ return api?(api.LMSGetValue("cmi.core.lesson_location")+""):""; },
    setLocation:function(v){ if(api) api.LMSSetValue("cmi.core.lesson_location",""+v); },
    report:function(score,outcome){ if(!api) return; if(score!=null){ api.LMSSetValue("cmi.core.score.min","0"); api.LMSSetValue("cmi.core.score.max","100"); api.LMSSetValue("cmi.core.score.raw",""+score); } api.LMSSetValue("cmi.core.lesson_status", outcome); },
    commit:function(){ if(api) api.LMSCommit(""); },
    finish:function(){ if(api&&started){ started=false; api.LMSFinish(""); } }
  };
})();`;

const RUNTIME_SCORM2004 = `(function(){
  var api=null, started=false;
  function find(w){ var n=0; while(w && !w.API_1484_11 && w.parent && w.parent!==w && n++<12){ w=w.parent; } return (w&&w.API_1484_11)?w.API_1484_11:null; }
  function get(){ if(api) return api; try{api=find(window);}catch(e){} if(!api&&window.opener){ try{api=find(window.opener);}catch(e){} } return api; }
  window.LMS={
    init:function(){ api=get(); if(!api) return false; started=(api.Initialize("")+"")==="true"; var c=(api.GetValue("cmi.completion_status")+"").toLowerCase(); if(c!=="completed"){ api.SetValue("cmi.completion_status","incomplete"); api.Commit(""); } return started; },
    getStatus:function(){ if(!api) return ""; var s=(api.GetValue("cmi.success_status")+"").toLowerCase(); if(s==="passed"||s==="failed") return s; return (api.GetValue("cmi.completion_status")+"").toLowerCase(); },
    getLocation:function(){ return api?(api.GetValue("cmi.location")+""):""; },
    setLocation:function(v){ if(api) api.SetValue("cmi.location",""+v); },
    report:function(score,outcome){ if(!api) return; if(score!=null){ var sc=Math.max(0,Math.min(100,score)); api.SetValue("cmi.score.scaled",""+(sc/100)); api.SetValue("cmi.score.raw",""+score); api.SetValue("cmi.score.min","0"); api.SetValue("cmi.score.max","100"); } if(outcome==="passed"||outcome==="failed"){ api.SetValue("cmi.success_status",outcome); } api.SetValue("cmi.completion_status","completed"); },
    commit:function(){ if(api) api.Commit(""); },
    finish:function(){ if(api&&started){ started=false; api.Terminate(""); } }
  };
})();`;

// No LMS at all — keep progress in the browser so a standalone HTML course still
// resumes and remembers completion for that viewer. Safe if storage is blocked.
const RUNTIME_WEB = `(function(){
  var KEY="gmrweb:"+(location.pathname||"course");
  function load(){ try{ return JSON.parse(localStorage.getItem(KEY))||{}; }catch(e){ return {}; } }
  function save(o){ try{ localStorage.setItem(KEY, JSON.stringify(o)); }catch(e){} }
  var st=load();
  window.LMS={
    init:function(){ return true; },
    getStatus:function(){ return st.status||""; },
    getLocation:function(){ return st.loc!=null?(""+st.loc):""; },
    setLocation:function(v){ st.loc=v; save(st); },
    report:function(score,outcome){ if(score!=null) st.score=score; st.status=(outcome==="passed"||outcome==="failed")?outcome:"completed"; save(st); },
    commit:function(){ save(st); },
    finish:function(){}
  };
})();`;

function runtimeFor(format) {
  if (format === 'scorm2004') return RUNTIME_SCORM2004;
  if (format === 'web') return RUNTIME_WEB;
  return RUNTIME_SCORM12;
}

// ---- asset bundling --------------------------------------------------------
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

// ---- content rendering (shared across formats) -----------------------------
function renderSections(course, assetMap) {
  const sections = [];
  const quizzes = [];
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
          return `<figure class="slide"><a class="videolink" href="${esc(s.video)}" target="_blank" rel="noopener">▶ Watch the video</a>${s.caption ? `<figcaption>${s.caption}</figcaption>` : ''}</figure>`;
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
  }
  return { sections, quizzes, count: idx };
}

function renderPlayerHtml(course, assetMap, opts = {}) {
  const runtimeSrc = opts.runtimeSrc || 'runtime.js';
  const accent = /^#[0-9a-fA-F]{3,6}$/.test(course.certAccent || '') ? course.certAccent : '#2f5a9e';
  const accent2 = /^#[0-9a-fA-F]{3,6}$/.test(course.certAccent2 || '') ? course.certAccent2 : '#ce2b37';
  const { sections, quizzes } = renderSections(course, assetMap);
  const brand = esc(course.coBrandName || course.title || 'Course');
  const config = jsonForScript({ quizzes });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(course.title || 'Course')}</title>
<script src="${esc(runtimeSrc)}"></script>
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
  var LMS = window.LMS || { init:function(){return false;}, getStatus:function(){return"";}, getLocation:function(){return"";}, setLocation:function(){}, report:function(){}, commit:function(){}, finish:function(){} };
  var sections = Array.prototype.slice.call(document.querySelectorAll('.lesson'));
  var total = sections.length;
  var cur = 0, finished = false, quizPassed = {};
  var back = document.getElementById('back'), next = document.getElementById('next'),
      pos = document.getElementById('pos'), bar = document.getElementById('bar');

  LMS.init();
  var prior = (LMS.getStatus()+'').toLowerCase();
  var reviewing = (prior==='completed'||prior==='passed'||prior==='failed');
  var loc = parseInt(LMS.getLocation(),10);
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
    LMS.report(pct, passed?'passed':'failed'); LMS.commit();
    quizPassed[quiz.idx]=passed;
    return passed;
  }

  function markComplete(){
    if(finished) return; finished=true;
    if(CFG.quizzes.length===0){ LMS.report(null,'completed'); }
    LMS.setLocation(cur); LMS.commit();
  }

  function atEnd(){ return cur===total-1; }

  function show(i){
    cur=Math.max(0,Math.min(total-1,i));
    sections.forEach(function(s){ s.classList.toggle('active', +s.dataset.idx===cur); });
    var q=quizFor(cur); if(q) buildQuiz(sections[cur], q);
    LMS.setLocation(cur); LMS.commit();
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
    if(q && !reviewing && !(cur in quizPassed)){ gradeQuiz(sections[cur], q); updateNav(); return; }
    if(atEnd()){ markComplete(); next.disabled=true; next.textContent='Completed ✓'; LMS.finish(); return; }
    show(cur+1);
  });

  window.addEventListener('beforeunload', function(){ LMS.commit(); LMS.finish(); });
  show(cur);
})();
</script>
</body>
</html>`;
}

function renderManifest(course, fileHrefs, version) {
  const id = slug(course.id || course.title);
  const title = xmlEsc(course.title || 'Course');
  const fileEls = fileHrefs.map((h) => `      <file href="${xmlEsc(h)}" />`).join('\n');
  if (version === '2004') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST-${id}" version="1"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"
  xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3"
  xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3"
  xmlns:imsss="http://www.imsglobal.org/xsd/imsss"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd http://www.adlnet.org/xsd/adlseq_v1p3 adlseq_v1p3.xsd http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 4th Edition</schemaversion>
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
    <resource identifier="RES-${id}" type="webcontent" adlcp:scormType="sco" href="index.html">
${fileEls}
    </resource>
  </resources>
</manifest>`;
  }
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

// Build a package in the requested format. `readPublicFile(relPath)` returns a
// Buffer for a local asset path (or null); omit it to skip asset bundling (fine
// for text+quiz courses). Returns { buffer, filename, format }.
function buildPackage(course, { format = 'scorm12', readPublicFile } = {}) {
  const fmt = FORMATS[format] ? format : 'scorm12';
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const hrefs = [];
  const add = (name, content) => { zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')); hrefs.push(name); };

  const { map, files } = collectAssets(course, readPublicFile);
  add('runtime.js', runtimeFor(fmt));
  add('index.html', renderPlayerHtml(course, map, { runtimeSrc: 'runtime.js' }));
  for (const f of files) add(f.name, f.buf);

  const manifestVersion = FORMATS[fmt].manifest;
  if (manifestVersion) zip.addFile('imsmanifest.xml', Buffer.from(renderManifest(course, hrefs, manifestVersion), 'utf8'));

  return { buffer: zip.toBuffer(), filename: slug(course.id || course.title) + '-' + FORMATS[fmt].ext + '.zip', format: fmt };
}

// Back-compat alias: the original SCORM 1.2 exporter.
function buildScormZip(course, opts = {}) { return buildPackage(course, { ...opts, format: 'scorm12' }); }

module.exports = { buildPackage, buildScormZip, renderPlayerHtml, renderManifest, collectAssets, runtimeFor, FORMATS };
