#!/usr/bin/env node
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import EPub from 'epub';
import fs from 'fs-extra';
import path from 'path';
import { load as cheerioLoad } from 'cheerio';
import readline from 'readline';

// ── Types ─────────────────────────────────────────────────────────────────────

export type MarkupProvider = 'claude-haiku' | 'gpt-4o-mini';
export type TtsVoice  = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
export type TtsFormat = 'mp3'   | 'opus' | 'aac'   | 'flac';
export type TtsModel  = 'tts-1' | 'tts-1-hd';

export interface Chapter {
  index:      number;
  spineIndex: number;
  id:         string;
  title:      string;
  text:       string;
}

export interface BookMetadata {
  title:  string;
  author: string;
}

export interface ChapterRecord {
  title:      string;
  file:       string;
  chars:      number;
  audioBytes: number;
  completedAt: string;
}

export interface Progress {
  completedChapters: Record<number, ChapterRecord>;
  epubFile?:         string;
  bookTitle?:        string;
  bookAuthor?:       string;
  total?:            number;
}

export interface CostEstimate {
  pendingChapters:  number;
  skippedChapters:  number;
  totalInputChars:  number;
  inputTokens:      number;
  outputTokens:     number;
  totalTtsChars:    number;
  claudeCost:       number;
  ttsCost:          number;
  totalCost:        number;
  provider:         MarkupProvider;
}

// Structured progress events emitted on stdout so Electron can parse them
export type ProgressEvent =
  | { type: 'start';         provider: MarkupProvider; total: number; concurrency: number }
  | { type: 'chapter_begin'; index: number; title: string; total: number }
  | { type: 'chapter_ssml';  index: number }
  | { type: 'chapter_tts';   index: number; chunks: number }
  | { type: 'chapter_done';  index: number; title: string; file: string; audioBytes: number }
  | { type: 'chapter_skip';  index: number; title: string }
  | { type: 'assembly' }
  | { type: 'complete';      outputFile: string; totalMB: number; chapters: number; total: number }
  | { type: 'error';         message: string };

// ── CLI ───────────────────────────────────────────────────────────────────────

const argv = yargs(hideBin(process.argv))
  .scriptName('epub-to-audiobook')
  .usage('Usage: $0 <epub-file> [options]')
  .example('$0 book.epub --voice nova --output-dir ./my-audiobook', '')
  .example('$0 book.epub --concurrency 4 --yes', 'parallel, no prompt')
  .example('$0 book.epub --resume-from 5', 'restart from chapter 5')
  .option('voice', {
    alias: 'v', type: 'string' as const,
    default: (process.env['TTS_VOICE'] ?? 'alloy') as TtsVoice,
    choices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const,
    description: 'OpenAI TTS voice',
  })
  .option('format', {
    alias: 'f', type: 'string' as const,
    default: (process.env['TTS_FORMAT'] ?? 'mp3') as TtsFormat,
    choices: ['mp3', 'opus', 'aac', 'flac'] as const,
    description: 'Output audio format',
  })
  .option('tts-model', {
    type: 'string' as const,
    default: (process.env['TTS_MODEL'] ?? 'tts-1') as TtsModel,
    choices: ['tts-1', 'tts-1-hd'] as const,
    description: 'OpenAI TTS model',
  })
  .option('chunk-size', {
    alias: 'c', type: 'number' as const,
    default: parseInt(process.env['CHUNK_SIZE'] ?? '2000', 10),
    description: 'Max characters per chunk sent to markup model',
  })
  .option('concurrency', {
    alias: 'p', type: 'number' as const,
    default: parseInt(process.env['CONCURRENCY'] ?? '1', 10),
    description: 'Chapters to process in parallel',
  })
  .option('output-dir', {
    alias: 'o', type: 'string' as const,
    default: process.env['OUTPUT_DIR'] ?? './audiobook-output',
    description: 'Directory for output files and progress state',
  })
  .option('resume-from', {
    alias: 'r', type: 'number' as const,
    description: 'Force-resume from this chapter index (0-based)',
  })
  .option('no-resume', {
    type: 'boolean' as const, default: false,
    description: 'Ignore saved progress and start fresh',
  })
  .option('yes', {
    alias: 'y', type: 'boolean' as const, default: false,
    description: 'Skip cost-estimate confirmation prompt',
  })
  .demandCommand(1, 'Please supply an EPUB file path as the first argument.')
  .help()
  .parseSync();

