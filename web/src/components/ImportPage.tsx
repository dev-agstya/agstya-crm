import { ReactNode, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { apiError } from "../api/client";
import { RecordPage } from "./RecordPage";
import { toast } from "./Toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
      <circle
        cx="36"
        cy="36"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        className="text-muted"
      />
      <circle
        cx="36"
        cy="36"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c - (percent / 100) * c}
        className="text-primary transition-all duration-200"
      />
    </svg>
  );
}

/**
 * THE bulk-import screen.
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
  noun: string;
  columns: string;
  note?: ReactNode;
  templateFilename: string;
  downloadTemplate: () => Promise<{ data: unknown }>;
  runImport: (file: File, onProgress: (p: number) => void) => Promise<{ data: ImportOutcome }>;
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
      actions={
        result && result.created > 0 && (
          <Button size="sm" onClick={() => navigate(backTo)}>
            View {result.created} imported {noun}
            {result.created === 1 ? "" : "s"}
          </Button>
        )
      }
    >
      <div className="max-w-2xl space-y-4">
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">1. Start from the template</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Columns: <span className="font-mono text-foreground">{columns}</span>
            </p>
            {note && (
              <p className="text-xs text-muted-foreground leading-relaxed">{note}</p>
            )}
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={onDownload}
                disabled={uploading}
                className="h-8 text-xs"
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Download sample template
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">2. Upload your file</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {uploading ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border bg-muted/20 p-6">
                <ProgressRing percent={progress} />
                <div className="w-full max-w-xs">
                  <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                    <span>Importing…</span>
                    <span className="font-semibold tabular-nums text-foreground">{progress}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-200"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border-2 border-dashed border-border p-6 text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Upload className="h-5 w-5" />
                </div>
                <div>
                  <Button asChild size="sm" className="h-8 text-xs cursor-pointer">
                    <label>
                      Choose file to import
                      <input
                        ref={fileRef}
                        type="file"
                        className="hidden"
                        accept=".csv,.xlsx,.xlsm"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) onFile(f);
                        }}
                      />
                    </label>
                  </Button>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  .xlsx or .csv, up to 5,000 rows
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {result && (
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm font-semibold">Result</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 space-y-2">
              <p className="text-xs text-foreground font-medium">{result.detail}</p>
              <div className="flex gap-4 text-xs">
                <span className="text-emerald-700 font-semibold">{result.created} added</span>
                {result.failed.length > 0 && (
                  <span className="text-red-600 font-semibold">{result.failed.length} failed</span>
                )}
              </div>
              {result.failed.length > 0 && (
                <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted text-muted-foreground sticky top-0">
                      <tr>
                        <th className="w-16 px-3 py-1.5 text-left font-medium">Row</th>
                        <th className="px-3 py-1.5 text-left font-medium">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {result.failed.map((f) => (
                        <tr key={f.row} className="hover:bg-muted/30">
                          <td className="px-3 py-1.5 font-medium tabular-nums">{f.row}</td>
                          <td className="px-3 py-1.5 text-red-600">{f.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </RecordPage>
  );
}
