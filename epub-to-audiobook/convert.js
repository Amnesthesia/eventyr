#!/usr/bin/env node
'use strict';

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const EPub = require('epub');
const fs = require('fs-extra');
const path = require('path');
const { load: cheerioLoad } = require('cheerio');

// ── CLI ───────────────────────────────────────────────────────────────────────

const argv = yargs(hideBin(process.argv))
  .scriptName('epub-to-audiobook')
  .usage('Usage: $0 <epub-file> [options]')
  .example('$0 book.epub --voice nova --output-dir ./my-audiobook')
  .example('$0 book.epub --resume-from 5   # restart from chapter 5')
  .positional('epub-file', { describe: 'Path to the EPUB file', type: 'string' })
  .option('voice', {
    alias: 'v',
    type: 'string',
    default: process.env.TTS_VOICE || 'alloy',
    choices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
    description: 'OpenAI TTS voice',
  })
  .option('format', {
    alias: 'f',
    type: 'string',
    default: process.env.TTS_FORMAT || 'mp3',
    choices: ['mp3', 'opus', 'aac', 'flac'],
    description: 'Output audio format',
  })
  .option('tts-model', {
    type: 'string',
    default: process.env.TTS_MODEL || 'tts-1',
    choices: ['tts-1', 'tts-1-hd'],
    description: 'OpenAI TTS model (tts-1-hd is higher quality but slower)',
  })
  .option('chunk-size', {
    alias: 'c',
    type: 'number',
    default: parseInt(process.env.CHUNK_SIZE || '2000', 10),
    description: 'Max characters per chunk sent to Claude for SSML markup',
  })
  .option('output-dir', {
    alias: 'o',
    type: 'string',
    default: process.env.OUTPUT_DIR || './audiobook-output',
    description: 'Directory for output files and progress state',
  })
  .option('resume-from', {
    alias: 'r',
    type: 'number',
    description: 'Force-resume from this chapter index (0-based), discarding later progress',
  })
  .option('no-resume', {
    type: 'boolean',
    default: false,
    description: 'Ignore any saved progress and start fresh',
  })
  .demandCommand(1, 'Please supply an EPUB file path as the first argument.')
  .help()
  .argv;

// ── Logging ───────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(...args) { console.log(`[${timestamp()}]`, ...args); }
function logError(...args) { console.error(`[${timestamp()}] ERROR:`, ...args); }

// ── Text utilities ────────────────────────────────────────────────────────────