// ── Logging & progress ────────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(...args: unknown[]): void {
  console.log(`[${timestamp()}]`, ...args);
}
function logError(...args: unknown[]): void {
  console.error(`[${timestamp()}] ERROR:`, ...args);
}
export function emitProgress(event: ProgressEvent): void {
  console.log(`[PROGRESS] ${JSON.stringify(event)}`);
}

// ── Provider detection ────────────────────────────────────────────────────────

export function detectMarkupProvider(
  anthropicKey: string | undefined,
  openaiKey: string | undefined,
): MarkupProvider {
  if (!openaiKey) {
    throw new Error(
      'OPENAI_API_KEY is required (used for TTS and as fallback markup model). ' +
      'Set it and optionally set ANTHROPIC_API_KEY to use Claude Haiku for markup.',
    );
  }
  return anthropicKey ? 'claude-haiku' : 'gpt-4o-mini';
}

// ── Text utilities ────────────────────────────────────────────────────────────

export function htmlToPlainText(html: string): string {
  const $ = cheerioLoad(html);
  $('script, style, head').remove();
  $('p, br, h1, h2, h3, h4, h5, h6, li').after('\n\n');
  return $.root()
    .text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitIntoChunks(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxSize) {
      if (current.trim()) { chunks.push(current.trim()); current = ''; }
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

export function ssmlToTtsText(ssml: string): string {
  let text = ssml.replace(/<break([^/]*)\/?>/gi, (_: string, attrs: string): string => {
    const m = attrs.match(/time=["']?(\d+(?:\.\d+)?)(ms|s)/i);
    if (m) {
      const ms = m[2]!.toLowerCase() === 's'
        ? parseFloat(m[1]!) * 1000
        : parseFloat(m[1]!);
      if (ms >= 800) return '... ';
      if (ms >= 400) return '.. ';
      return '. ';
    }
    return '... ';
  });
  text = text.replace(/<[^>]+>/g, '');
  return text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
}

// ── EPUB parsing ──────────────────────────────────────────────────────────────

function openEpub(epubPath: string): Promise<EPub> {
  return new Promise((resolve, reject) => {
    const book = new EPub(epubPath);
    book.on('end', () => resolve(book));
    book.on('error', reject);
    book.parse();
  });
}

function getChapterHtml(book: EPub, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    book.getChapter(id, (error, text) => {
      if (error) reject(new Error(`Failed to read chapter "${id}": ${String(error)}`));
      else resolve(text ?? '');
    });
  });
}

export async function extractChapters(
  epubPath: string,
): Promise<{ chapters: Chapter[]; metadata: BookMetadata }> {
  log(`Opening EPUB: ${epubPath}`);
  const book = await openEpub(epubPath);
  const title  = book.metadata.title   ?? 'Unknown Title';
  const author = book.metadata.creator ?? 'Unknown Author';
  log(`Book: "${title}" by ${author}`);
  log(`Spine items: ${book.flow.length}`);
  const chapters: Chapter[] = [];
  for (let spineIdx = 0; spineIdx < book.flow.length; spineIdx++) {
    const item = book.flow[spineIdx]!;
    let html: string;
    try {
      html = await getChapterHtml(book, item.id);
    } catch (e) {
      log(`  Warning: skipping spine[${spineIdx}] (${item.id}): ${(e as Error).message}`);
      continue;
    }
    const text = htmlToPlainText(html);
    if (text.length < 100) continue;
    const chapterTitle = item.title ?? `Chapter ${chapters.length + 1}`;
    chapters.push({ index: chapters.length, spineIndex: spineIdx, id: item.id, title: chapterTitle, text });
    log(`  [${String(chapters.length - 1).padStart(3)}] "${chapterTitle}" — ${text.length.toLocaleString()} chars`);
  }
  log(`Chapters with content: ${chapters.length}`);
  return { chapters, metadata: { title, author } };
}

// ── Markup: SSML prompt (shared between providers) ────────────────────────────

const SSML_SYSTEM = `You are a professional audiobook narrator assistant. Add SSML markup to text for natural spoken narration.

Guidelines:
- <break time="600ms"/> between paragraphs
- <break time="250ms"/> at commas and list items
- <break time="900ms"/> before/after dialogue attribution
- <emphasis level="moderate"> for important words or phrases
- <emphasis level="strong"> for exclamations or critical moments
- Do NOT change, paraphrase, or omit any words — only insert SSML tags
- Return ONLY the marked-up text with no preamble, explanation, or code fences`;

// ── Markup: Claude Haiku path ─────────────────────────────────────────────────

async function addSsmlMarkupClaude(
  anthropic: Anthropic,
  text: string,
  chunkSize: number,
): Promise<string> {
  const rawChunks = splitIntoChunks(text, chunkSize);
  const marked: string[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const chunk = rawChunks[i]!;
    const maxTokens = Math.min(4096, Math.ceil(chunk.length * 1.8) + 256);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: maxTokens,
          system: SSML_SYSTEM,
          messages: [{ role: 'user', content: chunk }],
        });
        const block = response.content[0];
        if (!block || block.type !== 'text') throw new Error('Unexpected response type from Claude');
        marked.push(block.text);
        break;
      } catch (e) {
        lastError = e;
        if (attempt < 3) { await sleep(1000 * attempt); }
      }
    }
    if (lastError !== undefined && marked.length <= i) throw lastError;
  }
  return marked.join('\n\n');
}

