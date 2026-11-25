import { useState } from "react";
import type { AxiosResponse } from "axios";
import { Download } from "lucide-react";
import { toast } from "./Toast";
import { apiError } from "../api/client";
import { downloadBlob } from "../lib/download";
import { useAuth } from "../store/auth";
import { Button } from "@/components/ui/button";

export function ExportButton({
  onExport,
  filename,
  label = "Export",
}: {
  onExport: (fmt: "excel") => Promise<AxiosResponse>;
  filename: string;
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
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 text-xs"
      disabled={busy}
      onClick={run}
    >
      <Download className="mr-1.5 h-3.5 w-3.5" />{" "}
      {busy ? "Exporting…" : label}
    </Button>
  );
}
