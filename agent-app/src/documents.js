const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

async function parseDocument(filePath, mimeType, originalName) {
  const ext = (originalName || '').split('.').pop().toLowerCase();
  const mime = (mimeType || '').toLowerCase();

  if (ext === 'pdf' || mime === 'application/pdf') {
    const dataBuffer = fs.readFileSync(filePath);
    const parsed = await pdfParse(dataBuffer);
    return parsed.text || '';
  }

  if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  }

  if (ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'json' || mime.startsWith('text/')) {
    return fs.readFileSync(filePath, 'utf8');
  }

  // fallback: try as text
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return '';
  }
}

module.exports = { parseDocument };