/** Strip HTML to plain text using cheerio. */
function htmlToPlainText(html) {
  const $ = cheerioLoad(html);
  $('script, style, head').remove();
  // Preserve paragraph breaks as double newlines
  $('p, br, h1, h2, h3, h4, h5, h6, li').after('\n\n');
  const text = $.root().text();
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split text into chunks no larger than maxSize, preferring sentence boundaries.
 * Falls back to word boundaries for sentences longer than maxSize.
 */
function splitIntoChunks(text, maxSize) {
  if (text.length <= maxSize) return [text];

  const chunks = [];
  // Split on sentence-ending punctuation followed by whitespace
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > maxSize) {
      // Flush current buffer first
      if (current.trim()) { chunks.push(current.trim()); current = ''; }
      // Split long sentence on word boundaries
      let remaining = sentence;
      while (remaining.length > maxSize) {
        const cut = remaining.lastIndexOf(' ', maxSize);
        const boundary = cut > 0 ? cut : maxSize;
        chunks.push(remaining.slice(0, boundary).trim());
        remaining = remaining.slice(boundary).trim();
      }
      current = remaining;
    } else if (current.length + 1 + sentence.length > maxSize) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Convert SSML to TTS-ready plain text:
 * - <break> tags → ellipsis (longer breaks = more dots) for pacing cues
 * - All other tags stripped
 */
function ssmlToTtsText(ssml) {
  let text = ssml.replace(/<break([^/]*)\/?>/gi, (_, attrs) => {
    const timeMatch = attrs.match(/time=["']?(\d+(?:\.\d+)?)(ms|s)/i);
    if (timeMatch) {
      const ms = timeMatch[2].toLowerCase() === 's'
        ? parseFloat(timeMatch[1]) * 1000
        : parseFloat(timeMatch[1]);
      if (ms >= 800) return '... ';
      if (ms >= 400) return '.. ';
      return '. ';
    }
    return '... ';
  });
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Collapse whitespace but preserve paragraph pauses embedded in text
  return text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
}

// ── EPUB parsing ──────────────────────────────────────────────────────────────

function openEpub(epubPath) {
  return new Promise((resolve, reject) => {
    const book = new EPub(epubPath);
    book.on('end', () => resolve(book));
    book.on('error', reject);
    book.parse();
  });
}

function getChapterHtml(book, id) {
  return new Promise((resolve, reject) => {
    book.getChapter(id, (error, text) => {
      if (error) reject(new Error(`Failed to read chapter "${id}": ${error}`));
      else resolve(text || '');
    });
  });
}

async function extractChapters(epubPath) {
  log(`Opening EPUB: ${epubPath}`);
  const book = await openEpub(epubPath);

  const title = book.metadata.title || 'Unknown Title';
  const author = book.metadata.creator || 'Unknown Author';
  log(`Book: "${title}" by ${author}`);
  log(`Spine items: ${book.flow.length}`);

  const chapters = [];

  for (let spineIdx = 0; spineIdx < book.flow.length; spineIdx++) {
    const item = book.flow[spineIdx];
    let html;
    try {
      html = await getChapterHtml(book, item.id);
    } catch (e) {
      log(`  Warning: skipping spine[${spineIdx}] (${item.id}): ${e.message}`);
      continue;
    }

    const text = htmlToPlainText(html);
    // Skip near-empty items (cover pages, nav documents, etc.)
    if (text.length < 100) continue;

    const chapterTitle = item.title || `Chapter ${chapters.length + 1}`;
    chapters.push({
      index: chapters.length,
      spineIndex: spineIdx,
      id: item.id,
      title: chapterTitle,
      text,
    });
    log(`  [${String(chapters.length - 1).padStart(3)}] "${chapterTitle}" — ${text.length.toLocaleString()} chars`);
  }

  log(`Chapters with content: ${chapters.length}`);
  return { chapters, metadata: { title, author } };
}

// ── Claude SSML step ──────────────────────────────────────────────────────────

const SSML_SYSTEM = `You are a professional audiobook narrator assistant. Add SSML markup to text for natural spoken narration.

Guidelines:
- <break time="600ms"/> between paragraphs
- <break time="250ms"/> at commas and list items
- <break time="900ms"/> before/after dialogue attribution
- <emphasis level="moderate"> for important words or phrases
- <emphasis level="strong"> for exclamations or critical moments
- Do NOT change, paraphrase, or omit any words — only insert SSML tags
- Return ONLY the marked-up text with no preamble, explanation, or code fences`;

async function addSsmlMarkup(anthropic, text, chunkSize) {
  const rawChunks = splitIntoChunks(text, chunkSize);
  const marked = [];

  for (let i = 0; i < rawChunks.length; i++) {
    const chunk = rawChunks[i];
    const maxTokens = Math.min(4096, Math.ceil(chunk.length * 1.8) + 256);

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: maxTokens,
          system: SSML_SYSTEM,
          messages: [{ role: 'user', content: chunk }],
        });
        marked.push(response.content[0].text);
        break;
      } catch (e) {
        lastError = e;
        if (attempt < 3) {
          const wait = 1000 * attempt;
          log(`    Claude attempt ${attempt} failed (${e.message}), retrying in ${wait}ms…`);
          await sleep(wait);
        }
      }
    }
    if (lastError && marked.length <= i) throw lastError;
  }

  return marked.join('\n\n');
}

// ── OpenAI TTS step ───────────────────────────────────────────────────────────

// OpenAI TTS hard limit is 4096 characters per request
const TTS_MAX_CHARS = 4000;

async function synthesiseText(openai, text, voice, format, ttsModel) {
  const chunks = splitIntoChunks(text, TTS_MAX_CHARS);
  const buffers = [];

  for (let i = 0; i < chunks.length; i++) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await openai.audio.speech.create({
          model: ttsModel,
          voice,
          input: chunks[i],
          response_format: format,
        });
        buffers.push(Buffer.from(await response.arrayBuffer()));
        break;
      } catch (e) {
        lastError = e;
        if (attempt < 3) {
          const wait = 2000 * attempt;
          log(`    TTS attempt ${attempt} failed (${e.message}), retrying in ${wait}ms…`);
          await sleep(wait);
        }
      }
    }
    if (lastError && buffers.length <= i) throw lastError;
  }

  return Buffer.concat(buffers);
}

// ── Progress tracking ─────────────────────────────────────────────────────────

function getProgressPath(outputDir) {
  return path.join(outputDir, 'progress.json');
}

async function loadProgress(outputDir) {
  try {
    return await fs.readJson(getProgressPath(outputDir));
  } catch {
    return { completedChapters: {} };
  }
}

