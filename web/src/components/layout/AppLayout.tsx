import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Lock,
} from "lucide-react";
import { useAuth } from "../../store/auth";
import { Icon } from "../Icon";
import { TopBar } from "./TopBar";
import { NAV, canAccess } from "../../lib/access";
import type { Gate, NavItem } from "../../lib/access";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { toast } from "../Toast";

export { SEARCH_SHORTCUT } from "./TopBar";

interface NavSectionData {
  title: string;
  items: NavItem[];
}

function SidebarNav({
  isRail = false,
  sections,
  pathname,
  expanded,
  onToggleExpand,
  onToggleCollapsed,
}: {
  isRail?: boolean;
  sections: NavSectionData[];
  pathname: string;
  expanded: Record<string, boolean>;
  onToggleExpand: (label: string, current: boolean) => void;
  onToggleCollapsed: () => void;
}) {
  const isActive = (to: string) => {
    const clean = to.split("?")[0];
    if (clean === "/dashboard") return pathname === "/dashboard";
    return pathname === clean || pathname.startsWith(clean + "/");
  };

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Brand header */}
      <div
        className={`flex h-12 shrink-0 items-center border-b border-border px-4 ${
          isRail ? "justify-center px-2" : "justify-between"
        }`}
      >
        <Link to="/dashboard" className="flex items-center gap-2.5 min-w-0">
          <img
            src="/agastya_hindi_half_logo.png"
            alt="Agastya"
            className="h-8 w-8 shrink-0 rounded-md object-contain"
          />
          {!isRail && (
            <span className="truncate text-base font-bold tracking-tight text-foreground">
              Agastya CRM
            </span>
          )}
        </Link>
      </div>

      {/* Navigation — stays mounted across route changes so scroll position is preserved */}
      <nav
        aria-label="Primary"
        className="flex-1 space-y-5 overflow-y-auto px-3 py-4"
      >
        {sections.map((section) => (
          <div key={section.title} className="space-y-1">
            {!isRail && (
              <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </p>
            )}
            {section.items.map((item) => {
              const IconComp = Icon[item.icon];
              const hasChildren = !!item.children?.length;
              const childActive =
                hasChildren && item.children!.some((c) => isActive(c.to));
              const active = isActive(item.to) || childActive;
              const isExpanded =
                expanded[item.label] ?? (childActive && !isRail);

              if (item.locked) {
                return (
                  <button
                    key={item.to}
                    type="button"
                    title={isRail ? `${item.label} (Coming soon)` : undefined}
                    onClick={() =>
                      toast.info(
                        `${item.label} isn't available yet — coming soon.`
                      )
                    }
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground/60 transition-colors hover:bg-muted/50 ${
                      isRail ? "justify-center px-0" : ""
                    }`}
                  >
                    <IconComp size={18} className="shrink-0" />
                    {!isRail && (
                      <>
                        <span className="flex-1 truncate text-left">
                          {item.label}
                        </span>
                        <Lock className="h-3.5 w-3.5 shrink-0 opacity-60" />
                      </>
                    )}
                  </button>
                );
              }

              if (hasChildren && !isRail) {
                return (
                  <div key={item.label} className="space-y-0.5">
                    <button
                      type="button"
                      onClick={() => onToggleExpand(item.label, isExpanded)}
                      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors ${
                        active
                          ? "bg-primary/10 text-primary"
                          : "text-foreground/80 hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      <IconComp size={18} className="shrink-0" />
                      <span className="flex-1 truncate text-left">
                        {item.label}
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 transition-transform ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                    {isExpanded && (
                      <div className="ml-4 space-y-0.5 border-l border-border pl-3 pt-0.5">
                        {item.children!.map((child) => {
                          if (child.locked) {
                            return (
                              <button
                                key={child.to}
                                type="button"
                                onClick={() =>
                                  toast.info(
                                    `${child.label} isn't available yet — coming soon.`
                                  )
                                }
                                className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs text-muted-foreground/60 hover:bg-muted/50"
                              >
                                <span className="truncate">{child.label}</span>
                                <Lock className="h-3 w-3 shrink-0 opacity-60" />
                              </button>
                            );
                          }
                          const cActive = isActive(child.to);
                          return (
                            <Link
                              key={child.to}
                              to={child.to}
                              className={`block truncate rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                                cActive
                                  ? "bg-primary/10 font-medium text-primary"
                                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
                              }`}
                            >
                              {child.label}
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <Link
                  key={item.to}
                  to={item.to}
                  title={isRail ? item.label : undefined}
                  className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors ${
                    isRail ? "justify-center px-0" : ""
                  } ${
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-foreground/80 hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <IconComp size={18} className="shrink-0" />
                  {!isRail && <span className="truncate">{item.label}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Collapse toggle (desktop only) */}
      <div className="hidden border-t border-border p-2 lg:block">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onToggleCollapsed}
          className={`w-full text-muted-foreground hover:text-foreground ${
            isRail ? "justify-center px-0" : "justify-start gap-2"
          }`}
          aria-label={isRail ? "Expand sidebar" : "Collapse sidebar"}
        >
          {isRail ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4" />
              <span className="text-xs">Collapse menu</span>
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

export function AppLayout() {
  const { user, has } = useAuth();
  const location = useLocation();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("crm.sidebar.collapsed") === "1"
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname, location.search]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("crm.sidebar.collapsed", next ? "1" : "0");
      return next;
    });
  };

  const toggleExpand = (label: string, current: boolean) => {
    setExpanded((prev) => ({
      ...prev,
      [label]: !current,
    }));
  };

  const canSee = (g: Gate): boolean =>
    canAccess(g, user?.account_type, has);

  const sections: NavSectionData[] = NAV.map((s) => ({
    title: s.title,
    items: s.items
      .filter(canSee)
      .map((item) => {
        if (!item.children) return item;
        const children = item.children.filter(canSee);
        return children.length > 0 ? { ...item, children } : null;
      })
      .filter(Boolean) as NavItem[],
  })).filter((s) => s.items.length > 0);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside
        className={`hidden shrink-0 border-r border-border bg-card transition-[width] duration-200 lg:block ${
          collapsed ? "w-[72px]" : "w-64"
        }`}
      >
        <div className="sticky top-0 h-screen">
          <SidebarNav
            isRail={collapsed}
            sections={sections}
            pathname={location.pathname}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            onToggleCollapsed={toggleCollapsed}
          />
        </div>
      </aside>

      {/* Mobile drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Navigation menu</SheetTitle>
          <SidebarNav
            isRail={false}
            sections={sections}
            pathname={location.pathname}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            onToggleCollapsed={toggleCollapsed}
          />
        </SheetContent>
      </Sheet>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
        <TopBar onOpenNav={() => setMobileOpen(true)} />
        <main className="w-full max-w-[1440px] flex-1 px-4 py-3 sm:px-5 lg:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
