const busboy = require('busboy');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB per file
const MAX_FILES_PER_REQUEST = 5;
const MAX_EXTRACTED_CHARS_PER_FILE = 20000;
const MAX_TOTAL_ATTACHMENT_CHARS = 30000;

const SUPPORTED_TYPES = {
  pdf: {
    extensions: ['.pdf'],
    mimetypes: ['application/pdf'],
  },
  docx: {
    extensions: ['.docx'],
    mimetypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
};

function detectFileKind(filename, mimetype) {
  const lowerName = (filename || '').toLowerCase();
  const lowerMime = (mimetype || '').toLowerCase();

  for (const [kind, spec] of Object.entries(SUPPORTED_TYPES)) {
    if (spec.extensions.some(ext => lowerName.endsWith(ext)) || spec.mimetypes.includes(lowerMime)) {
      return kind;
    }
  }
  return null;
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

function truncateText(text, maxChars) {
  const normalized = (text || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return { text: normalized, truncated: false };
  }
  return { text: normalized.slice(0, maxChars), truncated: true };
}

/**
 * Parses a multipart/form-data upload of PDF/DOCX files off the raw request
 * stream and extracts their text content. No files are written to disk;
 * everything is buffered and parsed in memory.
 */
function collectUploadedFiles(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_FILE_BYTES,
          files: MAX_FILES_PER_REQUEST,
        },
      });
    } catch (error) {
      reject(Object.assign(new Error('Invalid upload request.'), { statusCode: 400 }));
      return;
    }

    const files = [];
    let rejected = false;

    bb.on('file', (fieldname, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      let sizeLimitHit = false;

      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => {
        sizeLimitHit = true;
      });
      stream.on('close', () => {
        files.push({
          filename,
          mimetype: mimeType,
          buffer: Buffer.concat(chunks),
          sizeLimitHit,
        });
      });
    });

    bb.on('filesLimit', () => {
      rejected = true;
    });

    bb.on('error', (error) => {
      reject(error);
    });

    bb.on('close', () => {
      if (rejected) {
        reject(Object.assign(new Error(`A maximum of ${MAX_FILES_PER_REQUEST} files can be attached at once.`), { statusCode: 400 }));
        return;
      }
      resolve(files);
    });

    req.pipe(bb);
  });
}

async function extractTextForFile(file) {
  const kind = detectFileKind(file.filename, file.mimetype);

  if (!kind) {
    return {
      name: file.filename,
      status: 'unsupported',
      error: 'Only PDF and DOCX files are supported right now.',
    };
  }

  if (file.sizeLimitHit) {
    return {
      name: file.filename,
      status: 'too_large',
      error: `File exceeds the ${Math.round(MAX_FILE_BYTES / (1024 * 1024))}MB attachment limit.`,
    };
  }

  if (!file.buffer || file.buffer.length === 0) {
    return {
      name: file.filename,
      status: 'empty',
      error: 'The file appears to be empty.',
    };
  }

  try {
    const rawText = kind === 'pdf'
      ? await extractPdfText(file.buffer)
      : await extractDocxText(file.buffer);

    if (!rawText || !rawText.trim()) {
      return {
        name: file.filename,
        status: 'no_text',
        error: 'No readable text could be found in this document (it may be a scanned image).',
      };
    }

    const { text, truncated } = truncateText(rawText, MAX_EXTRACTED_CHARS_PER_FILE);

    return {
      name: file.filename,
      status: 'ready',
      size: file.buffer.length,
      kind,
      text,
      truncated,
      charCount: text.length,
    };
  } catch (error) {
    console.error(`[Attachments] Failed to extract text from "${file.filename}":`, error.message);
    return {
      name: file.filename,
      status: 'error',
      error: 'This file could not be read. It may be corrupted or password-protected.',
    };
  }
}

async function handleAttachmentUpload(req) {
  const files = await collectUploadedFiles(req);

  if (files.length === 0) {
    const error = new Error('No files were received.');
    error.statusCode = 400;
    throw error;
  }

  const attachments = await Promise.all(files.map(extractTextForFile));
  return { attachments };
}

/**
 * Builds the "attached document" context block injected into the LLM
 * prompt, keeping the combined size bounded regardless of how many
 * attachments the client sends.
 */
function buildAttachmentContextBlock(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return '';
  }

  let remainingBudget = MAX_TOTAL_ATTACHMENT_CHARS;
  const sections = [];

  for (const attachment of attachments) {
    const name = typeof attachment?.name === 'string' ? attachment.name.trim() : '';
    const text = typeof attachment?.text === 'string' ? attachment.text.trim() : '';
    if (!name || !text || remainingBudget <= 0) continue;

    const snippet = text.slice(0, remainingBudget);
    remainingBudget -= snippet.length;

    sections.push(`[Attached Document: "${name}"]\n${snippet}`);
  }

  if (sections.length === 0) return '';

  return sections.join('\n\n---\n\n');
}

module.exports = {
  handleAttachmentUpload,
  buildAttachmentContextBlock,
  MAX_FILE_BYTES,
  MAX_FILES_PER_REQUEST,
};
