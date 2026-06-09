import React, { useCallback, useState } from 'react';

interface FilePickerProps {
  value:      string;
  onChange:   (path: string) => void;
  onPickDir:  () => void;
}

export default function FilePicker({ value, onChange, onPickDir }: FilePickerProps) {
  const [dragOver, setDragOver] = useState(false);

  const handleClick = useCallback(async () => {
    const result = await window.api.selectEpub();
    if (result) onChange(result);
  }, [onChange]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.epub') || file.name.endsWith('.pdf'))) {
      // Electron exposes a non-standard .path property on File objects
      const filePath = (file as File & { path?: string }).path;
      if (filePath) onChange(filePath);
    }
  };

  const basename = value ? value.split('/').pop() ?? value : '';
  const isPdf    = value.toLowerCase().endsWith('.pdf');
  const icon     = value ? (isPdf ? '📄' : '📖') : '📂';

  return (
    <div className="file-picker">
      <div
        className={`file-picker-drop${dragOver ? ' drag-over' : ''}`}
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && handleClick()}
        aria-label="Select EPUB or PDF file"
      >
        <div className="icon">{icon}</div>
        {value ? (
          <p><strong>{basename}</strong></p>
        ) : (
          <p>Click to select or<br /><strong>drop an EPUB or PDF here</strong></p>
        )}
      </div>

      {value && (
        <div className="file-name" title={value}>{value}</div>
      )}

      <button
        className="btn btn-secondary"
        style={{ fontSize: 11, padding: '4px 8px' }}
        onClick={onPickDir}
        type="button"
      >
        📁 Set output folder
      </button>
    </div>
  );
}
