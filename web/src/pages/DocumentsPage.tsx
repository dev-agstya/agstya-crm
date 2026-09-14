import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { EmptyState, ErrorState, PageLoader, Spinner } from "../components/ui";
import { toast } from "../components/Toast";
import { confirmDialog } from "../components/Confirm";
import { formatDate } from "../lib/format";

const KYC_DOCS: { key: string; label: string }[] = [
  { key: "pan_card", label: "PAN card" },
  { key: "aadhaar_front", label: "Aadhaar — front" },
  { key: "aadhaar_back", label: "Aadhaar — back" },
];
const KYC_KEYS = new Set(KYC_DOCS.map((d) => d.key));

// "My Documents": a personal store for the signed-in user (owners included).
// Fixed KYC slots plus any number of custom documents. Upload / view / delete.
export default function DocumentsPage() {
  const qc = useQueryClient();
  const [uploading, setUploading] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");

  const docsQ = useQuery({
    queryKey: ["my-docs"],
    queryFn: async () => (await authApi.myDocuments()).data,
  });

  const upload = useMutation({
    mutationFn: ({ docKey, file, label }:
      { docKey: string; file: File; label?: string }) =>
      authApi.uploadMyDoc(docKey, file, label),
    onMutate: (v) => setUploading(v.docKey),
    onSuccess: () => {
      toast.success("Document uploaded.");
      setCustomName("");
      qc.invalidateQueries({ queryKey: ["my-docs"] });
    },
    onError: (e) => toast.error(apiError(e)),
    onSettled: () => setUploading(null),
  });

  const remove = useMutation({
    mutationFn: (docId: string) => authApi.deleteMyDoc(docId),
    onSuccess: () => {
      toast.success("Document deleted.");
      qc.invalidateQueries({ queryKey: ["my-docs"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const open = async (docId: string) => {
    try {
      const r = await authApi.downloadMyDoc(docId);
      window.open(r.data.url, "_blank", "noopener");
    } catch (e) { toast.error(apiError(e)); }
  };

  if (docsQ.isError) return <ErrorState onRetry={() => docsQ.refetch()} />;
  if (docsQ.isLoading) return <PageLoader />;

  const all = docsQ.data ?? [];
  const byKey = new Map(all.filter((d) => d.doc_key).map((d) => [d.doc_key, d]));
  const customDocs = all.filter((d) => !d.doc_key || !KYC_KEYS.has(d.doc_key));

  const addCustom = (file: File) => {
    const name = customName.trim();
    if (!name) { toast.error("Give the document a name first."); return; }
    const docKey = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    upload.mutate({ docKey, file, label: name });
  };

  return (
    <div>
      <PageHeader title="My Documents" />

      {/* KYC documents */}
      <div className="card mb-5 p-5">
        <p className="mb-1 text-sm font-semibold text-slate-700">
          KYC documents</p>
        <p className="mb-4 text-sm text-slate-500">
          Upload clear photos or PDFs. Max 10&nbsp;MB each. Re-uploading replaces
          the existing file.
        </p>
        <div className="space-y-3">
          {KYC_DOCS.map((d) => {
            const doc = byKey.get(d.key);
            const busy = uploading === d.key;
            return (
              <div key={d.key}
                className="flex items-center justify-between gap-3 rounded-control
                  border border-line p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-700">{d.label}</p>
                  <p className="truncate text-xs text-slate-500">
                    {doc ? `${doc.filename} · ${formatDate(doc.created_at)}`
                      : "Not uploaded yet"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {busy && <Spinner className="h-4 w-4" />}
                  {doc && (
                    <>
                      <button className="btn-secondary
                        text-xs" onClick={() => open(doc.id)}>
                        <Icon.Download size={14} /> View
                      </button>
                      <button className="icon-btn text-money-out" title="Delete"
                        onClick={async () => {
                          if (await confirmDialog({ message: `Delete ${d.label}?`,
                            danger: true })) remove.mutate(doc.id);
                        }}><Icon.Trash size={14} /></button>
                    </>
                  )}
                  <label className="btn-secondary cursor-pointer text-xs">
                    {doc ? "Replace" : "Upload"}
                    <input type="file" className="hidden"
                      accept="image/*,application/pdf" disabled={busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) upload.mutate({ docKey: d.key, file });
                        e.target.value = "";
                      }} />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Custom documents */}
      <div className="card">
        {/* `.card-head` and `.filter-bar`, not a hand-rolled `mb-4 flex` row
            floating inside the padding. index.css calls that pattern out by
            name — a row aligned with nothing, which also vanished on the empty
            state, exactly when you want to use it. This one survived that
            pass. */}
        <div className="card-head">
          <div>
            <h2 className="card-title">Other documents</h2>
            <p className="mt-0.5 text-secondary text-slate-500">
              Agreements, licences, certificates.</p>
          </div>
        </div>
        <div className="filter-bar">
          <input className="input w-56" value={customName}
            aria-label="Document name"
            placeholder="Name the document — e.g. GST certificate"
            onChange={(e) => setCustomName(e.target.value)} />
          <label className={`btn-primary cursor-pointer ${
            customName.trim() ? "" : "pointer-events-none opacity-50"}`}>
            <Icon.Upload size={15} /> Add
            <input type="file" className="hidden"
              accept="image/*,application/pdf"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) addCustom(file);
                e.target.value = "";
              }} />
          </label>
        </div>

        {customDocs.length === 0 ? (
          <EmptyState title="No custom documents"
            hint="Name a document above and upload it to store it here." />
        ) : (
          <div className="space-y-3">
            {customDocs.map((doc) => (
              <div key={doc.id}
                className="flex items-center justify-between gap-3 rounded-control
                  border border-line p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-700">{doc.label}</p>
                  <p className="truncate text-xs text-slate-500">
                    {doc.filename} · {formatDate(doc.created_at)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button className="btn-secondary
                    text-xs" onClick={() => open(doc.id)}>
                    <Icon.Download size={14} /> View
                  </button>
                  <button className="icon-btn text-money-out" title="Delete"
                    onClick={async () => {
                      if (await confirmDialog({ message: `Delete ${doc.label}?`,
                        danger: true })) remove.mutate(doc.id);
                    }}><Icon.Trash size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
