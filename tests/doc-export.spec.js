// Flat-handout exports: a course can be downloaded as a PDF or a PowerPoint for
// print / in-person use, alongside the interactive SCORM + web packages. Also
// checks that the standalone web package ships a plain-language README.
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');
const { buildPdf, buildPptx, htmlToBlocks } = require('../lib/docexport');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

test('htmlToBlocks turns allowed HTML into ordered text blocks', () => {
  const blocks = htmlToBlocks('<h3>Steps</h3><p>Stop <strong>now</strong>.</p><ul><li>One</li><li>Two</li></ul><div class="callout">Always report.</div>');
  expect(blocks[0]).toEqual({ kind: 'h', text: 'Steps' });
  expect(blocks[1]).toEqual({ kind: 'p', text: 'Stop now.' });
  expect(blocks.filter((b) => b.kind === 'li').map((b) => b.text)).toEqual(['One', 'Two']);
  expect(blocks.some((b) => b.text === 'Always report.')).toBe(true); // callout text is kept
});

test('buildPdf and buildPptx produce real files from a text+quiz course', async () => {
  const course = { id: 'c', title: 'Procedures', lessons: [
    { type: 'text', title: 'Read', html: '<p>Hello</p>' },
    { type: 'quiz', title: 'Check', passPercent: 80, questions: [{ prompt: 'First?', options: ['No', 'Yes'], answer: 1 }] },
    { type: 'scorm', title: 'Skipped', packageId: 'x' },
  ] };
  const pdf = await buildPdf(course);
  expect(pdf.contentType).toBe('application/pdf');
  expect(pdf.buffer.slice(0, 5).toString()).toBe('%PDF-'); // PDF magic
  expect(pdf.filename).toBe('Procedures.pdf');

  const pptx = await buildPptx(course);
  expect(pptx.contentType).toContain('presentationml');
  expect(pptx.buffer.slice(0, 2).toString()).toBe('PK'); // pptx is a zip
  expect(pptx.filename).toBe('Procedures.pptx');
});

test('the export endpoint serves PDF, PowerPoint, and a labeled web package', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const stamp = Date.now();
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Export Doc ${stamp}`, audience: 'referees' } })).json()).course;
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'Intro', html: '<h3>Hi</h3><p>Body</p>' } });
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'quiz', title: 'Quiz', passPercent: 80, questions: [{ prompt: 'Q?', options: ['a', 'b'], answer: 0 }] } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

  // PDF
  const pdf = await api.get(`/api/admin/courses/${course.id}/export?format=pdf`);
  expect(pdf.ok()).toBeTruthy();
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).slice(0, 5).toString()).toBe('%PDF-');

  // PowerPoint
  const pptx = await api.get(`/api/admin/courses/${course.id}/export?format=pptx`);
  expect(pptx.ok()).toBeTruthy();
  expect(pptx.headers()['content-type']).toContain('presentationml');
  expect((await pptx.body()).slice(0, 2).toString()).toBe('PK');

  // Web package carries a README that explains what it is / how to open it.
  const web = await api.get(`/api/admin/courses/${course.id}/export?format=web`);
  expect(web.ok()).toBeTruthy();
  const zip = new AdmZip(await web.body());
  const names = zip.getEntries().map((e) => e.entryName);
  expect(names).toContain('README.txt');
  expect(names).toContain('index.html');
  expect(zip.getEntry('README.txt').getData().toString()).toMatch(/double-click "index\.html"/i);
});
