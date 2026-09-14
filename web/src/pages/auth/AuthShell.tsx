import { ReactNode } from "react";
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
    <div className="flex min-h-screen bg-canvas">
      {/* Brand panel. Flat ink, not a gradient — the design system allows one
          dark surface and no gradients anywhere. */}
      <div className="relative hidden w-1/2 flex-col justify-between
        overflow-hidden bg-ink p-12 text-white lg:flex">
        <div className="flex items-center">
          <img
            src="/agastya_hindi_full_logo.png"
            alt="Agstya Associate"
            className="h-11 w-auto object-contain"
          />
        </div>
        <div>
          <h1 className="text-display">
            Daily operations,<br />beautifully organised.
          </h1>
          <p className="mt-4 max-w-md leading-relaxed text-white/60">
            All in one secure portal.
          </p>
        </div>
        <p className="text-secondary text-white/40">
          © {new Date().getFullYear()} Agstya Associate · Secure agency portal
        </p>
        {/* Two faint discs for depth. Kept very low contrast so they read as
            texture rather than as decoration competing with the type. */}
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64
          rounded-full bg-white/[0.06]" />
        <div className="pointer-events-none absolute -bottom-24 right-10 h-72
          w-72 rounded-full bg-white/[0.04]" />
      </div>

      {/* Form panel */}
      <div className="flex w-full items-center justify-center p-6 lg:w-1/2">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center lg:hidden">
            <img
              src="/agastya_hindi_full_logo.png"
              alt="Agstya Associate"
              className="h-9 w-auto object-contain"
            />
          </div>
          <h2 className="text-page-title text-slate-900">{title}</h2>
          {subtitle && (
            <p className="mt-1.5 text-sm leading-relaxed text-slate-500">
              {subtitle}</p>
          )}
          <div className="mt-8">{children}</div>
        </div>
      </div>
    </div>
  );
}
