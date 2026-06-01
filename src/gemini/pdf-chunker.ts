/**
 * PDF Chunker Utility
 *
 * Splits large PDFs into smaller chunks that fit within Gemini's limits:
 * - Max 50MB per file
 * - Max 1000 pages per file
 *
 * Uses pdf-lib for pure JavaScript PDF manipulation (no system dependencies).
 */

import { PDFDocument } from "pdf-lib";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { log } from "../utils/logger.js";

/**
 * Gemini file limits
 */
export const GEMINI_LIMITS = {
  maxFileSizeBytes: 50 * 1024 * 1024, // 50MB
  maxPages: 1000,
  // Use conservative chunk sizes to stay well under limits
  chunkPages: 500, // Pages per chunk
  chunkSizeBytes: 25 * 1024 * 1024, // 25MB target per chunk
};

/**
 * Hard DoS-protection ceilings. These are distinct from the chunking thresholds
 * above (which decide *whether* to split a legitimately large file). A file
 * above these ceilings is REJECTED outright — never read fully into memory or
 * parsed — because an untrusted PDF (decompression bomb, deeply-nested object
 * graph, absurd page count) can OOM the process from a single upload.
 */
// Reject any file larger than this BEFORE reading it into memory.
const MAX_ACCEPTED_FILE_SIZE_BYTES = 200 * 1024 * 1024; // 200MB
// Reject any PDF with more pages than this AFTER load, before walking the graph.
const MAX_ACCEPTED_PAGES = 10_000;

/**
 * Result of PDF analysis
 */
export interface PdfAnalysis {
  filePath: string;
  fileName: string;
  fileSize: number;
  pageCount: number;
  needsChunking: boolean;
  estimatedChunks: number;
  reason?: string;
}

/**
 * Result of PDF chunking
 */
export interface PdfChunk {
  chunkIndex: number;
  totalChunks: number;
  filePath: string;
  fileName: string;
  pageStart: number;
  pageEnd: number;
  pageCount: number;
  fileSize: number;
}

/**
 * Result of chunking operation
 */
export interface ChunkingResult {
  success: boolean;
  originalFile: string;
  chunks: PdfChunk[];
  totalPages: number;
  error?: string;
}

/**
 * Analyze a PDF to determine if it needs chunking
 */
export async function analyzePdf(filePath: string): Promise<PdfAnalysis> {
  const stats = await fs.promises.stat(filePath);
  const fileName = path.basename(filePath);
  const fileSize = stats.size;

  // DoS guard: reject absurdly large files BEFORE reading them into memory.
  if (fileSize > MAX_ACCEPTED_FILE_SIZE_BYTES) {
    throw new Error(
      `PDF rejected: file size ${formatBytes(fileSize)} exceeds the hard limit of ${formatBytes(MAX_ACCEPTED_FILE_SIZE_BYTES)}`
    );
  }

  // Files between the chunk threshold and the hard ceiling are legitimately
  // large and get split into chunks (page count is unknown until read).
  if (fileSize > GEMINI_LIMITS.maxFileSizeBytes) {
    const estimatedChunks = Math.ceil(
      fileSize / GEMINI_LIMITS.chunkSizeBytes
    );
    return {
      filePath,
      fileName,
      fileSize,
      pageCount: -1, // Unknown until we read it
      needsChunking: true,
      estimatedChunks,
      reason: `File size ${formatBytes(fileSize)} exceeds 50MB limit`,
    };
  }

  // Read PDF to get page count. Do NOT ignore encryption: refuse to decrypt
  // hostile input. PDFDocument.load throws on encrypted documents when
  // ignoreEncryption is false, which we treat as a fail-closed rejection below.
  let pdfDoc: PDFDocument;
  try {
    const pdfBytes = await fs.promises.readFile(filePath);
    pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: false,
    });
  } catch (error) {
    // FAIL CLOSED: an unparseable/encrypted/malformed PDF is rejected rather
    // than passed downstream for Gemini to "handle".
    const msg = error instanceof Error ? error.message : String(error);
    log.warning(`Rejecting PDF ${fileName}: could not parse (it may be encrypted or malformed): ${msg}`);
    throw new Error(`PDF rejected: could not parse (it may be encrypted or malformed): ${msg}`);
  }

  const pageCount = pdfDoc.getPageCount();

  // DoS guard: reject PDFs with an absurd page count.
  if (pageCount > MAX_ACCEPTED_PAGES) {
    throw new Error(
      `PDF rejected: page count ${pageCount} exceeds the hard limit of ${MAX_ACCEPTED_PAGES}`
    );
  }

  if (pageCount > GEMINI_LIMITS.maxPages) {
    const estimatedChunks = Math.ceil(pageCount / GEMINI_LIMITS.chunkPages);
    return {
      filePath,
      fileName,
      fileSize,
      pageCount,
      needsChunking: true,
      estimatedChunks,
      reason: `Page count ${pageCount} exceeds 1000 page limit`,
    };
  }

  return {
    filePath,
    fileName,
    fileSize,
    pageCount,
    needsChunking: false,
    estimatedChunks: 1,
  };
}

