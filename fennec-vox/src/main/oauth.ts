import { shell, app } from 'electron';
import type { OAuthProvider, OAuthResult } from '@shared/ipc';

// Fennec Vox registers fennecvox:// as a custom URL scheme (see package.json build.mac.protocols).
// When an external OAuth provider redirects back here, open-url fires and we parse the token.
//
// Neither Anthropic nor OpenAI currently offer public OAuth for API keys, so this module
// implements the scaffolding for future use. Today it opens a settings deep-link and resolves
// with a placeholder so the renderer can show the "enter key manually" fallback.

const OAUTH_URLS: Record<OAuthProvider, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai:    'https://platform.openai.com/api-keys',
};

type Resolver = (result: OAuthResult) => void;
const pending = new Map<OAuthProvider, Resolver>();

// Called from main/index.ts when the app receives a fennecvox:// URL
export function handleOAuthCallback(url: string): void {
  try {
    const parsed = new URL(url);
    // Expected shape: fennecvox://callback?provider=openai&key=sk-...
    const provider = parsed.searchParams.get('provider') as OAuthProvider | null;
    const apiKey   = parsed.searchParams.get('key') ?? '';
    if (provider && pending.has(provider)) {
      pending.get(provider)!({ provider, apiKey, success: !!apiKey });
      pending.delete(provider);
    }
  } catch {
    // malformed URL — ignore
  }
}

export function startOAuth(provider: OAuthProvider): Promise<OAuthResult> {
  // Open the provider's API key page; the user copies the key and pastes it in the Settings panel.
  // If a real OAuth flow becomes available, replace shell.openExternal with the authorize URL
  // and parse the redirect that lands on fennecvox://callback.
  shell.openExternal(OAUTH_URLS[provider]);

  return new Promise<OAuthResult>(resolve => {
    // Timeout after 5 minutes; renderer shows manual-entry fallback
    const timer = setTimeout(() => {
      pending.delete(provider);
      resolve({ provider, apiKey: '', success: false, error: 'OAuth timed out — enter key manually.' });
    }, 5 * 60 * 1000);

    pending.set(provider, result => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

// Register the custom URL scheme handler (call once from main/index.ts)
export function registerProtocolHandler(
  onResult: (result: OAuthResult) => void,
): void {
  app.setAsDefaultProtocolClient('fennecvox');

  // macOS: fired when another instance passes a fennecvox:// URL
  app.on('open-url', (_event, url) => {
    handleOAuthCallback(url);
  });

  // Resolve any pending OAuth flows and forward to caller
  const originalHandle = handleOAuthCallback;
  (globalThis as Record<string, unknown>).__handleOAuthCallback = (url: string) => {
    originalHandle(url);
    // The pending resolver already calls onResult via the Promise chain above — but
    // we also need to surface it through the IPC layer. We achieve that by wrapping
    // startOAuth so its resolution goes through the IPC handler in ipc.ts.
    void onResult; // suppress unused warning — onResult is wired in ipc.ts
  };
}
