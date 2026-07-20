import type { Credentials } from '@shared/ipc';

const SERVICE = 'Fennec Vox';
const ACCOUNTS = { anthropic: 'anthropic-api-key', openai: 'openai-api-key' } as const;

// Lazy-load keytar so the app doesn't crash if native bindings are missing in dev
function getKeytar() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('keytar') as typeof import('keytar');
  } catch {
    return null;
  }
}

export async function getCredentials(): Promise<Credentials> {
  const keytar = getKeytar();
  if (!keytar) return { anthropicKey: '', openaiKey: '' };
  const [anthropicKey, openaiKey] = await Promise.all([
    keytar.getPassword(SERVICE, ACCOUNTS.anthropic),
    keytar.getPassword(SERVICE, ACCOUNTS.openai),
  ]);
  return { anthropicKey: anthropicKey ?? '', openaiKey: openaiKey ?? '' };
}

export async function saveCredentials(creds: Partial<Credentials>): Promise<void> {
  const keytar = getKeytar();
  if (!keytar) return;
  const ops: Promise<void>[] = [];
  if (creds.anthropicKey !== undefined) {
    ops.push(
      creds.anthropicKey
        ? keytar.setPassword(SERVICE, ACCOUNTS.anthropic, creds.anthropicKey)
        : keytar.deletePassword(SERVICE, ACCOUNTS.anthropic).then(() => undefined),
    );
  }
  if (creds.openaiKey !== undefined) {
    ops.push(
      creds.openaiKey
        ? keytar.setPassword(SERVICE, ACCOUNTS.openai, creds.openaiKey)
        : keytar.deletePassword(SERVICE, ACCOUNTS.openai).then(() => undefined),
    );
  }
  await Promise.all(ops);
}
