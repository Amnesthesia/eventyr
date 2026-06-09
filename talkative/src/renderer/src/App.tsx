import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { ConversionOptions, ProgressEvent, TtsVoice, TtsFormat, TtsModel } from '@shared/ipc';
import FilePicker from './components/FilePicker';
import ConversionConfig from './components/ConversionConfig';
import ProgressPanel from './components/ProgressPanel';
import LogViewer from './components/LogViewer';
import SettingsPanel from './components/SettingsPanel';

// ── Conversion state ──────────────────────────────────────────────────────────

export interface ChapterStatus {
  index:  number;
  title:  string;
  status: 'pending' | 'ssml' | 'tts' | 'done' | 'error';
}

export interface AppConversionState {
  running:        boolean;
  provider:       string;
  total:          number;
  chapters:       ChapterStatus[];
  doneCount:      number;
  currentStep:    string;
  outputFile?:    string;
  errorMessage?:  string;
  phase:          'idle' | 'running' | 'done' | 'error';
}

const INITIAL_STATE: AppConversionState = {
  running: false, provider: '', total: 0, chapters: [],
  doneCount: 0, currentStep: '', phase: 'idle',
};

// ── Root component ────────────────────────────────────────────────────────────

export default function App() {
  const [epubPath,    setEpubPath]    = useState('');
  const [outputDir,   setOutputDir]   = useState('');
  const [voice,       setVoice]       = useState<TtsVoice>('alloy');
  const [format,      setFormat]      = useState<TtsFormat>('mp3');
  const [ttsModel,    setTtsModel]    = useState<TtsModel>('tts-1');
  const [chunkSize,   setChunkSize]   = useState(2000);
  const [concurrency, setConcurrency] = useState(1);
  const [showSettings, setShowSettings] = useState(false);

  const [convState, setConvState] = useState<AppConversionState>(INITIAL_STATE);
  const [logs, setLogs] = useState<string[]>([]);
  const logsRef = useRef<string[]>([]);

  const appendLog = useCallback((line: string) => {
    logsRef.current = [...logsRef.current, line];
    setLogs([...logsRef.current]);
  }, []);

  const applyProgress = useCallback((event: ProgressEvent) => {
    setConvState(prev => {
      switch (event.type) {
        case 'start':
          return {
            ...prev, running: true, provider: event.provider, total: event.total,
            phase: 'running', currentStep: 'Starting…',
            chapters: Array.from({ length: event.total }, (_, i) => ({
              index: i, title: `Chapter ${i + 1}`, status: 'pending',
            })),
          };
        case 'chapter_begin': {
          const chapters = prev.chapters.map(c =>
            c.index === event.index ? { ...c, title: event.title, status: 'ssml' as const } : c,
          );
          return { ...prev, chapters, currentStep: `Chapter ${event.index + 1}: SSML markup…` };
        }
        case 'chapter_ssml': {
          const chapters = prev.chapters.map(c =>
            c.index === event.index ? { ...c, status: 'ssml' as const } : c,
          );
          return { ...prev, chapters };
        }
        case 'chapter_tts': {
          const chapters = prev.chapters.map(c =>
            c.index === event.index ? { ...c, status: 'tts' as const } : c,
          );
          return { ...prev, chapters, currentStep: `Chapter ${event.index + 1}: TTS synthesis (${event.chunks} chunk(s))…` };
        }
        case 'chapter_done': {
          const chapters = prev.chapters.map(c =>
            c.index === event.index ? { ...c, status: 'done' as const } : c,
          );
          const doneCount = chapters.filter(c => c.status === 'done').length;
          return { ...prev, chapters, doneCount };
        }
        case 'assembly':
          return { ...prev, currentStep: 'Assembling final audiobook…' };
        case 'complete':
          return {
            ...prev, running: false, phase: 'done',
            doneCount: event.chapters, outputFile: event.outputFile,
            currentStep: `Done — ${event.totalMB.toFixed(1)} MB`,
          };
        case 'error':
          return { ...prev, running: false, phase: 'error', errorMessage: event.message };
        default:
          return prev;
      }
    });
  }, []);

  // Subscribe to IPC events
  useEffect(() => {
    const unsubs = [
      window.api.onProgress(applyProgress),
      window.api.onLog(appendLog),
      window.api.onError(msg => {
        appendLog(`[ERROR] ${msg}`);
        setConvState(prev => ({ ...prev, running: false, phase: 'error', errorMessage: msg }));
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, [applyProgress, appendLog]);

  const handleStart = async () => {
    if (!epubPath) return;
    logsRef.current = [];
    setLogs([]);
    setConvState(INITIAL_STATE);

    const opts: ConversionOptions = {
      epubPath, outputDir: outputDir || './audiobook-output',
      voice, format, ttsModel, chunkSize, concurrency,
    };
    const result = await window.api.startConversion(opts);
    if (result.error) {
      appendLog(`[ERROR] ${result.error}`);
      setConvState(prev => ({ ...prev, phase: 'error', errorMessage: result.error }));
    }
  };

  const handleStop = async () => {
    await window.api.stopConversion();
    setConvState(prev => ({ ...prev, running: false, phase: 'idle' }));
  };

  const canStart = !!epubPath && !convState.running;

  return (
    <div className="app">
      <div className="titlebar">
        <h1>Talkative</h1>
        <div className="titlebar-actions">
          <button className="btn-icon" onClick={() => setShowSettings(true)} title="Settings">
            ⚙
          </button>
        </div>
      </div>

      <div className="body">
        {/* ── Sidebar ── */}
        <aside className="sidebar">
          <div className="section">
            <div className="section-label">EPUB File</div>
            <FilePicker
              value={epubPath}
              onChange={setEpubPath}
              onPickDir={async () => {
                const dir = await window.api.selectOutputDir();
                if (dir) setOutputDir(dir);
              }}
            />
          </div>

          <ConversionConfig
            voice={voice}           onVoiceChange={setVoice}
            format={format}         onFormatChange={setFormat}
            ttsModel={ttsModel}     onTtsModelChange={setTtsModel}
            chunkSize={chunkSize}   onChunkSizeChange={setChunkSize}
            concurrency={concurrency} onConcurrencyChange={setConcurrency}
            outputDir={outputDir}   onOutputDirChange={setOutputDir}
          />

          <div className="section" style={{ marginTop: 'auto', paddingTop: 12 }}>
            {convState.running ? (
              <button className="btn btn-danger btn-full" onClick={handleStop}>
                ⏹ Stop Conversion
              </button>
            ) : (
              <button className="btn btn-primary btn-full" onClick={handleStart} disabled={!canStart}>
                ▶ Convert to Audiobook
              </button>
            )}
          </div>
        </aside>

        {/* ── Main area ── */}
        <main className="main">
          <ProgressPanel state={convState} />
          <LogViewer lines={logs} />
        </main>
      </div>

      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
