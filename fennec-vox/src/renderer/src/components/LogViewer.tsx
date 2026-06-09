import React, { useEffect, useRef } from 'react';

interface Props { lines: string[] }

function classifyLine(line: string): string {
  if (line.includes('ERROR') || line.includes('error')) return 'error';
  if (line.startsWith('[PROGRESS]'))                    return 'notice';
  return '';
}

export default function LogViewer({ lines }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom as new lines arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length]);

  return (
    <div className="log-viewer" aria-label="Conversion log" role="log" aria-live="polite">
      {lines.length === 0 ? (
        <span style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>Log output will appear here…</span>
      ) : (
        lines.map((line, i) => (
          <div key={i} className={`log-line ${classifyLine(line)}`}>{line}</div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}
