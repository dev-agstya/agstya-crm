import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Trash2, Upload } from "lucide-react";
import { authApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/shared/EmptyState";
import { ErrorState } from "../components/shared/ErrorState";
import { CardGridSkeleton } from "../components/shared/LoadingSkeleton";
import { toast } from "../components/Toast";
import { confirmDialog } from "../components/Confirm";
import { formatDate } from "../lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const KYC_DOCS: { key: string; label: string }[] = [
  { key: "pan_card", label: "PAN card" },
  { key: "aadhaar_front", label: "Aadhaar — front" },
  { key: "aadhaar_back", label: "Aadhaar — back" },
];
const KYC_KEYS = new Set(KYC_DOCS.map((d) => d.key));

export default function DocumentsPage() {
  const qc = useQueryClient();
  const [uploading, setUploading] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");

  const docsQ = useQuery({
    queryKey: ["my-docs"],
    queryFn: async () => (await authApi.myDocuments()).data,
  });

  const upload = useMutation({
    mutationFn: ({
      docKey,
      file,
      label,
    }: {
      docKey: string;
      file: File;
      label?: string;
    }) => authApi.uploadMyDoc(docKey, file, label),
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
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  if (docsQ.isError) return <ErrorState onRetry={() => docsQ.refetch()} />;
  if (docsQ.isLoading) return <CardGridSkeleton count={2} />;

  const all = docsQ.data ?? [];
  const byKey = new Map(
    all.filter((d) => d.doc_key).map((d) => [d.doc_key, d])
  );
  const customDocs = all.filter((d) => !d.doc_key || !KYC_KEYS.has(d.doc_key));

  const addCustom = (file: File) => {
    const name = customName.trim();
    if (!name) {
      toast.error("Give the document a name first.");
      return;
    }
    const docKey = `custom_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    upload.mutate({ docKey, file, label: name });
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="My Documents"
        subtitle="Personal KYC & certificates (max 10 MB each)"
      />

      <Card>
        <CardHeader className="px-4 py-3 pb-2">
          <CardTitle className="text-sm font-semibold">KYC Documents</CardTitle>
          <CardDescription className="text-xs">
            Upload clear photos or PDFs. Re-uploading replaces the existing file.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border px-4 pb-2 pt-0">
          {KYC_DOCS.map((d) => {
            const doc = byKey.get(d.key);
            const busy = uploading === d.key;
            return (
              <div
                key={d.key}
                className="flex flex-wrap items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{d.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {doc
                      ? `${doc.filename} · ${formatDate(doc.created_at)}`
                      : "Not uploaded yet"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {doc && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-2.5 text-xs"
                        onClick={() => open(doc.id)}
                      >
                        <Download className="mr-1 h-3.5 w-3.5" />
                        View
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title="Delete"
                        onClick={async () => {
                          if (
                            await confirmDialog({
                              message: `Delete ${d.label}?`,
                              danger: true,
                            })
                          )
                            remove.mutate(doc.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="h-8 cursor-pointer px-2.5 text-xs"
                  >
                    <label>
                      <Upload className="mr-1 h-3.5 w-3.5" />
                      {doc ? "Replace" : "Upload"}
                      <input
                        type="file"
                        className="hidden"
                        accept="image/*,application/pdf"
                        disabled={busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) upload.mutate({ docKey: d.key, file });
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 py-3 pb-2">
          <CardTitle className="text-sm font-semibold">Other Documents</CardTitle>
          <CardDescription className="text-xs">
            Agreements, licences, and certificates
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 max-w-xs text-sm"
              value={customName}
              aria-label="Document name"
              placeholder="Document name (e.g. GST certificate)"
              onChange={(e) => setCustomName(e.target.value)}
            />
            <Button
              asChild
              size="sm"
              className={`h-8 cursor-pointer ${
                customName.trim() ? "" : "pointer-events-none opacity-50"
              }`}
            >
              <label>
                <Upload className="mr-1 h-3.5 w-3.5" />
                Upload
                <input
                  type="file"
                  className="hidden"
                  accept="image/*,application/pdf"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) addCustom(file);
                    e.target.value = "";
                  }}
                />
              </label>
            </Button>
          </div>

          {customDocs.length === 0 ? (
            <EmptyState
              title="No custom documents"
              description="Name a document above and upload it to store it here."
            />
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {customDocs.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {doc.label}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {doc.filename} · {formatDate(doc.created_at)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2.5 text-xs"
                      onClick={() => open(doc.id)}
                    >
                      <Download className="mr-1 h-3.5 w-3.5" />
                      View
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      title="Delete"
                      onClick={async () => {
                        if (
                          await confirmDialog({
                            message: `Delete ${doc.label}?`,
                            danger: true,
                          })
                        )
                          remove.mutate(doc.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
