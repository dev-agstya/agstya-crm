import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useAuth } from '../store/auth';
import { PageHeader } from "../components/PageHeader";

import enOwner from '../docs/help/en/owner.md?raw';
import hiOwner from '../docs/help/hi/owner.md?raw';
import enEmployee from '../docs/help/en/employee.md?raw';
import hiEmployee from '../docs/help/hi/employee.md?raw';
import enPartner from '../docs/help/en/channel_partner.md?raw';
import hiPartner from '../docs/help/hi/channel_partner.md?raw';

const docs = {
  en: {
    owner: enOwner,
    employee: enEmployee,
    channel_partner: enPartner,
  },
  hi: {
    owner: hiOwner,
    employee: hiEmployee,
    channel_partner: hiPartner,
  }
};

export default function HelpPage() {
  const { user } = useAuth();
  const [lang, setLang] = useState<'en' | 'hi'>('en');

  const role = user?.account_type || 'employee';
  const content = (docs[lang] as any)[role] || docs.en.employee;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <PageHeader title="Help Center" />
        <select 
          value={lang} 
          onChange={(e) => setLang(e.target.value as 'en' | 'hi')}
          className="border border-slate-300 rounded p-2 text-sm bg-white outline-none focus:border-line focus:ring-1 focus:ring-line"
        >
          <option value="en">English</option>
          <option value="hi">Hindi</option>
        </select>
      </div>
      
      <div className="bg-white p-6 rounded-card shadow-sm border border-line">
        <ReactMarkdown
          components={{
            h1: ({node, ...props}) => <h1 className="text-page-title font-bold mb-4 text-slate-900" {...props} />,
            h2: ({node, ...props}) => <h2 className="text-section font-semibold mt-6 mb-3 text-slate-800" {...props} />,
            p: ({node, ...props}) => <p className="mb-4 text-slate-600 leading-relaxed" {...props} />,
            ul: ({node, ...props}) => <ul className="list-disc pl-5 mb-4 space-y-1 text-slate-600" {...props} />,
            ol: ({node, ...props}) => <ol className="list-decimal pl-5 mb-4 space-y-1 text-slate-600" {...props} />,
            li: ({node, ...props}) => <li {...props} />,
            strong: ({node, ...props}) => <strong className="font-semibold text-slate-900" {...props} />,
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