// ── Markup: GPT-4o mini path ──────────────────────────────────────────────────

async function addSsmlMarkupGpt(
  openai: OpenAI,
  text: string,
  chunkSize: number,
): Promise<string> {
  const rawChunks = splitIntoChunks(text, chunkSize);
  const marked: string[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const chunk = rawChunks[i]!;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: SSML_SYSTEM },
            { role: 'user',   content: chunk },
          ],
        });
        const content = response.choices[0]?.message?.content;
        if (!content) throw new Error('Empty response from GPT-4o mini');
        marked.push(content);
        break;
      } catch (e) {
        lastError = e;
        if (attempt < 3) { await sleep(1000 * attempt); }
      }
    }
    if (lastError !== undefined && marked.length <= i) throw lastError;
  }
  return marked.join('\n\n');
}

// ── Markup dispatcher ─────────────────────────────────────────────────────────

export async function addMarkup(
  provider: MarkupProvider,
  anthropic: Anthropic | null,
  openai: OpenAI,
  text: string,
  chunkSize: number,
): Promise<string> {
  if (provider === 'claude-haiku') {
    if (!anthropic) throw new Error('Anthropic client required for claude-haiku provider');
    return addSsmlMarkupClaude(anthropic, text, chunkSize);
  }
  return addSsmlMarkupGpt(openai, text, chunkSize);
}

// ── OpenAI TTS ────────────────────────────────────────────────────────────────

const TTS_MAX_CHARS = 4000;

export async function synthesiseText(
  openai: OpenAI,
  text: string,
  voice: TtsVoice,
  format: TtsFormat,
  ttsModel: TtsModel,
): Promise<Buffer> {
  const chunks = splitIntoChunks(text, TTS_MAX_CHARS);
  const buffers: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await openai.audio.speech.create({
          model: ttsModel,
          voice,
          input: chunks[i]!,
          response_format: format,
        });
        buffers.push(Buffer.from(await response.arrayBuffer()));
        break;
      } catch (e) {
        lastError = e;
        if (attempt < 3) { await sleep(2000 * attempt); }
      }
    }
    if (lastError !== undefined && buffers.length <= i) throw lastError;
  }
  return Buffer.concat(buffers);
}

// ── Progress tracking ─────────────────────────────────────────────────────────

function getProgressPath(outputDir: string): string {
  return path.join(outputDir, 'progress.json');
}

export async function loadProgress(outputDir: string): Promise<Progress> {
  try {
    return await fs.readJson(getProgressPath(outputDir)) as Progress;
  } catch {
    return { completedChapters: {} };
  }
}

export async function saveProgress(outputDir: string, data: Progress): Promise<void> {
  await fs.writeJson(getProgressPath(outputDir), data, { spaces: 2 });
}

// ── Concurrency ───────────────────────────────────────────────────────────────