async function saveProgress(outputDir, data) {
  await fs.writeJson(getProgressPath(outputDir), data, { spaces: 2 });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeFilename(str) {
  return str.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase();
}

function padded(n) { return String(n).padStart(4, '0'); }

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function main() {
  const epubPath = path.resolve(argv._[0]);

  if (!(await fs.pathExists(epubPath))) {
    logError(`EPUB file not found: ${epubPath}`);
    process.exit(1);
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey) { logError('ANTHROPIC_API_KEY is not set'); process.exit(1); }
  if (!openaiKey)    { logError('OPENAI_API_KEY is not set');    process.exit(1); }

  const outputDir  = path.resolve(argv['output-dir']);
  const chaptersDir = path.join(outputDir, 'chapters');
  const ssmlDir     = path.join(outputDir, 'ssml');

  await fs.ensureDir(outputDir);
  await fs.ensureDir(chaptersDir);
  await fs.ensureDir(ssmlDir);

  const { voice, format } = argv;
  const ttsModel   = argv['tts-model'];
  const chunkSize  = argv['chunk-size'];
  const noResume   = argv['no-resume'];
  const resumeFrom = argv['resume-from'];

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const openai    = new OpenAI({ apiKey: openaiKey });

  // ── Load progress ──────────────────────────────────────────────────────────

  let progress = noResume
    ? { completedChapters: {} }
    : await loadProgress(outputDir);

  if (resumeFrom !== undefined) {
    log(`Forcing resume from chapter ${resumeFrom} — clearing later state`);
    for (const key of Object.keys(progress.completedChapters)) {
      if (parseInt(key, 10) >= resumeFrom) delete progress.completedChapters[key];
    }
  }

  // ── Extract chapters ───────────────────────────────────────────────────────

  const { chapters, metadata } = await extractChapters(epubPath);

  progress.epubFile   = epubPath;
  progress.bookTitle  = metadata.title;
  progress.bookAuthor = metadata.author;
  progress.total      = chapters.length;
  await saveProgress(outputDir, progress);

  // ── Process each chapter ───────────────────────────────────────────────────

  for (const chapter of chapters) {
    const { index, title, text } = chapter;

    if (progress.completedChapters[index]) {
      log(`Chapter ${index} "${title}" already complete — skipping`);
      continue;
    }

    log(`\n── Chapter ${index}/${chapters.length - 1}: "${title}" (${text.length.toLocaleString()} chars) ──`);

    // Step 1: Claude SSML markup
    log('  [1/3] Adding SSML markup via Claude Haiku…');
    const ssmlText = await addSsmlMarkup(anthropic, text, chunkSize);

    // Save SSML for inspection/debugging
    const ssmlFile = path.join(ssmlDir, `chapter-${padded(index)}.xml`);
    await fs.writeFile(ssmlFile, ssmlText, 'utf8');
    log(`       SSML saved: ${path.relative(process.cwd(), ssmlFile)}`);

    // Step 2: Strip SSML → TTS-ready text
    const ttsText = ssmlToTtsText(ssmlText);
    log(`  [2/3] SSML stripped → ${ttsText.length.toLocaleString()} chars for TTS`);

    // Step 3: OpenAI TTS → audio
    const ttsChunkCount = splitIntoChunks(ttsText, TTS_MAX_CHARS).length;
    log(`  [3/3] Synthesising audio (voice: ${voice}, model: ${ttsModel}, ${ttsChunkCount} TTS chunk(s))…`);
    const audioBuffer = await synthesiseText(openai, ttsText, voice, format, ttsModel);

    const chapterFile = path.join(chaptersDir, `chapter-${padded(index)}.${format}`);
    await fs.writeFile(chapterFile, audioBuffer);
    const kb = (audioBuffer.length / 1024).toFixed(0);
    log(`       Audio saved: ${path.relative(process.cwd(), chapterFile)} (${kb} KB)`);

    // Update progress
    progress.completedChapters[index] = {
      title,
      file: chapterFile,
      chars: text.length,
      audioBytes: audioBuffer.length,
      completedAt: new Date().toISOString(),
    };
    await saveProgress(outputDir, progress);
    log(`  Chapter ${index} done ✓`);
  }

  // ── Assemble final audiobook ───────────────────────────────────────────────

  const completedKeys = Object.keys(progress.completedChapters)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  if (completedKeys.length === 0) {
    logError('No chapters completed — nothing to assemble.');
    process.exit(1);
  }

  const missing = chapters
    .map(c => c.index)
    .filter(i => !progress.completedChapters[i]);

  if (missing.length > 0) {
    log(`\nWarning: ${missing.length} chapter(s) not yet processed: [${missing.join(', ')}]`);
    log('Run again without --no-resume to complete them before final assembly.');
  }

  log('\nAssembling final audiobook…');
  const parts = await Promise.all(
    completedKeys.map(k => fs.readFile(progress.completedChapters[k].file))
  );
  const combined = Buffer.concat(parts);

  const bookSlug = safeFilename(metadata.title || path.basename(epubPath, '.epub'));
  const outputFile = path.join(outputDir, `${bookSlug}.${format}`);
  await fs.writeFile(outputFile, combined);

  const totalMB = (combined.length / 1024 / 1024).toFixed(2);
  log(`\nDone! Audiobook written to: ${outputFile}`);
  log(`Total size: ${totalMB} MB | Chapters: ${completedKeys.length}/${chapters.length}`);

  if (format !== 'mp3') {
    log(`Note: for ${format} format, binary concatenation is used. Run ffmpeg if you need`);
    log(`proper container headers: ffmpeg -i "concat:..." -c copy output.${format}`);
  }
}

main().catch(e => {
  logError(e.stack || e.message || String(e));
  process.exit(1);
});
