import { useState } from "react";
import { Download, FileText, Loader2, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { documentsApi, policiesApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { toast } from "./Toast";
import { confirmDialog } from "./Confirm";
import { formatDate } from "../lib/format";
import {
  buildPolicyDocRows, customDocKey, missingRequiredDocs,
} from "../lib/policyDocs";
import type { PolicyDocRow } from "../lib/policyDocs";
import type { CustomerDocument, RequiredDocSpec } from "../lib/types";

/*
  Everything attached to a policy, in ONE list (owner 2026-08-04, B1c + B2a).

  Before this, the policy page showed a single "Policy document" card holding
  the policy PDF, and the supporting documents collected at booking — the RC
  book, the previous policy, whatever the policy TYPE asks for — were loaded by
  the same query and then thrown away. They existed on S3 and in Mongo and
  nowhere on screen. There was also no way to attach a document to a policy
  after booking at all.

  So: the PDF, the type's configured slots (including the EMPTY ones, which is
  how a missing required document becomes visible), then anything else, then an
  "Add document" row for the one-offs. Upload, replace, download, delete.

  The policy PDF is deliberately REPLACE-ONLY here: deleting it silently breaks
  the customer's WhatsApp/email copy and the partner portal's download, and the
  Edit form already replaces it. Everything else can be removed.
*/

// What may be attached from this page (owner B4). The policy PDF slot stays
// PDF-only — it is the policy, and the messaging service sends it as one.
const DOC_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp";
const PDF_ACCEPT = "application/pdf,.pdf";
const MAX_MB = 20;

function sizeLabel(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PolicyDocuments({
  policyId, docs, slots, loading, canManage, canView, onChanged,
}: {
  policyId: string;
  docs: CustomerDocument[] | undefined;
  slots: RequiredDocSpec[];
  loading: boolean;
  canManage: boolean;
  /** False when the viewer lacks view_policies — the list query yields nothing
   *  and the reason has to be said rather than shown as "no documents". */
  canView: boolean;
  onChanged: () => void;
}) {
  const rows = buildPolicyDocRows(docs, slots);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const open = async (docId: string) => {
    try {
      const { data } = await documentsApi.download(docId);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  /** Upload into a slot. The policy PDF has its own endpoint (it replaces the
   *  single PDF and, on the first one, sends it to the customer); everything
   *  else goes through the extra-document endpoint, keyed by slot. */
  const upload = async (row: PolicyDocRow, file: File) => {
    if (file.size > MAX_MB * 1024 * 1024)
      return toast.error(`"${file.name}" is larger than ${MAX_MB} MB.`);
    const rowId = row.key ?? row.doc?.id ?? row.label;
    setBusyKey(rowId);
    try {
      if (row.kind === "pdf") await policiesApi.uploadDocument(policyId, file);
      else await policiesApi.uploadExtraDocument(
        policyId, row.key ?? customDocKey(), row.label, file);
      toast.success(row.doc ? "Document replaced." : "Document uploaded.");
      onChanged();
    } catch (e) {
      toast.error(apiError(e, "Upload failed."));
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (row: PolicyDocRow) => {
    if (!row.doc) return;
    if (!(await confirmDialog({
      title: "Delete document?",
      message: `Delete "${row.doc.label || row.doc.filename}"? This removes the `
        + "file for good.",
      confirmLabel: "Delete document",
      danger: true,
    }))) return;
    try {
      await documentsApi.remove(row.doc.id);
      toast.success("Document deleted.");
      onChanged();
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  const missing = missingRequiredDocs(rows);

  return (
    <div className="rounded-control border border-line/70">
      <div className="flex flex-wrap items-center justify-between gap-2
        border-b border-line/70 px-4 py-2.5">
        <p className="text-sm font-medium text-slate-600">Documents</p>
        {canManage && !adding && (
          <Button type="button" variant="outline" size="sm"
            onClick={() => setAdding(true)}>
            <Upload className="mr-1.5 h-3.5 w-3.5" /> Add document
          </Button>
        )}
      </div>

      {!canView ? (
        <p className="px-4 py-4 text-sm text-slate-500">
          You don't have access to view this policy's documents.
        </p>
      ) : loading ? (
        <p className="px-4 py-4 text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          {missing.length > 0 && (
            <p className="border-b border-line/70 bg-due/10 px-4 py-2 text-xs
              text-due">
              {missing.length === 1
                ? `"${missing[0].label}" has not been attached.`
                : `${missing.length} required documents have not been `
                  + "attached."}
            </p>
          )}
          <ul className="divide-y divide-line/70">
            {rows.map((row) => (
              <DocumentRow key={row.doc?.id ?? row.key ?? row.label} row={row}
                busy={busyKey === (row.key ?? row.doc?.id ?? row.label)}
                canManage={canManage}
                onOpen={() => row.doc && open(row.doc.id)}
                onUpload={(f) => upload(row, f)}
                onDelete={() => remove(row)} />
            ))}
          </ul>
          {adding && (
            <AddDocumentRow
              onCancel={() => setAdding(false)}
              onPick={async (label, file) => {
                await upload({ key: customDocKey(), label, kind: "extra",
                  required: false }, file);
                setAdding(false);
              }} />
          )}
        </>
      )}
    </div>
  );
}

function DocumentRow({ row, busy, canManage, onOpen, onUpload, onDelete }: {
  row: PolicyDocRow;
  busy: boolean;
  canManage: boolean;
  onOpen: () => void;
  onUpload: (file: File) => void;
  onDelete: () => void;
}) {
  const isPdf = row.kind === "pdf";
  const size = sizeLabel(row.doc?.size_bytes);
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className={row.doc ? "text-slate-500" : "text-slate-300"}>
          <FileText className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2 truncate text-sm font-medium text-slate-800">
            <span>{row.label}</span>
            {isPdf && <Badge variant="secondary" className="text-[11px]">Policy</Badge>}
            {!row.doc && row.required && (
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800 text-[11px]">required</Badge>
            )}
          </div>
          {row.doc ? (
            <button type="button" onClick={onOpen}
              className="block max-w-full truncate text-left text-xs
                text-slate-500 hover:text-slate-900 hover:underline">
              {row.doc.filename}
              {size ? ` · ${size}` : ""}
              {` · ${formatDate(row.doc.created_at)}`}
            </button>
          ) : (
            <p className="text-xs text-slate-500">Not uploaded</p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {row.doc && (
          <Button type="button" variant="ghost" size="sm" onClick={onOpen}>
            <Download className="mr-1.5 h-3.5 w-3.5" /> Download
          </Button>
        )}
        {canManage && (
          <Button type="button" variant="outline" size="sm" asChild className="shrink-0 cursor-pointer">
            <label>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" />
                : row.doc ? "Replace" : "Upload"}
              <input type="file" className="hidden" disabled={busy}
                accept={isPdf ? PDF_ACCEPT : DOC_ACCEPT}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.currentTarget.value = "";
                  if (f) onUpload(f);
                }} />
            </label>
          </Button>
        )}
        {canManage && row.doc && !isPdf && (
          <Button type="button" variant="ghost" size="icon"
            className="h-8 w-8 text-red-600 hover:bg-red-50 hover:text-red-700"
            aria-label={`Delete ${row.label}`} title={`Delete ${row.label}`}
            onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </li>
  );
}

function AddDocumentRow({ onCancel, onPick }: {
  onCancel: () => void;
  onPick: (label: string, file: File) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const label = name.trim();

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2.5">
      <Input className="h-8 max-w-[220px] text-sm" value={name}
        autoFocus disabled={busy} placeholder="Document name — e.g. RC book"
        onChange={(e) => setName(e.target.value)} />
      <Button size="sm" asChild className={`cursor-pointer${
        label && !busy ? "" : " pointer-events-none opacity-50"}`}>
        <label>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Choose file"}
          <input type="file" className="hidden"
            accept={DOC_ACCEPT} disabled={busy || !label}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.currentTarget.value = "";
              if (!f) return;
              setBusy(true);
              try { await onPick(label, f); } finally { setBusy(false); }
            }} />
        </label>
      </Button>
      <span className="text-xs text-slate-500">
        PDF or image, up to {MAX_MB} MB.
      </span>
      <Button type="button" variant="ghost" size="icon" className="ml-auto h-8 w-8"
        aria-label="Cancel" title="Cancel" onClick={onCancel}
        disabled={busy}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
