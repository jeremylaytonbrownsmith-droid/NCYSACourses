// Sanitizer for staff/partner-authored lesson HTML (the Course Designer's
// rich-text editor and slide captions). Unlike the strict allow-list in
// lib/aicourse.js (which is tuned for AI-generated reading text and strips ALL
// attributes), this keeps the formatting real authors use — links, images,
// headings, lists, tables — while removing anything that can execute script:
// <script>/<style>/<iframe>, inline event handlers, javascript:/data: URLs, and
// style attributes. Backed by the well-tested `sanitize-html` library rather than
// hand-rolled regex, because once attributes (href/src) are allowed, regex
// sanitizers are easy to bypass.
const sanitizeHtmlLib = require('sanitize-html');

const OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'blockquote', 'pre', 'code',
    'ul', 'ol', 'li',
    'strong', 'em', 'b', 'i', 'u', 's', 'sub', 'sup', 'span', 'div',
    'a', 'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'col', 'colgroup',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    div: ['class'],
    span: ['class'],
    p: ['class'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    col: ['span'],
    colgroup: ['span'],
  },
  // Links: only safe schemes. Images: http(s) or relative (e.g. /uploads/…); no
  // data: URIs (a data:text/html or scripted SVG payload is blocked that way too).
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  // style attributes are not in allowedAttributes, so they are dropped entirely.
  allowedStyles: {},
  // Make any target=_blank link safe against reverse-tabnabbing.
  transformTags: {
    a: (tagName, attribs) => {
      if (attribs.target === '_blank') attribs.rel = 'noopener noreferrer';
      return { tagName, attribs };
    },
  },
  disallowedTagsMode: 'discard',
};

function sanitizeLessonHtml(html) {
  if (html == null) return '';
  return sanitizeHtmlLib(String(html), OPTIONS).trim();
}

module.exports = { sanitizeLessonHtml };
