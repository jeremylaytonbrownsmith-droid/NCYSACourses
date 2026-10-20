// Document exporter — turns one of our native courses into a flat handout for
// in-person / offline use: a PDF or a PowerPoint (.pptx). This is the sibling of
// scormexport.js (which produces interactive SCORM/HTML packages). These formats
// are STATIC by design: a quiz prints as its questions plus an answer key, not an
// interactive exam — so the standalone-HTML ("web") export is preferred wherever
// a device is available. These exist for printing and classroom projection.
//
// Supported lesson types: text (reading), slides (text + "Watch the video" link;
// images are not embedded here), video (link), quiz (questions + answer key).
// `scorm` lessons are skipped — a flat handout can't run a SCORM package.

const ACCENT = '#2f5a9e';
const ACCENT_HEX = '2F5A9E';

function niceSlug(s) {
  return String(s || 'course').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'course';
}

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Strip inline tags, decode entities, collapse whitespace. Line breaks become a
// space; other inline tags (strong/em/…) are removed without adding a space, so
// punctuation stays tight (e.g. "Stop <strong>now</strong>." → "Stop now.").
function stripInline(s) {
  const x = String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
  return decodeEntities(x).replace(/\s+/g, ' ').trim();
}

// Convert our small allowed-HTML set (h3/h4, p, ul/ol/li, strong/em, br, and
// callout divs) into ordered text blocks. Callout wrappers are unwrapped so their
// inner paragraphs/headings parse normally (the highlight styling is dropped — a
// handout doesn't need it). Returns [{ kind:'h'|'li'|'p', text }].
function htmlToBlocks(html) {
  let s = String(html || '').replace(/\r/g, '');
  // Turn a callout into a paragraph so its text is captured as a block, then drop
  // any other wrapper divs (their inner block tags still parse on their own).
  s = s.replace(/<div[^>]*class="[^"]*callout[^"]*"[^>]*>([\s\S]*?)<\/div>/gi, (m, inner) => `<p>${inner}</p>`);
  s = s.replace(/<div[^>]*>/gi, ' ').replace(/<\/div>/gi, ' ');
  const blocks = [];
  const re = /<(h3|h4)[^>]*>([\s\S]*?)<\/\1>|<li[^>]*>([\s\S]*?)<\/li>|<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) blocks.push({ kind: 'h', text: stripInline(m[2]) });
    else if (m[3] != null) blocks.push({ kind: 'li', text: stripInline(m[3]) });
    else if (m[4] != null) blocks.push({ kind: 'p', text: stripInline(m[4]) });
  }
  const out = blocks.filter((b) => b.text);
  if (!out.length) { const t = stripInline(s); if (t) out.push({ kind: 'p', text: t }); }
  return out;
}

// Walk the course's exportable lessons, calling handlers. Shared by PDF + PPTX so
// both stay in sync. Returns the collected answer key lines.
function walkCourse(course, h) {
  const answerKey = [];
  let no = 0;
  for (const l of (course.lessons || [])) {
    if (!l || l.type === 'scorm') continue;
    no++;
    if (l.type === 'quiz') {
      h.quiz(no, l, (q, qi) => {
        const ai = Number(q.answer) || 0;
        answerKey.push(`${l.title || 'Quiz'} Q${qi + 1}: ${String.fromCharCode(65 + ai)}`);
      });
    } else {
      h.content(no, l, htmlToBlocks(l.html));
    }
  }
  return answerKey;
}

// ---- PDF (pdfkit) ----------------------------------------------------------
async function buildPdf(course) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 64, bottom: 64, left: 64, right: 64 }, info: { Title: course.title || 'Course' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));

  // Title header.
  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(22).text(course.title || 'Course');
  if (course.coBrandName) doc.moveDown(0.2).fillColor('#51607a').font('Helvetica').fontSize(11).text(course.coBrandName);
  if (course.description) doc.moveDown(0.4).fillColor('#333333').font('Helvetica').fontSize(11).text(course.description);

  const renderBlocks = (blocks) => {
    for (const b of blocks) {
      if (b.kind === 'h') {
        doc.moveDown(0.4).fillColor('#223355').font('Helvetica-Bold').fontSize(12.5).text(b.text);
      } else if (b.kind === 'li') {
        doc.fillColor('#1a2232').font('Helvetica').fontSize(11).text('•  ' + b.text, { indent: 12 });
      } else {
        doc.fillColor('#1a2232').font('Helvetica').fontSize(11).text(b.text);
      }
      doc.moveDown(0.2);
    }
  };

  const answerKey = walkCourse(course, {
    content(no, l, blocks) {
      doc.moveDown(0.7).fillColor(ACCENT).font('Helvetica-Bold').fontSize(15).text(`${no}. ${l.title || 'Lesson'}`).moveDown(0.2);
      renderBlocks(blocks);
      if (l.type === 'video' && l.videoUrl) doc.fillColor(ACCENT).font('Helvetica-Oblique').fontSize(11).text('Video: ' + l.videoUrl, { link: l.videoUrl, underline: true });
      if (l.type === 'slides') for (const s of (l.slides || [])) {
        if (s && s.video) doc.fillColor(ACCENT).font('Helvetica-Oblique').fontSize(11).text('Video: ' + s.video, { link: s.video, underline: true });
        if (s && s.caption) doc.fillColor('#51607a').font('Helvetica').fontSize(10).text(s.caption);
      }
    },
    quiz(no, l, onQuestion) {
      doc.moveDown(0.7).fillColor(ACCENT).font('Helvetica-Bold').fontSize(15).text(`${no}. ${l.title || 'Quiz'}`).moveDown(0.3);
      (l.questions || []).forEach((q, qi) => {
        doc.fillColor('#1a2232').font('Helvetica-Bold').fontSize(11).text(`Q${qi + 1}. ${q.prompt || ''}`);
        (q.options || []).forEach((opt, oi) => doc.font('Helvetica').fontSize(11).text(`${String.fromCharCode(65 + oi)}. ${opt}`, { indent: 16 }));
        onQuestion(q, qi);
        doc.moveDown(0.3);
      });
    },
  });

  if (answerKey.length) {
    doc.addPage();
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(16).text('Answer Key').moveDown(0.5);
    answerKey.forEach((a) => doc.fillColor('#1a2232').font('Helvetica').fontSize(11).text(a));
  }

  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), filename: `${niceSlug(course.title || course.id)}.pdf`, contentType: 'application/pdf' };
}

