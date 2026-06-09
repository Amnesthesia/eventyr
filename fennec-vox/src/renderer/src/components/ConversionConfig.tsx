import React from 'react';
import type { TtsVoice, TtsFormat, TtsModel } from '@shared/ipc';

interface Props {
  voice:       TtsVoice;    onVoiceChange:       (v: TtsVoice)  => void;
  format:      TtsFormat;   onFormatChange:      (v: TtsFormat) => void;
  ttsModel:    TtsModel;    onTtsModelChange:    (v: TtsModel)  => void;
  chunkSize:   number;      onChunkSizeChange:   (v: number)    => void;
  concurrency: number;      onConcurrencyChange: (v: number)    => void;
  outputDir:   string;      onOutputDirChange:   (v: string)    => void;
}

export default function ConversionConfig({
  voice, onVoiceChange,
  format, onFormatChange,
  ttsModel, onTtsModelChange,
  chunkSize, onChunkSizeChange,
  concurrency, onConcurrencyChange,
  outputDir, onOutputDirChange,
}: Props) {
  return (
    <>
      <div className="section">
        <div className="section-label">Voice &amp; Audio</div>
        <div className="field">
          <label>Voice</label>
          <select value={voice} onChange={e => onVoiceChange(e.target.value as TtsVoice)}>
            {(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as TtsVoice[]).map(v => (
              <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Format</label>
          <select value={format} onChange={e => onFormatChange(e.target.value as TtsFormat)}>
            {(['mp3', 'opus', 'aac', 'flac'] as TtsFormat[]).map(f => (
              <option key={f} value={f}>{f.toUpperCase()}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>TTS Model</label>
          <select value={ttsModel} onChange={e => onTtsModelChange(e.target.value as TtsModel)}>
            <option value="tts-1">Standard (tts-1)</option>
            <option value="tts-1-hd">High Quality (tts-1-hd)</option>
          </select>
        </div>
      </div>

      <div className="section">
        <div className="section-label">Processing</div>
        <div className="field">
          <label>Chunk size (chars)</label>
          <input
            type="number"
            value={chunkSize}
            min={500}
            max={8000}
            step={500}
            onChange={e => onChunkSizeChange(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label>Parallel chapters</label>
          <input
            type="number"
            value={concurrency}
            min={1}
            max={8}
            step={1}
            onChange={e => onConcurrencyChange(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="section">
        <div className="section-label">Output</div>
        <div className="field">
          <label>Output directory</label>
          <input
            type="text"
            value={outputDir}
            placeholder="./audiobook-output"
            onChange={e => onOutputDirChange(e.target.value)}
          />
        </div>
      </div>
    </>
  );
}
