import { Link } from "react-router-dom";
import { useDocumentTitle } from "../lib/useDocumentTitle";

// 404 — shown for any unknown URL (typed path, stale bookmark). Kept in the
// app's black/white/grey palette (no accent, no dark mode) and self-contained so
// it renders correctly both inside the app shell and standalone. The primary
// action takes the user back to the dashboard.
export default function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <div className="flex min-h-[70vh] w-full items-center justify-center px-6 py-16">
      <div className="w-full max-w-lg text-center">
        <p className="text-[7rem] font-black leading-none tracking-tight
          text-slate-900 sm:text-[9rem]">
          404
        </p>
        <div className="mx-auto -mt-2 h-px w-24 bg-slate-200" />
        <h1 className="mt-6 text-page-title text-slate-900">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          The page you're looking for doesn't exist or may have been moved.
          Let's get you back on track.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link to="/dashboard" className="btn-primary">
            Back to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