export async function pLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;
  let activeCount = 0;
  let rejected = false;
  return new Promise((resolve, reject) => {
    function tryDispatch(): void {
      while (activeCount < limit && nextIdx < tasks.length && !rejected) {
        const idx = nextIdx++;
        activeCount++;
        tasks[idx]!()
          .then(result => {
            results[idx] = result;
            activeCount--;
            if (nextIdx >= tasks.length && activeCount === 0) resolve(results);
            else tryDispatch();
          })
          .catch(err => { if (!rejected) { rejected = true; reject(err as Error); } });
      }
    }
    tryDispatch();
    if (tasks.length === 0) resolve(results);
  });
}

// ── Cost estimation ───────────────────────────────────────────────────────────

// Verify rates at: anthropic.com/pricing  openai.com/pricing
const PRICING = {
  claudeHaikuInputPerMTok:  0.80,
  claudeHaikuOutputPerMTok: 4.00,
  gpt4oMiniInputPerMTok:    0.15,
  gpt4oMiniOutputPerMTok:   0.60,
  tts1PerMChars:            15.00,
  tts1HdPerMChars:          30.00,
} as const;

const CHARS_PER_TOKEN    = 4;
const SSML_OUTPUT_RATIO  = 1.35;
const SSML_SYSTEM_TOKENS = 120;

export function estimateCosts(
  chapters: Chapter[],
  completedChapters: Record<number, ChapterRecord>,
  chunkSize: number,
  ttsModel: TtsModel,
  provider: MarkupProvider,
): CostEstimate {
  let pendingChapters = 0, totalInputChars = 0, totalOutputChars = 0, totalTtsChars = 0;
  for (const ch of chapters) {
    if (completedChapters[ch.index]) continue;
    pendingChapters++;
    totalInputChars  += ch.text.length;
    totalOutputChars += Math.ceil(ch.text.length * SSML_OUTPUT_RATIO);
    totalTtsChars    += Math.ceil(ch.text.length * 0.90);
  }
  const numChunks    = Math.ceil(totalInputChars / chunkSize);
  const inputTokens  = Math.ceil(totalInputChars  / CHARS_PER_TOKEN) + numChunks * SSML_SYSTEM_TOKENS;
  const outputTokens = Math.ceil(totalOutputChars / CHARS_PER_TOKEN);
  const markupInputRate  = provider === 'claude-haiku' ? PRICING.claudeHaikuInputPerMTok  : PRICING.gpt4oMiniInputPerMTok;
  const markupOutputRate = provider === 'claude-haiku' ? PRICING.claudeHaikuOutputPerMTok : PRICING.gpt4oMiniOutputPerMTok;
  const claudeCost = (inputTokens / 1_000_000) * markupInputRate + (outputTokens / 1_000_000) * markupOutputRate;
  const ttsRate    = ttsModel === 'tts-1-hd' ? PRICING.tts1HdPerMChars : PRICING.tts1PerMChars;
  const ttsCost    = (totalTtsChars / 1_000_000) * ttsRate;
  return {
    pendingChapters, skippedChapters: chapters.length - pendingChapters,
    totalInputChars, inputTokens, outputTokens, totalTtsChars,
    claudeCost, ttsCost, totalCost: claudeCost + ttsCost, provider,
  };
}

function displayCostEstimate(est: CostEstimate, ttsModel: TtsModel, concurrency: number): void {
  const n   = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
  const W = 56, rule = '─'.repeat(W);
  const row = (label: string, value: string) => {
    const padding = W - 2 - label.length - value.length;
    return `│  ${label}${' '.repeat(Math.max(0, padding))}${value}  │`;
  };
  const providerLabel = est.provider === 'claude-haiku' ? 'Claude Haiku' : 'GPT-4o mini';
  console.log(`\n┌${rule}┐`);
  console.log(`│  Cost Estimate${' '.repeat(W - 15)}│`);
  console.log(`├${rule}┤`);
  console.log(row('Markup provider     :', providerLabel));
  console.log(row('Chapters to process :', `${n(est.pendingChapters)}  (${n(est.skippedChapters)} already done)`));
  console.log(row('Total input chars   :', n(est.totalInputChars)));
  console.log(row('Concurrency         :', `${concurrency} chapter(s) in parallel`));
  console.log(`├${rule}┤`);
  console.log(`│  ${providerLabel} (SSML markup)${' '.repeat(W - 20 - providerLabel.length)}│`);
  console.log(row('  Input tokens      :', `~${n(est.inputTokens)}`));
  console.log(row('  Output tokens     :', `~${n(est.outputTokens)}`));
  console.log(row('  Estimated cost    :', `~${usd(est.claudeCost)}`));
  console.log(`├${rule}┤`);
  console.log(`│  OpenAI TTS (${ttsModel})${' '.repeat(W - 16 - ttsModel.length)}│`);
  console.log(row('  Characters        :', `~${n(est.totalTtsChars)}`));
  console.log(row('  Estimated cost    :', `~${usd(est.ttsCost)}`));
  console.log(`├${rule}┤`);
  console.log(row('TOTAL               :', `~${usd(est.totalCost)}`));
  console.log(`└${rule}┘`);
  console.log('  Estimates use ~4 chars/token and current list pricing.');
  console.log('  Verify rates: anthropic.com/pricing  openai.com/pricing\n');
}

