/*
 * Worker entry when the site is served over http(s), e.g. GitHub Pages.
 * On file:// the same modules are rebuilt into a Blob worker instead (see js/pool.js).
 * Keep this list in sync with the worker modules in index.html.
 */
importScripts(
  'qc.js',
  'formats.js',
  'convert/zip.js',
  'convert/bmp.js',
  'convert/tiff.js',
  'convert/codecs.js',
  'convert/ico.js',
  'convert/image.js',
  'convert/markup.js',
  'convert/doc.js',
  'convert/docx.js',
  'convert/data.js',
  'convert/video.js',
  'convert/jobs.js'
);
QC.jobs.listen(self);
