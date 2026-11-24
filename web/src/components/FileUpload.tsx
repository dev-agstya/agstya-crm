import { useRef, useState, type DragEvent, type ChangeEvent } from "react";
import { Icon } from "./Icon";

export interface FileUploadProps {
  file: File | null;
  onChange: (file: File | null) => void;
  accept?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileUpload({
  file,
  onChange,
  accept = "application/pdf,.pdf,image/*",
  hint = "PDF or image up to 20 MB",
  disabled = false,
  className = "",
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (disabled) return;
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) onChange(droppedFile);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    onChange(selected);
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  if (file) {
    return (
      <div
        className={`flex items-center justify-between gap-3 rounded-control border border-line bg-white p-3 transition-colors ${className}`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-slate-100 text-slate-700">
            <Icon.Policy size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-800" title={file.name}>
              {file.name}
            </p>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
              <span>{formatBytes(file.size)}</span>
              <span className="inline-flex items-center gap-1 font-medium text-money-in">
                <Icon.Check size={12} /> Ready
              </span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
            title="Change file"
            aria-label="Change file"
          >
            <Icon.Upload size={15} />
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={handleRemove}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-money-out"
            title="Remove file"
            aria-label="Remove file"
          >
            <Icon.Trash size={15} />
          </button>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={accept}
          onChange={handleFileChange}
          disabled={disabled}
          className="hidden"
        />
      </div>
    );
  }

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`group flex cursor-pointer flex-col items-center justify-center rounded-control border-2 border-dashed p-4 text-center transition-all ${
        isDragging
          ? "border-ink bg-slate-100/70"
          : "border-line bg-slate-50/50 hover:border-slate-300 hover:bg-slate-100/40"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""} ${className}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleFileChange}
        disabled={disabled}
        className="hidden"
      />
      <div className="mb-2 rounded-full bg-slate-200/70 p-2 text-slate-600 transition-colors group-hover:bg-slate-200 group-hover:text-slate-900">
        <Icon.Upload size={16} />
      </div>
      <p className="text-xs font-medium text-slate-700">
        Click to browse or drop file here
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}