function askConfirmation(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
export function safeFilename(str: string): string {
  return str.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase();
}
export function padded(n: number): string { return String(n).padStart(4, '0'); }

// ── Chapter processor ─────────────────────────────────────────────────────────

interface ProcessorOpts {
  provider:    MarkupProvider;
  anthropic:   Anthropic | null;
  openai:      OpenAI;
  voice:       TtsVoice;
  format:      TtsFormat;
  ttsModel:    TtsModel;
  chunkSize:   number;
  chaptersDir: string;
  ssmlDir:     string;
  total:       number;
}

export async function processChapter(
  chapter: Chapter,
  opts: ProcessorOpts,
): Promise<{ file: string; audioBytes: number }> {
  const { index, title, text } = chapter;
  const { provider, anthropic, openai, voice, format, ttsModel, chunkSize, chaptersDir, ssmlDir, total } = opts;

  emitProgress({ type: 'chapter_begin', index, title, total });
  log(`\n── Chapter ${index}/${total - 1}: "${title}" (${text.length.toLocaleString()} chars) ──`);

  log(`  [${index}][1/3] Adding SSML markup via ${provider}…`);
  emitProgress({ type: 'chapter_ssml', index });
  const ssmlText = await addMarkup(provider, anthropic, openai, text, chunkSize);

  const ssmlFile = path.join(ssmlDir, `chapter-${padded(index)}.xml`);
  await fs.writeFile(ssmlFile, ssmlText, 'utf8');

  const ttsText = ssmlToTtsText(ssmlText);
  log(`  [${index}][2/3] SSML stripped → ${ttsText.length.toLocaleString()} chars`);

  const ttsChunks = splitIntoChunks(ttsText, TTS_MAX_CHARS).length;
  emitProgress({ type: 'chapter_tts', index, chunks: ttsChunks });
  log(`  [${index}][3/3] Synthesising audio (${ttsChunks} TTS chunk(s))…`);
  const audioBuffer = await synthesiseText(openai, ttsText, voice, format, ttsModel);

  const chapterFile = path.join(chaptersDir, `chapter-${padded(index)}.${format}`);
  await fs.writeFile(chapterFile, audioBuffer);
  const kb = (audioBuffer.length / 1024).toFixed(0);
  log(`  [${index}]       Saved: ${path.relative(process.cwd(), chapterFile)} (${kb} KB)`);
  log(`  [${index}] Chapter ${index} done ✓`);
  emitProgress({ type: 'chapter_done', index, title, file: chapterFile, audioBytes: audioBuffer.length });

  return { file: chapterFile, audioBytes: audioBuffer.length };
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const epubPath = path.resolve(String(argv._[0]));

  if (!(await fs.pathExists(epubPath))) {
    logError(`EPUB file not found: ${epubPath}`);
    process.exit(1);
  }

  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const openaiKey    = process.env['OPENAI_API_KEY'];

  let provider: MarkupProvider;
  try {
    provider = detectMarkupProvider(anthropicKey, openaiKey);
  } catch (e) {
    logError((e as Error).message);
    process.exit(1);
  }

  log(`Markup provider: ${provider}`);

  const outputDir   = path.resolve(argv['output-dir']);
  const chaptersDir = path.join(outputDir, 'chapters');
  const ssmlDir     = path.join(outputDir, 'ssml');

  await fs.ensureDir(outputDir);
  await fs.ensureDir(chaptersDir);
  await fs.ensureDir(ssmlDir);

  const voice       = argv.voice           as TtsVoice;
  const format      = argv.format          as TtsFormat;
  const ttsModel    = argv['tts-model']    as TtsModel;
  const chunkSize   = argv['chunk-size'];
  const concurrency = Math.max(1, argv.concurrency);
  const noResume    = argv['no-resume'];
  const resumeFrom  = argv['resume-from']  as number | undefined;

  const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
  const openai    = new OpenAI({ apiKey: openaiKey! });

  let progress: Progress = noResume ? { completedChapters: {} } : await loadProgress(outputDir);

  if (resumeFrom !== undefined) {
    log(`Forcing resume from chapter ${resumeFrom} — clearing later state`);
    for (const key of Object.keys(progress.completedChapters)) {
      if (parseInt(key, 10) >= resumeFrom) delete progress.completedChapters[Number(key)];
    }
  }

  const { chapters, metadata } = await extractChapters(epubPath);
  progress.epubFile = epubPath;
  progress.bookTitle = metadata.title;
  progress.bookAuthor = metadata.author;
  progress.total = chapters.length;
  await saveProgress(outputDir, progress);

  const estimate = estimateCosts(chapters, progress.completedChapters, chunkSize, ttsModel, provider);
  displayCostEstimate(estimate, ttsModel, concurrency);
  emitProgress({ type: 'start', provider, total: chapters.length, concurrency });

  if (estimate.pendingChapters === 0) {
    log('All chapters already processed — skipping to assembly.');
  } else if (!argv.yes) {
    const answer = await askConfirmation('Proceed with these API calls? [y/N] ');
    if (answer !== 'y' && answer !== 'yes') {
      log('Aborted. Re-run with --yes to skip this prompt.');
      process.exit(0);
    }
  } else {
    log('--yes flag set, proceeding automatically.');
  }

  const pending = chapters.filter(ch => !progress.completedChapters[ch.index]);
  if (concurrency > 1) log(`\nProcessing ${pending.length} chapters with concurrency=${concurrency}…`);

  const processorOpts: ProcessorOpts = {
    provider, anthropic, openai, voice, format, ttsModel, chunkSize, chaptersDir, ssmlDir,
    total: chapters.length,
  };

  const tasks = pending.map(chapter => async () => {
    const { file, audioBytes } = await processChapter(chapter, processorOpts);
    progress.completedChapters[chapter.index] = {
      title: chapter.title, file, chars: chapter.text.length,
      audioBytes, completedAt: new Date().toISOString(),
    };
    await saveProgress(outputDir, progress);
  });

  await pLimit(tasks, concurrency);

  const completedKeys = Object.keys(progress.completedChapters)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  if (completedKeys.length === 0) { logError('No chapters completed.'); process.exit(1); }

  const missing = chapters.map(c => c.index).filter(i => !progress.completedChapters[i]);
  if (missing.length > 0) log(`Warning: ${missing.length} chapter(s) skipped: [${missing.join(', ')}]`);

  emitProgress({ type: 'assembly' });
  log('\nAssembling final audiobook…');
  const parts   = await Promise.all(completedKeys.map(k => fs.readFile(progress.completedChapters[Number(k)]!.file)));
  const combined = Buffer.concat(parts);

  const bookSlug   = safeFilename(metadata.title || path.basename(epubPath, '.epub'));
  const outputFile = path.join(outputDir, `${bookSlug}.${format}`);
  await fs.writeFile(outputFile, combined);

  const totalMB = combined.length / 1024 / 1024;
  log(`\nDone! Audiobook written to: ${outputFile}`);
  log(`Total size: ${totalMB.toFixed(2)} MB | Chapters: ${completedKeys.length}/${chapters.length}`);
  emitProgress({ type: 'complete', outputFile, totalMB, chapters: completedKeys.length, total: chapters.length });

  if (format !== 'mp3') {
    log(`Note: for ${format} format, binary concatenation is used.`);
  }
}

if (require.main === module) {
  main().catch(e => {
    logError((e as Error).stack ?? String(e));
    emitProgress({ type: 'error', message: (e as Error).message });
    process.exit(1);
  });
}