// ---- PowerPoint (pptxgenjs) ------------------------------------------------
async function buildPptx(course) {
  const Pptx = require('pptxgenjs');
  const p = new Pptx();
  p.layout = 'LAYOUT_WIDE'; // 13.3 x 7.5 in
  const W = 12.3;

  const title = p.addSlide();
  title.background = { color: 'FFFFFF' };
  title.addText(course.title || 'Course', { x: 0.5, y: 2.6, w: W, h: 1.4, fontSize: 34, bold: true, color: ACCENT_HEX, align: 'center' });
  if (course.coBrandName) title.addText(course.coBrandName, { x: 0.5, y: 4.0, w: W, h: 0.6, fontSize: 18, color: '51607A', align: 'center' });

  const answerKey = walkCourse(course, {
    content(no, l, blocks) {
      const s = p.addSlide();
      s.addText(`${no}. ${l.title || 'Lesson'}`, { x: 0.5, y: 0.3, w: W, h: 0.7, fontSize: 22, bold: true, color: ACCENT_HEX });
      const runs = [];
      for (const b of blocks) {
        if (b.kind === 'h') runs.push({ text: b.text, options: { fontSize: 18, bold: true, color: '223355', breakLine: true, paraSpaceBefore: 6, paraSpaceAfter: 4 } });
        else if (b.kind === 'li') runs.push({ text: b.text, options: { fontSize: 15, bullet: true, breakLine: true } });
        else runs.push({ text: b.text, options: { fontSize: 15, breakLine: true, paraSpaceAfter: 4 } });
      }
      if (l.type === 'video' && l.videoUrl) runs.push({ text: 'Watch the video', options: { fontSize: 15, color: ACCENT_HEX, breakLine: true, hyperlink: { url: l.videoUrl } } });
      if (l.type === 'slides') for (const sl of (l.slides || [])) if (sl && sl.video) runs.push({ text: 'Watch the video', options: { fontSize: 15, color: ACCENT_HEX, breakLine: true, hyperlink: { url: sl.video } } });
      if (!runs.length) runs.push({ text: ' ', options: {} });
      s.addText(runs, { x: 0.7, y: 1.2, w: W - 0.4, h: 5.8, color: '1A2232', valign: 'top' });
    },
    quiz(no, l, onQuestion) {
      (l.questions || []).forEach((q, qi) => {
        const s = p.addSlide();
        s.addText(`${l.title || 'Quiz'} — Question ${qi + 1}`, { x: 0.5, y: 0.3, w: W, h: 0.7, fontSize: 18, bold: true, color: ACCENT_HEX });
        const runs = [{ text: q.prompt || '', options: { fontSize: 20, bold: true, breakLine: true, paraSpaceAfter: 12 } }];
        (q.options || []).forEach((opt, oi) => runs.push({ text: `${String.fromCharCode(65 + oi)}.  ${opt}`, options: { fontSize: 17, breakLine: true, paraSpaceAfter: 6 } }));
        s.addText(runs, { x: 0.7, y: 1.3, w: W - 0.4, h: 5.6, color: '1A2232', valign: 'top' });
        onQuestion(q, qi);
      });
    },
  });

  if (answerKey.length) {
    const s = p.addSlide();
    s.addText('Answer Key', { x: 0.5, y: 0.3, w: W, h: 0.7, fontSize: 22, bold: true, color: ACCENT_HEX });
    s.addText(answerKey.map((a) => ({ text: a, options: { fontSize: 15, breakLine: true } })), { x: 0.7, y: 1.2, w: W - 0.4, h: 5.8, color: '1A2232', valign: 'top' });
  }

  const buffer = await p.write('nodebuffer');
  return { buffer, filename: `${niceSlug(course.title || course.id)}.pptx`, contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
}

const DOC_FORMATS = {
  pdf: { ext: 'pdf', ct: 'application/pdf' },
  pptx: { ext: 'pptx', ct: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};

async function buildDocument(course, { format } = {}) {
  if (format === 'pptx') return buildPptx(course);
  return buildPdf(course);
}

module.exports = { buildPdf, buildPptx, buildDocument, DOC_FORMATS, htmlToBlocks, niceSlug };
