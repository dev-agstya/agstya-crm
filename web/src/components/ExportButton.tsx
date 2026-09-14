import { useState } from "react";
import type { AxiosResponse } from "axios";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import { apiError } from "../api/client";
import { downloadBlob } from "../lib/download";
import { useAuth } from "../store/auth";

// Excel export button (owner 2026-07-17: Excel only, no CSV). One click →
// downloads the .xlsx of the current (filtered) list. Hidden unless the user
// holds `export_data`. `onExport("excel")` calls the matching blob endpoint.
export function ExportButton({ onExport, filename, label = "Export" }: {
  onExport: (fmt: "excel") => Promise<AxiosResponse>;
  filename: string;            // without extension
  label?: string;
}) {
  const { has } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!has("export_data")) return null;

  const run = async () => {
    setBusy(true);
    try {
      const res = await onExport("excel");
      downloadBlob(res.data as Blob, `${filename}.xlsx`);
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button className="btn-secondary" disabled={busy}
      onClick={run}>
      <Icon.Download size={16} /> {busy ? "Exporting…" : label}
    </button>
  );
}
