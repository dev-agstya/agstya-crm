import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/ui";

const BASE = import.meta.env.VITE_API_BASE_URL || "";

// Mirrors routers/public.py — the server refuses anything outside this set and
// anything over the cap, so we say so here instead of after a round-trip.
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

/** Content type from the filename, for browsers that report an empty file.type. */
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
        setError(e.response?.data?.detail || "This link is invalid or expired."))
      .finally(() => setLoading(false));
  }, [token]);

  const upload = async (file: File, label: string, key?: string) => {
    setUploading(true);
    setError("");
    try {
      // The browser leaves file.type empty for some files (and for anything
      // dragged from certain apps). The server now REFUSES a blank type, so
      // fall back to the extension rather than sending "".
      const contentType = file.type || guessContentType(file.name);
      if (file.size > MAX_UPLOAD_BYTES) {
        setError("That file is larger than 20 MB. Please upload a smaller one.");
        return;
      }
      const presign = await axios.post(
        `${BASE}/api/public/upload/${token}/presign`,
        { filename: file.name, content_type: contentType, doc_key: key, label }
      );
      // Presigned POST (not PUT): S3 itself enforces the signed content-type
      // and size range, so an oversized or wrong-typed upload is rejected at
      // the bucket instead of being taken on trust.
      const form = new FormData();
      for (const [k, v] of Object.entries(
        presign.data.fields as Record<string, string>
      ))
        form.append(k, v);
      form.append("file", file);
      await axios.post(presign.data.upload_url, form);

      await axios.post(`${BASE}/api/public/upload/${token}/confirm`, {
        s3_key: presign.data.s3_key,
        filename: file.name,
        content_type: contentType,
        doc_key: key,
        label,
      });
      setDone((d) => [...d, label]);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } } };
      setError(err.response?.data?.detail || "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-8 w-8 text-slate-900" />
      </div>
    );

  return (
    <div className="min-h-screen bg-slate-50 py-10">
      <div className="mx-auto max-w-lg px-4">
        <div className="mb-6 flex items-center justify-center">
          <img
            src="/agastya_hindi_full_logo.png"
            alt="Agstya Associate"
            className="h-10 w-auto object-contain"
          />
        </div>

        {error ? (
          <div className="card p-8 text-center">
            <div className="mx-auto mb-3 w-fit rounded-full bg-money-out/10 p-3 text-money-out">
              <Icon.X size={28} />
            </div>
            <p className="font-medium text-slate-700">{error}</p>
          </div>
        ) : (
          <div className="card p-8">
            <h1 className="text-page-title text-slate-900">
              Hello {info?.customer_name}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Please upload the documents requested below. Your files are stored
              securely.
            </p>
            {info?.message && (
              <p className="mt-4 rounded-control bg-slate-100 px-4 py-3 text-sm text-slate-900">
                {info.message}
              </p>
            )}

            <div className="mt-6 space-y-3">
              {(info?.requested_docs || []).map((d, i) => {
                const label = d.label || d.key || `Document ${i + 1}`;
                const uploaded = done.includes(label);
                return (
                  <div key={i}
                    className="flex items-center justify-between rounded-control border
                      border-line px-4 py-3">
                    <div className="flex items-center gap-3">
                      {uploaded ? (
                        <span className="text-money-in"><Icon.Check size={20} /></span>
                      ) : (
                        <span className="text-slate-300"><Icon.Policy size={20} /></span>
                      )}
                      <span className="text-sm font-medium text-slate-700">{label}</span>
                    </div>
                    {uploaded ? (
                      <span className="text-xs font-medium text-money-in">Uploaded</span>
                    ) : (
                      <label className="btn-secondary cursor-pointer px-3 py-1 text-xs">
                        <Icon.Download size={14} /> Choose file
                        <input type="file" className="hidden" disabled={uploading}
                          accept=".pdf,.jpg,.jpeg,.png"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) upload(f, label, d.key);
                          }} />
                      </label>
                    )}
                  </div>
                );
              })}
            </div>

            {uploading && (
              <div className="mt-4 flex items-center gap-2 text-sm text-slate-900">
                <Spinner /> Uploading…
              </div>
            )}

            {done.length > 0 &&
              done.length === (info?.requested_docs.length || 0) && (
                <p className="mt-6 rounded-control bg-money-in/10 px-4 py-3 text-center text-sm
                  font-medium text-money-in">
                  All documents uploaded. Thank you!
                </p>
              )}
          </div>
        )}
      </div>
    </div>
  );
}
