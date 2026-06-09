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
    if (file && file.name.endsWith('.epub')) {
      // In Electron, File has a .path property via webkitGetAsEntry or direct .path
      const filePath = (file as File & { path?: string }).path;
      if (filePath) onChange(filePath);
    }
  };

  const basename = value ? value.split('/').pop() ?? value : '';

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
        aria-label="Select EPUB file"
      >
        <div className="icon">📖</div>
        {value ? (
          <p><strong>{basename}</strong></p>
        ) : (
          <p>Click to select or<br /><strong>drop an EPUB here</strong></p>
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
