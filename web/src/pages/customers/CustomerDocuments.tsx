import { useRef, useState } from "react";
import axios from "axios";
import { documentsApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { Icon } from "../../components/Icon";
import { Spinner } from "../../components/ui";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import type { CustomerDocument } from "../../lib/types";

/*
  Customer documents — the KYC slots and everything else.

  Lifted out of CustomersPage when the detail popup became a page, unchanged in
  behaviour. It lives on its own because the detail page and the KYC slots are
  now separate screens that both need it.
*/

// Fixed customer KYC slots — collected (not verified) and REPLACEABLE:
// re-uploading a slot deletes the previous file server-side. One current file
// per slot.
export const KYC_SLOTS = [
  { key: "aadhaar_front", label: "Aadhaar (front)" },
  { key: "aadhaar_back", label: "Aadhaar (back)" },
  { key: "pan", label: "PAN card" },
  { key: "photo", label: "Photograph", optional: true },
];
const KYC_KEYS = new Set(KYC_SLOTS.map((s) => s.key));

const DOC_TYPES = [
  { key: "aadhaar", label: "Aadhaar Card" },
  { key: "pan", label: "PAN Card" },
  { key: "photo", label: "Photograph" },
  { key: "address_proof", label: "Address Proof" },
  { key: "policy_doc", label: "Policy Document" },
  { key: "custom", label: "Other (custom)" },
];

/** Presign -> PUT to S3 -> confirm metadata. */
export async function uploadDocument(
  entityType: "customer" | "policy",
  entityId: string,
  file: File,
  label: string,
  docKey?: string,
) {
  const presign = (await documentsApi.presignUpload({
    entity_type: entityType, entity_id: entityId, filename: file.name,
    content_type: file.type, doc_key: docKey, label,
  })).data;
  await axios.put(presign.upload_url, file, {
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  await documentsApi.confirm({
    entity_type: entityType, entity_id: entityId, s3_key: presign.s3_key,
    filename: file.name, content_type: file.type, size_bytes: file.size,
    doc_key: docKey, label,
  });
}

async function download(id: string) {
  try {
    const { url } = (await documentsApi.download(id)).data;
    window.open(url, "_blank");
  } catch (e) {
    toast.error(apiError(e));
  }
}

export function CustomerDocuments({
  customerId, docs, canEdit, loading, onChanged,
}: {
  customerId: string;
  docs: CustomerDocument[];
  canEdit: boolean;
  loading: boolean;
  onChanged: () => void;
}) {
  const other = docs.filter((d) => !KYC_KEYS.has(d.doc_key ?? ""));

  return (
    <div className="space-y-5">
      <section>
        <p className="mb-2.5 text-caption font-semibold uppercase text-slate-500">
          KYC · Aadhaar &amp; PAN
        </p>
        <KycSlots customerId={customerId} docs={docs} canEdit={canEdit}
          loading={loading} onChanged={onChanged} />
      </section>

      <section>
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <p className="text-caption font-semibold uppercase text-slate-500">
            Other documents</p>
          {canEdit && (
            <DocumentUploader entityId={customerId} onUploaded={onChanged} />
          )}
        </div>
        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : other.length === 0 ? (
          <p className="rounded-control border border-dashed border-line px-4
            py-4 text-center text-sm text-slate-500">
            No other documents uploaded.
          </p>
        ) : (
          <ul className="divide-y divide-line/70 rounded-control border
            border-line">
            {other.map((d) => (
              <li key={d.id}
                className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="text-slate-400"><Icon.Policy size={18} /></span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {d.label}</p>
                    <p className="truncate text-xs text-slate-500">
                      {d.filename}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button className="btn-ghost btn-sm"
                    onClick={() => download(d.id)}>Download</button>
                  {canEdit && (
                    <button className="icon-btn icon-btn-danger"
                      aria-label={`Delete ${d.label}`} title={`Delete ${d.label}`}
                      onClick={async () => {
                        if (!(await confirmDialog({
                          message: `Delete "${d.label}"?`, danger: true })))
                          return;
                        await documentsApi.remove(d.id);
                        onChanged();
                      }}>
                      <Icon.Trash size={15} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Fixed KYC slots with per-slot upload/replace/view. Replacing is handled
 *  server-side (old file for the slot is deleted on the new upload). */
function KycSlots({ customerId, docs, canEdit, loading, onChanged }: {
  customerId: string;
  docs: CustomerDocument[];
  canEdit: boolean;
  loading: boolean;
  onChanged: () => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const byKey = (k: string) => docs.find((d) => d.doc_key === k);

  const upload = async (slotKey: string, label: string, file: File) => {
    setBusyKey(slotKey);
    try {
      await uploadDocument("customer", customerId, file, label, slotKey);
      toast.success("KYC document saved.");
      onChanged();
    } catch (e) {
      toast.error(apiError(e, "Upload failed."));
    } finally {
      setBusyKey(null);
    }
  };

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {KYC_SLOTS.map((slot) => {
        const doc = byKey(slot.key);
        return (
          <div key={slot.key}
            className="flex items-center justify-between gap-2 rounded-control
              border border-line px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800">{slot.label}</p>
              {doc ? (
                <button
                  className="block max-w-[180px] truncate text-left text-xs
                    text-slate-600 hover:text-slate-900 hover:underline"
                  onClick={() => download(doc.id)}>{doc.filename}</button>
              ) : (
                <p className="text-xs text-slate-500">Not uploaded</p>
              )}
            </div>
            {canEdit && (
              <label className="btn-secondary btn-sm shrink-0 cursor-pointer">
                {busyKey === slot.key ? <Spinner className="h-4 w-4" />
                  : doc ? "Replace" : "Upload"}
                <input type="file" className="hidden"
                  accept=".pdf,.jpg,.jpeg,.png"
                  disabled={busyKey === slot.key}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) upload(slot.key, slot.label, f);
                    e.currentTarget.value = "";
                  }} />
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DocumentUploader({ entityId, onUploaded }: {
  entityId: string; onUploaded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [docType, setDocType] = useState(DOC_TYPES[0].key);
  const [customName, setCustomName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handle = async (file: File) => {
    const isCustom = docType === "custom";
    const label = isCustom
      ? (customName.trim() || "Document")
      : DOC_TYPES.find((d) => d.key === docType)!.label;
    setBusy(true);
    try {
      await uploadDocument("customer", entityId, file, label,
        isCustom ? undefined : docType);
      toast.success("Document uploaded.");
      onUploaded();
      setOpen(false);
      setCustomName("");
    } catch (e) {
      toast.error(apiError(e, "Upload failed."));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (!open) {
    return (
      <button className="btn-secondary btn-sm" onClick={() => setOpen(true)}>
        <Icon.Upload size={15} /> Add document
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-control
      bg-slate-50 p-2">
      <select className="select h-9 max-w-[150px] text-sm" value={docType}
        onChange={(e) => setDocType(e.target.value)} disabled={busy}>
        {DOC_TYPES.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
      </select>
      {docType === "custom" && (
        <input className="input max-w-[150px] text-sm"
          placeholder="Document name" value={customName}
          onChange={(e) => setCustomName(e.target.value)} disabled={busy} />
      )}
      <label className="btn-primary btn-sm cursor-pointer">
        {busy ? <Spinner className="h-4 w-4" /> : "Choose file"}
        <input ref={fileRef} type="file" className="hidden"
          accept=".pdf,.jpg,.jpeg,.png" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handle(f); }} />
      </label>
      <button className="icon-btn border-transparent"
        aria-label="Cancel" title="Cancel" onClick={() => setOpen(false)}>
        <Icon.X size={15} />
      </button>
    </div>
  );
}
