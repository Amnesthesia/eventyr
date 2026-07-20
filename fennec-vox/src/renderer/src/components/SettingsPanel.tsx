import React, { useState, useEffect } from 'react';
import type { OAuthProvider } from '@shared/ipc';

interface Props { onClose: () => void }

export default function SettingsPanel({ onClose }: Props) {
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey,    setOpenaiKey]    = useState('');
  const [saving, setSaving]             = useState(false);
  const [saved,  setSaved]              = useState(false);
  const [oauthLoading, setOauthLoading] = useState<OAuthProvider | null>(null);

  // Load saved credentials on mount
  useEffect(() => {
    void window.api.getCredentials().then(creds => {
      setAnthropicKey(creds.anthropicKey);
      setOpenaiKey(creds.openaiKey);
    });

    // Listen for OAuth callback result
    const unsub = window.api.onOAuthComplete(result => {
      setOauthLoading(null);
      if (result.success && result.apiKey) {
        if (result.provider === 'anthropic') setAnthropicKey(result.apiKey);
        if (result.provider === 'openai')    setOpenaiKey(result.apiKey);
      }
    });
    return unsub;
  }, []);

  const handleSave = async () => {
    setSaving(true);
    await window.api.saveCredentials({ anthropicKey, openaiKey });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleOAuth = async (provider: OAuthProvider) => {
    setOauthLoading(provider);
    // startOAuth opens the API key page in browser; result arrives via onOAuthComplete
    await window.api.startOAuth(provider);
    setOauthLoading(null);
  };

  const clearKey = (provider: OAuthProvider) => {
    if (provider === 'anthropic') setAnthropicKey('');
    else setOpenaiKey('');
  };

  const maskKey = (key: string) =>
    key.length > 8 ? `${key.slice(0, 4)}${'•'.repeat(Math.min(16, key.length - 8))}${key.slice(-4)}` : key;

  const activeProvider = anthropicKey ? 'Claude Haiku (ANTHROPIC_API_KEY set)' : openaiKey ? 'GPT-4o mini (fallback)' : 'None — add an OpenAI key to continue';

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="modal-inner">
        <h2>Settings</h2>
        <p className="modal-sub">
          API keys are stored securely in the Mac system keychain.
          Claude Haiku is used when an Anthropic key is present; otherwise GPT-4o mini is the markup provider.
        </p>

        {/* Anthropic */}
        <div className="section-label" style={{ marginBottom: 6 }}>Anthropic (Claude Haiku)</div>
        <div className="key-row">
          <div className="field">
            <input
              type="password"
              value={anthropicKey}
              placeholder="sk-ant-…"
              onChange={e => setAnthropicKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 11, padding: '5px 10px', whiteSpace: 'nowrap' }}
            onClick={() => void handleOAuth('anthropic')}
            disabled={oauthLoading === 'anthropic'}
            type="button"
          >
            {oauthLoading === 'anthropic' ? '…' : '🔑 Get key'}
          </button>
          {anthropicKey && (
            <button className="btn btn-secondary" style={{ fontSize: 11, padding: '5px 8px' }}
              onClick={() => clearKey('anthropic')} type="button" title="Clear key">✕</button>
          )}
        </div>
        {anthropicKey && (
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Stored: {maskKey(anthropicKey)}
          </div>
        )}

        {/* OpenAI */}
        <div className="section-label" style={{ marginBottom: 6, marginTop: 8 }}>OpenAI (TTS + fallback markup)</div>
        <div className="key-row">
          <div className="field">
            <input
              type="password"
              value={openaiKey}
              placeholder="sk-…"
              onChange={e => setOpenaiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 11, padding: '5px 10px', whiteSpace: 'nowrap' }}
            onClick={() => void handleOAuth('openai')}
            disabled={oauthLoading === 'openai'}
            type="button"
          >
            {oauthLoading === 'openai' ? '…' : '🔑 Get key'}
          </button>
          {openaiKey && (
            <button className="btn btn-secondary" style={{ fontSize: 11, padding: '5px 8px' }}
              onClick={() => clearKey('openai')} type="button" title="Clear key">✕</button>
          )}
        </div>
        {openaiKey && (
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Stored: {maskKey(openaiKey)}
          </div>
        )}

        {/* Active provider indicator */}
        <div className="provider-status">
          <div className="dot" style={{ background: openaiKey ? 'var(--success)' : 'var(--warning)' }} />
          <span>Active markup provider: <strong>{activeProvider}</strong></span>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} type="button">Cancel</button>
          <button
            className="btn btn-primary"
            onClick={() => void handleSave()}
            disabled={saving || !openaiKey}
            type="button"
          >
            {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}
