import { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  useDocumentTitle(title);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        {/* Brand lockup */}
        <div className="flex flex-col items-center text-center">
          <img
            src="/agastya_hindi_full_logo.png"
            alt="Agstya Associate"
            className="h-11 w-auto object-contain"
          />
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
            <span>Agstya Associate Portal</span>
          </div>
        </div>

        {/* Main Card */}
        <Card className="shadow-sm">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-xl font-bold tracking-tight">
              {title}
            </CardTitle>
            {subtitle && (
              <CardDescription className="text-sm">
                {subtitle}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} Agstya Associate · All rights reserved
        </p>
      </div>
    </div>
  );
}
