import { createHash } from 'node:crypto';
import path from 'node:path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';

export type SupportedDocumentType = 'pdf' | 'txt' | 'csv' | 'docx' | 'xlsx';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_CHUNKS_PER_FILE = 80;
const CHUNK_CHAR_LIMIT = 2400;
const CHUNK_OVERLAP_CHARS = 220;

export interface ExtractedDocumentChunk {
  chunkIndex: number;
  content: string;
  contentHash: string;
  filename: string;
  pageOrSheet: string;
  sectionOrRow: string;
  extractedAt: Date;
}

export interface ParsedDocumentResult {
  fileType: SupportedDocumentType;
  sanitizedFilename: string;
  sha256: string;
  chunks: ExtractedDocumentChunk[];
}

const ALLOWED_MIMES_BY_EXT: Record<SupportedDocumentType, string[]> = {
  pdf: ['application/pdf', 'application/x-pdf', 'application/octet-stream'],
  txt: ['text/plain', 'text/markdown', 'application/octet-stream'],
  csv: ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream'],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream',
  ],
  xlsx: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/octet-stream',
  ],
};

export function sanitizeFilename(rawName: string): string {
  const base = path.basename(rawName || 'document.txt').replace(/[^\w.\- ()]/g, '_');
  return base.slice(0, 140) || 'document.txt';
}

