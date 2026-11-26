import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Bike, Car, ShieldCheck, Truck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DotPattern } from "@/components/ui/dot-pattern";
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
    <div className="grid min-h-screen lg:grid-cols-12">
      {/* Left Colorful Brand Panel (Desktop) */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-slate-950 via-indigo-950 to-blue-900 p-10 text-white lg:col-span-5 lg:flex">
        <DotPattern className="opacity-20 text-indigo-300" />
        <div className="pointer-events-none absolute -left-20 -top-20 h-72 w-72 rounded-full bg-blue-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -right-20 h-72 w-72 rounded-full bg-emerald-500/20 blur-3xl" />

        <div className="relative z-10 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <img
              src="/agastya_hindi_half_logo.png"
              alt="Agastya Associate"
              className="h-9 w-9 rounded-lg object-contain bg-white/10 p-1"
            />
            <span className="text-base font-bold tracking-tight text-white">
              AGASTYA ASSOCIATE
            </span>
          </Link>
        </div>

        <div className="relative z-10 space-y-6">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-200">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Insurance CRM &amp; Partner Portal</span>
          </div>

          <h2 className="text-3xl font-bold leading-tight tracking-tight">
            Manage policies, renewals, claims &amp; commissions in one place.
          </h2>

          <div className="grid grid-cols-3 gap-3 pt-2">
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <Car className="mb-1.5 h-4 w-4 text-sky-300" />
              <p className="text-xs font-semibold">Car</p>
              <p className="text-[11px] text-slate-300">Private cover</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <Bike className="mb-1.5 h-4 w-4 text-emerald-300" />
              <p className="text-xs font-semibold">2-Wheeler</p>
              <p className="text-[11px] text-slate-300">Quick issue</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <Truck className="mb-1.5 h-4 w-4 text-amber-300" />
              <p className="text-xs font-semibold">Commercial</p>
              <p className="text-[11px] text-slate-300">Fleet &amp; risk</p>
            </div>
          </div>
        </div>

        <div className="relative z-10 text-xs text-slate-300">
          10-A, Road number 5, Panchwati, Udaipur · Open 24 hours
        </div>
      </div>

      {/* Right Auth Form Panel */}
      <div className="flex flex-col items-center justify-center bg-gradient-to-br from-slate-50 via-indigo-50/40 to-sky-50/40 px-4 py-10 lg:col-span-7">
        <div className="w-full max-w-md space-y-5">
          <div className="flex items-center justify-between">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 transition-colors hover:text-indigo-600"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to Home
            </Link>
            <img
              src="/agastya_hindi_half_logo.png"
              alt="Agastya"
              className="h-8 w-8 rounded object-contain lg:hidden"
            />
          </div>

          <Card className="border-indigo-100/80 bg-white shadow-sm">
            <div className="h-1.5 w-full rounded-t-lg bg-gradient-to-r from-indigo-600 via-blue-600 to-emerald-500" />
            <CardHeader className="space-y-1 pb-4">
              <CardTitle className="text-xl font-bold tracking-tight text-slate-900">
                {title}
              </CardTitle>
              {subtitle && (
                <CardDescription className="text-sm text-slate-600">
                  {subtitle}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent>{children}</CardContent>
          </Card>

          <p className="text-center text-xs text-slate-500">
            © {new Date().getFullYear()} Agastya Associate · Udaipur, Rajasthan
          </p>
        </div>
      </div>
    </div>
  );
}
