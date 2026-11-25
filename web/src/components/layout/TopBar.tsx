import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronRight,
  HelpCircle,
  Lock,
  LogOut,
  Menu,
  Settings,
  User,
} from "lucide-react";
import { useAuth } from "../../store/auth";
import { NotificationBell } from "../notifications/NotificationBell";
import { TopBarSearch } from "./TopBarSearch";
import { initials } from "../../lib/format";
import { HELP_ITEMS, crumbsForPath } from "../../lib/access";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "../Toast";

export { SEARCH_SHORTCUT } from "./TopBarSearch";

export function TopBar({ onOpenNav }: { onOpenNav: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const crumbs = crumbsForPath(location.pathname);
  const isPartner = user?.account_type === "channel_partner";

  const doLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <header className="sticky top-0 z-nav flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:px-6">
      {/* Mobile drawer toggle */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onOpenNav}
        aria-label="Open menu"
        className="shrink-0 lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* Breadcrumbs (desktop) */}
      <nav aria-label="Breadcrumb" className="hidden min-w-0 lg:block">
        <ol className="flex items-center gap-1.5 text-sm">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li
                key={`${c.label}-${i}`}
                className="flex min-w-0 items-center gap-1.5"
              >
                {i > 0 && (
                  <ChevronRight
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                {c.to && !last ? (
                  <Link
                    to={c.to}
                    className="truncate text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span
                    className={`truncate ${
                      last
                        ? "font-semibold text-foreground"
                        : "text-muted-foreground"
                    }`}
                    aria-current={last ? "page" : undefined}
                  >
                    {c.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Center search */}
      <div className="flex flex-1 justify-end sm:justify-center">
        <TopBarSearch />
      </div>

      {/* Right actions */}
      <div className="flex shrink-0 items-center gap-2">
        <NotificationBell />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="flex h-9 items-center gap-2 rounded-full px-2 hover:bg-muted"
            >
              <Avatar className="h-7 w-7">
                <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                  {initials(user?.full_name || user?.email || "U")}
                </AvatarFallback>
              </Avatar>
              <span className="hidden max-w-[140px] truncate text-sm font-medium text-foreground sm:inline">
                {user?.full_name || user?.email}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="truncate text-sm font-semibold leading-none">
                  {user?.full_name}
                </p>
                <p className="truncate text-xs leading-none text-muted-foreground">
                  {user?.email}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate("/settings")}>
              <Settings className="mr-2 h-4 w-4" />
              <span>Settings</span>
            </DropdownMenuItem>
            {isPartner && (
              <DropdownMenuItem onClick={() => navigate("/settings/profile")}>
                <User className="mr-2 h-4 w-4" />
                <span>My Profile</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {HELP_ITEMS.map((item) => (
              <DropdownMenuItem
                key={item.to}
                onClick={() => {
                  if (item.locked) {
                    toast.info(`${item.label} is coming soon.`);
                  } else {
                    navigate(item.to);
                  }
                }}
                className={item.locked ? "text-muted-foreground" : ""}
              >
                {item.locked ? (
                  <Lock className="mr-2 h-4 w-4 opacity-60" />
                ) : (
                  <HelpCircle className="mr-2 h-4 w-4" />
                )}
                <span>{item.label}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={doLogout}
              className="text-destructive focus:text-destructive"
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>Sign out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
