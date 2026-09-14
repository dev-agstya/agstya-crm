import { ReactNode, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { apiError } from "../api/client";
import { RecordPage } from "./RecordPage";
import { Icon } from "./Icon";
import { toast } from "./Toast";

export interface ImportFailure {
  row: number;
  reason: string;
}

export interface ImportOutcome {
  created: number;
  failed: ImportFailure[];
  detail: string;
}

function ProgressRing({ percent }: { percent: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" className="-rotate-90">
      <circle cx="36" cy="36" r={r} fill="none" stroke="#e8e8ea"
        strokeWidth="7" />
      <circle cx="36" cy="36" r={r} fill="none" stroke="#18181b"
        strokeWidth="7" strokeLinecap="round" strokeDasharray={c}
        strokeDashoffset={c - (percent / 100) * c}
        className="transition-all duration-200" />
    </svg>
  );
}

/**
 * THE bulk-import screen. Leads and customers had their own copies of this,
 * differing only in the noun and the column list, so it is one component with
 * the differences as props.
 *
 * A page rather than a dialog: the failed-row table can run to hundreds of
 * lines, and reading why 40 rows were rejected inside a scrolling popup is
 * miserable.
 */
export function ImportPage({
  backTo,
  backLabel,
  title,
  noun,
  columns,
  note,
  templateFilename,
  downloadTemplate,
  runImport,
  invalidateKey,
}: {
  backTo: string;
  backLabel: string;
  title: string;
  /** Singular, lowercase — "lead", "customer". Used in the result copy. */
  noun: string;
  /** The column list, shown verbatim. */
  columns: string;
  /** Anything else worth saying before they upload. */
  note?: ReactNode;
  templateFilename: string;
  downloadTemplate: () => Promise<{ data: unknown }>;
  runImport: (file: File, onProgress: (p: number) => void)
    => Promise<{ data: ImportOutcome }>;
  /** React Query key to invalidate once rows land. */
  invalidateKey: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [result, setResult] = useState<ImportOutcome | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const onDownload = async () => {
    try {
      const res = await downloadTemplate();
      const url = URL.createObjectURL(new Blob([res.data as BlobPart]));
      const a = document.createElement("a");
      a.href = url;
      a.download = templateFilename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  const onFile = async (file: File) => {
    setUploading(true);
    setResult(null);
    setProgress(0);
    try {
      const res = await runImport(file, (p) => setProgress(p));
      setResult(res.data);
      if (res.data.created > 0) {
        toast.success(res.data.detail);
        qc.invalidateQueries({ queryKey: [invalidateKey] });
      } else {
        toast.error(res.data.detail);
      }
    } catch (e) {
      toast.error(apiError(e, "Import failed. Check the file format."));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <RecordPage
      backTo={backTo}
      backLabel={backLabel}
      title={title}
      subtitle="Bulk-add from a spreadsheet using our template."
      actions={result && result.created > 0 && (
        <button className="btn-primary" onClick={() => navigate(backTo)}>
          View {result.created} imported {noun}
          {result.created === 1 ? "" : "s"}
        </button>
      )}
    >
      <div className="max-w-2xl space-y-4">
        <section className="card card-body">
          <h2 className="card-title">1. Start from the template</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-500">
            Columns: {columns}
          </p>
          {note && (
            <p className="mt-1 text-sm leading-relaxed text-slate-500">{note}</p>
          )}
          <button className="btn-secondary mt-3" onClick={onDownload}
            disabled={uploading}>
            <Icon.Download size={16} /> Download sample template
          </button>
        </section>

        <section className="card card-body">
          <h2 className="card-title">2. Upload your file</h2>
          {uploading ? (
            <div className="mt-3 flex flex-col items-center gap-3
              rounded-control border-2 border-dashed border-line bg-slate-50
              p-6">
              <ProgressRing percent={progress} />
              <div className="w-full">
                <div className="mb-1 flex justify-between text-xs
                  text-slate-500">
                  <span>Importing…</span>
                  <span className="font-semibold tabular-nums text-slate-900">
                    {progress}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full
                  bg-slate-200">
                  <div className="h-full rounded-full bg-ink transition-all"
                    style={{ width: `${progress}%` }} />
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-3 rounded-control border-2 border-dashed
              border-line p-6 text-center">
              <div className="mx-auto mb-3 w-fit rounded-full bg-slate-100 p-3
                text-slate-500">
                <Icon.Upload size={22} />
              </div>
              <label className="btn-primary cursor-pointer">
                Choose file to import
                <input ref={fileRef} type="file" className="hidden"
                  accept=".csv,.xlsx,.xlsm"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onFile(f);
                  }} />
              </label>
              <p className="mt-3 text-xs text-slate-500">
                .xlsx or .csv, up to 5,000 rows
              </p>
            </div>
          )}
        </section>

        {result && (
          <section className="card card-body">
            <h2 className="card-title">Result</h2>
            <p className="mt-1 text-sm text-slate-700">{result.detail}</p>
            <div className="mt-2 flex gap-4 text-sm">
              <span className="text-money-in">{result.created} added</span>
              {result.failed.length > 0 && (
                <span className="text-money-out">
                  {result.failed.length} failed</span>
              )}
            </div>
            {result.failed.length > 0 && (
              <div className="mt-3 max-h-80 overflow-y-auto scrollbar-light
                rounded-control border border-line">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="w-16">Row</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.failed.map((f) => (
                      <tr key={f.row}>
                        <td className="font-medium tabular-nums">{f.row}</td>
                        <td className="text-money-out">{f.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </RecordPage>
  );
}
