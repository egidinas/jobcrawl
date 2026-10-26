// Text of a CV file, read in the browser: PDF through the vendored pdf.js 4.10.38 (Apache-2.0), plain text and Markdown as they are.
// The file never leaves the device. Word files are not read; the caller says so.
const base = new URL('.', import.meta.url);
export async function fileText(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const pdfjs = await import(new URL('vendor/pdfjs/pdf.min.js', base).href);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.js', base).href;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise, out = [];
    for (let p = 1; p <= Math.min(doc.numPages, 12); p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      out.push(tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
    }
    const text = out.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // a scanned CV is only pictures of text: say so instead of handing back an empty text
    if (text.length < 20) throw new Error('No text found in this PDF (a scanned document?). Paste the text instead, or save the CV as a PDF with text.');
    return text;
  }
  if (/\.(txt|md|text)$/.test(name) || (file.type || '').startsWith('text/')) return (await file.text()).trim();
  throw new Error(name.endsWith('.docx') || name.endsWith('.doc') ? 'Word files cannot be read here; save the CV as PDF or paste the text.' : 'Only PDF and text files can be read.');
}
