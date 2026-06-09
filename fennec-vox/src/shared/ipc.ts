// Shared IPC channel names and payload types used by main, preload, and renderer.

export const IPC = {
  // renderer → main (invoke)
  SELECT_EPUB:       'select-epub',
  SELECT_OUTPUT_DIR: 'select-output-dir',
  GET_CREDENTIALS:   'get-credentials',
  SAVE_CREDENTIALS:  'save-credentials',
  START_CONVERSION:  'start-conversion',
  STOP_CONVERSION:   'stop-conversion',
  START_OAUTH:       'start-oauth',

  // main → renderer (send)
  CONVERSION_PROGRESS: 'conversion-progress',
  CONVERSION_LOG:      'conversion-log',
  CONVERSION_COMPLETE: 'conversion-complete',
  CONVERSION_ERROR:    'conversion-error',
  OAUTH_COMPLETE:      'oauth-complete',
} as const;

export type TtsVoice  = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
export type TtsFormat = 'mp3' | 'opus' | 'aac' | 'flac';
export type TtsModel  = 'tts-1' | 'tts-1-hd';
export type OAuthProvider = 'anthropic' | 'openai';

export interface ConversionOptions {
  epubPath:    string;
  outputDir:   string;
  voice:       TtsVoice;
  format:      TtsFormat;
  ttsModel:    TtsModel;
  chunkSize:   number;
  concurrency: number;
  resumeFrom?: number;
}

export interface Credentials {
  anthropicKey: string;
  openaiKey:    string;
}

// Mirrors ProgressEvent in convert.ts (re-declared to avoid cross-package import)
export type ProgressEvent =
  | { type: 'start';         provider: string; total: number; concurrency: number }
  | { type: 'chapter_begin'; index: number; title: string; total: number }
  | { type: 'chapter_ssml';  index: number }
  | { type: 'chapter_tts';   index: number; chunks: number }
  | { type: 'chapter_done';  index: number; title: string; file: string; audioBytes: number }
  | { type: 'chapter_skip';  index: number; title: string }
  | { type: 'assembly' }
  | { type: 'complete';      outputFile: string; totalMB: number; chapters: number; total: number }
  | { type: 'error';         message: string };

export interface OAuthResult {
  provider: OAuthProvider;
  apiKey:   string;
  success:  boolean;
  error?:   string;
}

// What the renderer knows about the active conversion state
export interface ConversionState {
  running:         boolean;
  currentChapter:  number;
  totalChapters:   number;
  chapterTitle:    string;
  step:            'idle' | 'ssml' | 'tts' | 'assembly' | 'done' | 'error';
  provider:        string;
  outputFile?:     string;
  errorMessage?:   string;
}