/**
 * Split a PDF into chunks
 */
export async function chunkPdf(filePath: string): Promise<ChunkingResult> {
  const fileName = path.basename(filePath, ".pdf");
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pdf-chunks-")
  );

  try {
    log.info(`Chunking PDF: ${filePath}`);

    // DoS guard: reject absurdly large files BEFORE reading into memory.
    const stats = await fs.promises.stat(filePath);
    if (stats.size > MAX_ACCEPTED_FILE_SIZE_BYTES) {
      throw new Error(
        `PDF rejected: file size ${formatBytes(stats.size)} exceeds the hard limit of ${formatBytes(MAX_ACCEPTED_FILE_SIZE_BYTES)}`
      );
    }

    // Read the original PDF. Do NOT ignore encryption: refuse to decrypt
    // hostile input (load throws on encrypted PDFs when ignoreEncryption=false).
    const pdfBytes = await fs.promises.readFile(filePath);
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: false,
    });
    const totalPages = pdfDoc.getPageCount();

    // DoS guard: reject PDFs with an absurd page count before walking the graph.
    if (totalPages > MAX_ACCEPTED_PAGES) {
      throw new Error(
        `PDF rejected: page count ${totalPages} exceeds the hard limit of ${MAX_ACCEPTED_PAGES}`
      );
    }

    log.info(`PDF has ${totalPages} pages, splitting into chunks...`);

    const chunks: PdfChunk[] = [];
    let currentPage = 0;
    let chunkIndex = 0;

    while (currentPage < totalPages) {
      // Calculate chunk range
      const pageStart = currentPage;
      const pageEnd = Math.min(
        currentPage + GEMINI_LIMITS.chunkPages - 1,
        totalPages - 1
      );
      const chunkPageCount = pageEnd - pageStart + 1;

      // Create new PDF for this chunk
      const chunkDoc = await PDFDocument.create();
      const pageIndices = Array.from(
        { length: chunkPageCount },
        (_, i) => pageStart + i
      );
      const copiedPages = await chunkDoc.copyPages(pdfDoc, pageIndices);

      for (const page of copiedPages) {
        chunkDoc.addPage(page);
      }

      // Save chunk to temp file
      const chunkFileName = `${fileName}_chunk_${chunkIndex + 1}.pdf`;
      const chunkFilePath = path.join(tempDir, chunkFileName);
      const chunkBytes = await chunkDoc.save();
      await fs.promises.writeFile(chunkFilePath, chunkBytes);

      const chunkStats = await fs.promises.stat(chunkFilePath);

      chunks.push({
        chunkIndex,
        totalChunks: -1, // Will update after
        filePath: chunkFilePath,
        fileName: chunkFileName,
        pageStart: pageStart + 1, // 1-indexed for display
        pageEnd: pageEnd + 1,
        pageCount: chunkPageCount,
        fileSize: chunkStats.size,
      });

      log.info(
        `  Chunk ${chunkIndex + 1}: pages ${pageStart + 1}-${pageEnd + 1} (${formatBytes(chunkStats.size)})`
      );

      currentPage = pageEnd + 1;
      chunkIndex++;
    }

    // Update total chunks count
    for (const chunk of chunks) {
      chunk.totalChunks = chunks.length;
    }

    log.info(
      `Split into ${chunks.length} chunks, stored in ${tempDir}`
    );

    return {
      success: true,
      originalFile: filePath,
      chunks,
      totalPages,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error(`Failed to chunk PDF: ${errorMsg}`);

    // Clean up temp directory on failure
    try {
      await fs.promises.rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }

    return {
      success: false,
      originalFile: filePath,
      chunks: [],
      totalPages: 0,
      error: errorMsg,
    };
  }
}

/**
 * Clean up chunk files after upload
 */
export async function cleanupChunks(chunks: PdfChunk[]): Promise<void> {
  if (chunks.length === 0) return;

  // Get the temp directory from the first chunk
  const tempDir = path.dirname(chunks[0].filePath);

  try {
    await fs.promises.rm(tempDir, { recursive: true });
    log.info(`Cleaned up chunk temp directory: ${tempDir}`);
  } catch (error) {
    log.warning(`Failed to cleanup chunks: ${error}`);
  }
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