export function detectAndValidateFileType(params: {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}): SupportedDocumentType {
  if (!params.buffer || params.buffer.length === 0) {
    throw new Error('Uploaded file is empty.');
  }
  if (params.buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit.`);
  }

  const ext = path.extname(params.filename).toLowerCase().replace('.', '');
  if (ext !== 'pdf' && ext !== 'txt' && ext !== 'csv' && ext !== 'docx' && ext !== 'xlsx') {
    throw new Error('Unsupported file extension. Allowed formats: PDF, TXT, CSV, DOCX, XLSX.');
  }

  const cleanMime = params.mimeType.split(';')[0].trim().toLowerCase();
  if (cleanMime && !ALLOWED_MIMES_BY_EXT[ext].includes(cleanMime)) {
    throw new Error(`Invalid MIME type (${cleanMime}) for .${ext} file.`);
  }

  // Magic-byte verification for binary formats
  if (ext === 'pdf') {
    const header = params.buffer.subarray(0, 5).toString('ascii');
    if (header !== '%PDF-') {
      throw new Error('File content does not match valid PDF signature.');
    }
  } else if (ext === 'docx' || ext === 'xlsx') {
    const zipSig = params.buffer.subarray(0, 2).toString('ascii');
    if (zipSig !== 'PK') {
      throw new Error(`File content does not match valid .${ext} archive signature.`);
    }
  } else {
    // Reject obvious binary payloads masquerading as TXT/CSV
    const sample = params.buffer.subarray(0, Math.min(4096, params.buffer.length));
    if (sample.includes(0)) {
      throw new Error(`Binary bytes detected inside .${ext} text file.`);
    }
  }

  return ext;
}

export function sanitizeUntrustedDocumentText(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/<\/?(system_instructions|untrusted_document_chunk|verified_catalog|master_memory|approval_override)>/gi, '[tag]')
    .replace(/\r\n/g, '\n')
    .trim();
}

function splitLongTextWithLineRefs(
  rawText: string,
  filename: string,
  pageOrSheet: string,
  extractedAt: Date,
  startIndex: number,
  sectionPrefix = 'Section',
): ExtractedDocumentChunk[] {
  const clean = sanitizeUntrustedDocumentText(rawText);
  if (!clean) return [];

  const chunks: ExtractedDocumentChunk[] = [];
  if (clean.length <= CHUNK_CHAR_LIMIT) {
    const contentHash = createHash('sha256').update(clean).digest('hex');
    chunks.push({
      chunkIndex: startIndex,
      content: clean,
      contentHash,
      filename,
      pageOrSheet,
      sectionOrRow: `${sectionPrefix} 1`,
      extractedAt,
    });
    return chunks;
  }

  const paragraphs = clean.split(/\n{2,}/);
  let buffer = '';
  let partNum = 1;

  const pushChunk = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    chunks.push({
      chunkIndex: startIndex + chunks.length,
      content: trimmed,
      contentHash: createHash('sha256').update(trimmed).digest('hex'),
      filename,
      pageOrSheet,
      sectionOrRow: `${sectionPrefix} ${partNum++}`,
      extractedAt,
    });
  };

  for (const para of paragraphs) {
    if (para.length > CHUNK_CHAR_LIMIT) {
      if (buffer.trim()) {
        pushChunk(buffer);
        buffer = '';
      }
      let offset = 0;
      while (offset < para.length) {
        const slice = para.slice(offset, offset + CHUNK_CHAR_LIMIT);
        pushChunk(slice);
        offset += Math.max(400, CHUNK_CHAR_LIMIT - CHUNK_OVERLAP_CHARS);
      }
      continue;
    }

    if (buffer.length + para.length + 2 > CHUNK_CHAR_LIMIT && buffer.trim()) {
      const overlap = buffer.slice(-CHUNK_OVERLAP_CHARS).trim();
      pushChunk(buffer);
      buffer = overlap ? `${overlap}\n\n${para}` : para;
    } else {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
    }
  }

  if (buffer.trim()) {
    pushChunk(buffer);
  }

  return chunks;
}

export function parseCsvRows(rawCsv: string): string[][] {
  const text = rawCsv.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

function chunkTabularRows(params: {
  rows: string[][];
  filename: string;
  pageOrSheet: string;
  extractedAt: Date;
  startIndex: number;
}): ExtractedDocumentChunk[] {
  const { rows, filename, pageOrSheet, extractedAt, startIndex } = params;
  if (rows.length === 0) return [];

  const headers = rows[0].map((h, idx) => h || `Column_${idx + 1}`);
  const dataRows = rows.length > 1 ? rows.slice(1) : rows;
  const headerLine = `| ${headers.join(' | ')} |`;
  const sepLine = `| ${headers.map(() => '---').join(' | ')} |`;

  const chunks: ExtractedDocumentChunk[] = [];
  let batchLines: string[] = [];
  let batchStartRow = rows.length > 1 ? 2 : 1;
  let currentCharCount = headerLine.length + sepLine.length + 4;

  const flushBatch = (endRow: number) => {
    if (batchLines.length === 0) return;
    const content = sanitizeUntrustedDocumentText([headerLine, sepLine, ...batchLines].join('\n'));
    chunks.push({
      chunkIndex: startIndex + chunks.length,
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      filename,
      pageOrSheet,
      sectionOrRow: `Rows ${batchStartRow}-${endRow}`,
      extractedAt,
    });
    batchLines = [];
    currentCharCount = headerLine.length + sepLine.length + 4;
  };

  for (let i = 0; i < dataRows.length; i++) {
    const excelRowNum = (rows.length > 1 ? 2 : 1) + i;
    const rowCells = headers.map((_, colIdx) => String(dataRows[i][colIdx] ?? '').replace(/\|/g, '/').trim());
    const rowLine = `| ${rowCells.join(' | ')} |`;

    if (
      batchLines.length > 0 &&
      (batchLines.length >= 18 || currentCharCount + rowLine.length + 2 > CHUNK_CHAR_LIMIT)
    ) {
      flushBatch(excelRowNum - 1);
      batchStartRow = excelRowNum;
    }

    batchLines.push(rowLine);
    currentCharCount += rowLine.length + 1;
  }

  flushBatch((rows.length > 1 ? 1 : 0) + dataRows.length);
  return chunks;
}

function cellValueToString(val: ExcelJS.CellValue): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return String(val).trim();
  }
  if (val instanceof Date) {
    return val.toISOString().split('T')[0];
  }
  if (typeof val === 'object') {
    if ('result' in val && val.result !== undefined) {
      return String(val.result).trim();
    }
    if ('text' in val && typeof val.text === 'string') {
      return val.text.trim();
    }
    if ('richText' in val && Array.isArray(val.richText)) {
      return val.richText.map((r) => r.text).join('').trim();
    }
  }
  return String(val).trim();
}

export async function parseAndChunkDocument(params: {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<ParsedDocumentResult> {
  const sanitizedFilename = sanitizeFilename(params.filename);
  const fileType = detectAndValidateFileType({
    filename: sanitizedFilename,
    mimeType: params.mimeType,
    buffer: params.buffer,
  });

  const sha256 = createHash('sha256').update(params.buffer).digest('hex');
  const extractedAt = new Date();
  let chunks: ExtractedDocumentChunk[] = [];

  if (fileType === 'pdf') {
    const result = await extractPdfText(new Uint8Array(params.buffer), { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [String(result.text || '')];
    for (let i = 0; i < pages.length; i++) {
      const pageChunks = splitLongTextWithLineRefs(
        pages[i] || '',
        sanitizedFilename,
        `Page ${i + 1}`,
        extractedAt,
        chunks.length,
        'Part',
      );
      chunks.push(...pageChunks);
      if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
    }
  } else if (fileType === 'txt') {
    const rawText = params.buffer.toString('utf8');
    chunks = splitLongTextWithLineRefs(
      rawText,
      sanitizedFilename,
      'Text Document',
      extractedAt,
      0,
      'Section',
    );
  } else if (fileType === 'csv') {
    const rows = parseCsvRows(params.buffer.toString('utf8'));
    chunks = chunkTabularRows({
      rows,
      filename: sanitizedFilename,
      pageOrSheet: 'CSV Table',
      extractedAt,
      startIndex: 0,
    });
  } else if (fileType === 'docx') {
    const result = await mammoth.extractRawText({ buffer: params.buffer });
    chunks = splitLongTextWithLineRefs(
      result.value || '',
      sanitizedFilename,
      'Word Document',
      extractedAt,
      0,
      'Section',
    );
  } else if (fileType === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(params.buffer as unknown as ArrayBuffer);
    for (const worksheet of workbook.worksheets) {
      const sheetRows: string[][] = [];
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
        const cells = vals.map((v) => cellValueToString(v as ExcelJS.CellValue));
        if (cells.some((c) => c.length > 0)) {
          sheetRows.push(cells);
        }
      });
      const sheetChunks = chunkTabularRows({
        rows: sheetRows,
        filename: sanitizedFilename,
        pageOrSheet: `Sheet: ${worksheet.name}`,
        extractedAt,
        startIndex: chunks.length,
      });
      chunks.push(...sheetChunks);
      if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
    }
  }

  if (chunks.length === 0) {
    throw new Error('No readable text or tabular data could be extracted from this file.');
  }

  if (chunks.length > MAX_CHUNKS_PER_FILE) {
    chunks = chunks.slice(0, MAX_CHUNKS_PER_FILE);
  }

  return {
    fileType,
    sanitizedFilename,
    sha256,
    chunks,
  };
}
