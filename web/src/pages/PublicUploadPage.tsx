import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Loader2,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const BASE = import.meta.env.VITE_API_BASE_URL || "";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

function guessContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[ext] ?? "";
}

interface RequestInfo {
  customer_name: string;
  requested_docs: { key?: string; label?: string }[];
  message?: string | null;
  completed: boolean;
}

export default function PublicUploadPage() {
  const { token } = useParams();
  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState<string[]>([]);

  useEffect(() => {
    axios
      .get(`${BASE}/api/public/upload/${token}`)
      .then((r) => setInfo(r.data))
      .catch((e) =>
        setError(e.response?.data?.detail || "This link is invalid or expired.")
      )
      .finally(() => setLoading(false));
  }, [token]);

  const upload = async (file: File, label: string, key?: string) => {
    setUploading(true);
    setError("");
    try {
      const contentType = file.type || guessContentType(file.name);
      if (file.size > MAX_UPLOAD_BYTES) {
        setError("That file is larger than 20 MB. Please upload a smaller one.");
        return;
      }
      const presign = await axios.post(
        `${BASE}/api/public/upload/${token}/presign`,
        { filename: file.name, content_type: contentType, doc_key: key, label }
      );
      const form = new FormData();
      for (const [k, v] of Object.entries(
        presign.data.fields as Record<string, string>
      )) {
        form.append(k, v);
      }
      form.append("file", file);
      await axios.post(presign.data.upload_url, form);

      await axios.post(`${BASE}/api/public/upload/${token}/confirm`, {
        s3_key: presign.data.s3_key,
        filename: file.name,
        content_type: contentType,
        size_bytes: file.size,
        doc_key: key,
        label,
      });
      setDone((d) => [...d, key || label]);
    } catch (e: any) {
      setError(
        e.response?.data?.detail || "Upload failed. Please try again."
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted/40 px-4 py-10">
      <div className="mx-auto max-w-lg space-y-6">
        <div className="flex flex-col items-center text-center">
          <img
            src="/agastya_hindi_full_logo.png"
            alt="Agstya Associate"
            className="h-10 w-auto object-contain"
          />
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
            <span>Secure Document Upload</span>
          </div>
        </div>

        <Card className="shadow-sm">
          {loading ? (
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="mt-3 text-sm text-muted-foreground">
                Checking upload link...
              </p>
            </CardContent>
          ) : error && !info ? (
            <CardContent className="py-10 text-center">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </CardContent>
          ) : info ? (
            <>
              <CardHeader>
                <CardTitle>Upload Documents</CardTitle>
                <CardDescription>
                  Requested for <strong>{info.customer_name}</strong>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {info.message && (
                  <Alert>
                    <FileText className="h-4 w-4" />
                    <AlertDescription>{info.message}</AlertDescription>
                  </Alert>
                )}

                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-3">
                  {(info.requested_docs.length > 0
                    ? info.requested_docs
                    : [{ label: "Document" }]
                  ).map((doc, i) => {
                    const id = doc.key || doc.label || `doc-${i}`;
                    const label = doc.label || doc.key || "Document";
                    const uploaded = done.includes(id);
                    return (
                      <div
                        key={id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">
                            {label}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            PDF, JPG, PNG (max 20 MB)
                          </p>
                        </div>
                        {uploaded ? (
                          <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Uploaded
                          </Badge>
                        ) : (
                          <Button
                            asChild
                            size="sm"
                            variant="outline"
                            disabled={uploading}
                            className="cursor-pointer"
                          >
                            <label>
                              <Upload className="mr-1.5 h-3.5 w-3.5" />
                              {uploading ? "Uploading..." : "Choose file"}
                              <input
                                type="file"
                                accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif"
                                className="hidden"
                                disabled={uploading}
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) upload(f, label, doc.key);
                                  e.target.value = "";
                                }}
                              />
                            </label>
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
