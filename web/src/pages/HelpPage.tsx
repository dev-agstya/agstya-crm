import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";

// A help topic card. Some topics are live; others are placeholders we fill in
// as the relevant feature ships (e.g. the Error Log Guide).
function Topic({ icon, title, children, comingSoon }: {
  icon: keyof typeof Icon; title: string;
  children: React.ReactNode; comingSoon?: boolean;
}) {
  const Ico = Icon[icon];
  return (
    <div className="card card-body">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-control bg-slate-100 p-2 text-slate-900"><Ico size={18} /></span>
        <h3 className="text-sm font-semibold text-slate-800">
          {title}</h3>
        {comingSoon && (
          <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs
            font-medium text-slate-500">Coming soon</span>
        )}
      </div>
      <div className="text-sm text-slate-500">{children}</div>
    </div>
  );
}

export default function HelpPage() {
  return (
    <div>
      <PageHeader title="Help Center" />

      <div className="grid gap-4 md:grid-cols-2">
        <Topic icon="Shield" title="Error Log Guide" comingSoon>
          When something goes wrong the app shows a reference code like
          <span className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono
            text-xs">ERR-3F9A2C</span>.
          This guide will explain what each error means and what to do next —
          we'll fill it in shortly. For now, quote the reference code to support
          and the full details are safely recorded for the team.
        </Topic>

        <Topic icon="Help" title="Getting started">
          Overview of the portal: navigating the sidebar, roles &amp;
          permissions, and where to find leads, policies and finance.
        </Topic>

        <Topic icon="Receipt" title="Finance &amp; reports">
          How premium, rewards and the balance sheet are
          calculated, and how to read the Reports dashboards.
        </Topic>

        <Topic icon="Users" title="Managing people">
          Adding employees and channel partners, assigning roles, and
          resetting access.
        </Topic>
      </div>

      <p className="mt-6 text-center text-sm text-slate-500">
        Need a hand? Reach support from the user menu — more guides are on the
        way.
      </p>
    </div>
  );
}
