import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { useAuth } from "../store/auth";
import { PageHeader } from "../components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import enOwner from "../docs/help/en/owner.md?raw";
import hiOwner from "../docs/help/hi/owner.md?raw";
import enEmployee from "../docs/help/en/employee.md?raw";
import hiEmployee from "../docs/help/hi/employee.md?raw";
import enPartner from "../docs/help/en/channel_partner.md?raw";
import hiPartner from "../docs/help/hi/channel_partner.md?raw";

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
  },
};

export default function HelpPage() {
  const { user } = useAuth();
  const [lang, setLang] = useState<"en" | "hi">("en");

  const role = user?.account_type || "employee";
  const content = (docs[lang] as any)[role] || docs.en.employee;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Help Center"
        subtitle="Step-by-step guide for your role"
        actions={
          <Select
            value={lang}
            onValueChange={(v) => setLang(v as "en" | "hi")}
          >
            <SelectTrigger className="h-8 w-[120px] bg-card text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="hi">Hindi (हिन्दी)</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      <Card>
        <CardContent className="p-5 sm:p-6">
          <ReactMarkdown
            components={{
              h1: ({ node: _n, ...props }) => (
                <h1
                  className="mb-3 text-lg font-bold tracking-tight text-foreground"
                  {...props}
                />
              ),
              h2: ({ node: _n, ...props }) => (
                <h2
                  className="mb-2 mt-5 text-sm font-semibold text-foreground"
                  {...props}
                />
              ),
              p: ({ node: _n, ...props }) => (
                <p
                  className="mb-3 text-sm leading-relaxed text-muted-foreground"
                  {...props}
                />
              ),
              ul: ({ node: _n, ...props }) => (
                <ul
                  className="mb-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground"
                  {...props}
                />
              ),
              ol: ({ node: _n, ...props }) => (
                <ol
                  className="mb-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground"
                  {...props}
                />
              ),
              li: ({ node: _n, ...props }) => <li {...props} />,
              strong: ({ node: _n, ...props }) => (
                <strong className="font-semibold text-foreground" {...props} />
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        </CardContent>
      </Card>
    </div>
  );
}
