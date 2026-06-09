import React from 'react';
import type { AppConversionState } from '../App';

interface Props { state: AppConversionState }

export default function ProgressPanel({ state }: Props) {
  const { phase, running, total, doneCount, chapters, currentStep, provider, outputFile, errorMessage } = state;

  if (phase === 'idle') {
    return (
      <div className="progress-panel">
        <div className="idle-state">
          <div className="idle-icon">🎙</div>
          <p>Select an EPUB and press <strong>Convert</strong> to begin</p>
        </div>
      </div>
    );
  }

  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const fillClass = phase === 'done' ? 'complete' : phase === 'error' ? 'error' : '';

  const providerLabel = provider === 'claude-haiku' ? 'Claude Haiku' : provider === 'gpt-4o-mini' ? 'GPT-4o mini' : provider;
  const badgeClass    = provider === 'claude-haiku' ? 'badge-blue' : 'badge-orange';

  return (
    <div className="progress-panel">
      <div className="progress-header">
        <span className="progress-title">
          {phase === 'done'  ? '✅ Conversion complete' :
           phase === 'error' ? '❌ Conversion failed'   :
           running           ? '⏳ Converting…'          :
                               'Conversion'}
        </span>
        {provider && (
          <span className={`badge ${badgeClass}`}>{providerLabel}</span>
        )}
        <span className="progress-subtitle" style={{ marginLeft: 'auto' }}>
          {doneCount}/{total} chapters
        </span>
      </div>

      <div className="progress-bar-track">
        <div
          className={`progress-bar-fill ${fillClass}`}
          style={{ width: `${phase === 'done' ? 100 : pct}%` }}
        />
      </div>

      <div className="progress-meta">
        <span>{currentStep || (phase === 'done' && outputFile ? `📁 ${outputFile}` : '')}</span>
        <span>{phase === 'done' ? '100%' : `${pct}%`}</span>
      </div>

      {phase === 'error' && errorMessage && (
        <div style={{ marginTop: 10, padding: '8px 10px', background: '#fff0ef', borderRadius: 6, fontSize: 11, color: 'var(--danger)' }}>
          {errorMessage}
        </div>
      )}

      {/* Per-chapter status list */}
      {chapters.length > 0 && (
        <div className="chapter-list">
          {chapters.map(ch => (
            <div key={ch.index} className={`chapter-row ${ch.status === 'done' ? 'done' : ch.status === 'ssml' || ch.status === 'tts' ? 'active' : ''}`}>
              <div className="dot" />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ch.title}
              </span>
              <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
                {ch.status === 'done'    ? '✓'         :
                 ch.status === 'ssml'   ? 'markup…'   :
                 ch.status === 'tts'    ? 'audio…'    :
                 ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
