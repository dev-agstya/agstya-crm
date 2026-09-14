// Lightweight inline SVG icon set (stroke-based, currentColor). No icon library.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 20, children, ...props }: IconProps & {
  children: React.ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  Dashboard: (p: IconProps) => (
    <Base {...p}>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </Base>
  ),
  Users: (p: IconProps) => (
    <Base {...p}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.5M17 20a6 6 0 0 0-3-5.2" />
    </Base>
  ),
  Customers: (p: IconProps) => (
    <Base {...p}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </Base>
  ),
  Policy: (p: IconProps) => (
    <Base {...p}>
      <path d="M6 2h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
      <path d="M14 2v5h5M9 13h6M9 17h6M9 9h2" />
    </Base>
  ),
  Lead: (p: IconProps) => (
    // Sales funnel — the classic lead-pipeline symbol.
    <Base {...p}>
      <path d="M3 5h18l-7 8v6l-4 2v-8L3 5z" />
    </Base>
  ),
  Insurer: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 21h18M5 21V8l7-4 7 4v13M9 21v-6h6v6" />
    </Base>
  ),
  Money: (p: IconProps) => (
    <Base {...p}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </Base>
  ),
  Wallet: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1H5a2 2 0 0 0-2 2" />
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M16 13h.01" />
    </Base>
  ),
  Audit: (p: IconProps) => (
    <Base {...p}>
      <path d="M9 3h6l1 3H8l1-3zM6 6h12v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6z" />
      <path d="M9 11h6M9 15h4" />
    </Base>
  ),
  Settings: (p: IconProps) => (
    // Cog / gear — the conventional settings glyph.
    <Base {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Base>
  ),
  Report: (p: IconProps) => (
    <Base {...p}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </Base>
  ),
  Plus: (p: IconProps) => (
    <Base {...p}><path d="M12 5v14M5 12h14" /></Base>
  ),
  Search: (p: IconProps) => (
    <Base {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></Base>
  ),
  Logout: (p: IconProps) => (
    <Base {...p}>
      <path d="M15 3h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-3M10 17l-5-5 5-5M15 12H5" />
    </Base>
  ),
  Bell: (p: IconProps) => (
    <Base {...p}>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6zM10 19a2 2 0 0 0 4 0" />
    </Base>
  ),
  Check: (p: IconProps) => (
    <Base {...p}><path d="M5 12l5 5L20 6" /></Base>
  ),
  Copy: (p: IconProps) => (
    <Base {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </Base>
  ),
  X: (p: IconProps) => (
    <Base {...p}><path d="M6 6l12 12M18 6L6 18" /></Base>
  ),
  Menu: (p: IconProps) => (
    <Base {...p}><path d="M4 6h16M4 12h16M4 18h16" /></Base>
  ),
  ChevronDown: (p: IconProps) => (
    <Base {...p}><path d="M6 9l6 6 6-6" /></Base>
  ),
  ChevronRight: (p: IconProps) => (
    <Base {...p}><path d="M9 6l6 6-6 6" /></Base>
  ),
  ChevronLeft: (p: IconProps) => (
    <Base {...p}><path d="M15 6l-6 6 6 6" /></Base>
  ),
  Sun: (p: IconProps) => (
    <Base {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Base>
  ),
  Moon: (p: IconProps) => (
    <Base {...p}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </Base>
  ),
  Download: (p: IconProps) => (
    <Base {...p}><path d="M12 3v12m-5-5l5 5 5-5M5 21h14" /></Base>
  ),
  Shield: (p: IconProps) => (
    <Base {...p}>
      <path d="M12 3l8 4v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V7l8-4z" />
      <path d="M9 12l2 2 4-4" />
    </Base>
  ),
  Eye: (p: IconProps) => (
    <Base {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </Base>
  ),
  Edit: (p: IconProps) => (
    <Base {...p}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </Base>
  ),
  Upload: (p: IconProps) => (
    <Base {...p}>
      <path d="M12 15V3m-4 4l4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </Base>
  ),
  Filter: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z" />
    </Base>
  ),
  Help: (p: IconProps) => (
    <Base {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3" />
      <path d="M12 17h.01" />
    </Base>
  ),
  Trash: (p: IconProps) => (
    <Base {...p}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m1 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7" />
      <path d="M10 11v5M14 11v5" />
    </Base>
  ),
  Refresh: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 12a9 9 0 0 1 15.5-6.3M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3M3 21v-5h5" />
    </Base>
  ),
  Trend: (p: IconProps) => (
    // Trending-up line with an arrow head — growth / analytics.
    <Base {...p}>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M17 7h4v4" />
    </Base>
  ),
  CheckSquare: (p: IconProps) => (
    <Base {...p}>
      <path d="M9 11l3 3 7-7" />
      <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
    </Base>
  ),
  Target: (p: IconProps) => (
    // Concentric rings — performance targets.
    <Base {...p}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" />
    </Base>
  ),
  Medal: (p: IconProps) => (
    // Ribbon + disc — leaderboard rank.
    <Base {...p}>
      <path d="M8 3l2.5 5M16 3l-2.5 5" />
      <circle cx="12" cy="14" r="6" />
      <path d="M12 11.5l1 2 2 .3-1.5 1.4.4 2.1-1.9-1-1.9 1 .4-2.1L9 13.8l2-.3z" />
    </Base>
  ),
  Clock: (p: IconProps) => (
    <Base {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Base>
  ),
  Receipt: (p: IconProps) => (
    <Base {...p}>
      <path d="M6 2h12v19l-3-1.8-3 1.8-3-1.8-3 1.8V2z" />
      <path d="M9 8h6M9 12h4" />
    </Base>
  ),
  Exchange: (p: IconProps) => (
    <Base {...p}>
      <path d="M4 9h16l-4-4M20 15H4l4 4" />
    </Base>
  ),
  Calendar: (p: IconProps) => (
    <Base {...p}>
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </Base>
  ),
  Folder: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </Base>
  ),
  Grid: (p: IconProps) => (
    <Base {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Base>
  ),
  Tag: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 11.5V4a1 1 0 0 1 1-1h7.5a1 1 0 0 1 .7.3l8 8a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-8-8a1 1 0 0 1-.3-.7z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </Base>
  ),
  Key: (p: IconProps) => (
    <Base {...p}>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3L20 3M16.5 6.5l2 2M13.5 9.5l2 2" />
    </Base>
  ),
  // Filled dots, not stroked r=1 circles: at 16px a stroked 1px circle renders
  // as three grey smudges. This is the row-overflow target on every ledger.
  More: (p: IconProps) => (
    <Base {...p} fill="currentColor" stroke="none">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </Base>
  ),
  User: (p: IconProps) => (
    <Base {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </Base>
  ),
  Bolt: (p: IconProps) => (
    <Base {...p}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </Base>
  ),
  Mail: (p: IconProps) => (
    <Base {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </Base>
  ),
  Archive: (p: IconProps) => (
    <Base {...p}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M9.5 12h5" />
    </Base>
  ),
  Lock: (p: IconProps) => (
    <Base {...p}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
      <path d="M12 15v2" />
    </Base>
  ),
  Alert: (p: IconProps) => (
    <Base {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.2v.3" />
    </Base>
  ),
  // Business / company — the third lead type.
  Building: (p: IconProps) => (
    <Base {...p}>
      <path d="M4 21V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15" />
      <path d="M15 10h4a1 1 0 0 1 1 1v10" />
      <path d="M3 21h18M7.5 9h3M7.5 13h3M7.5 17h3" />
    </Base>
  ),
  UserPlus: (p: IconProps) => (
    <Base {...p}>
      <circle cx="9.5" cy="8" r="3.5" />
      <path d="M3 20a6.5 6.5 0 0 1 13 0" />
      <path d="M18 8.5v5M20.5 11h-5" />
    </Base>
  ),
  // Location-based attendance (2026-08-21). A control is an icon, never a text
  // glyph — a glyph takes no size, no stroke weight and no hover state.
  MapPin: (p: IconProps) => (
    <Base {...p}>
      <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.5" />
    </Base>
  ),
  WhatsApp: ({ size = 20, ...props }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
      {...props}>
      <path d="M17.5 14.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.76-1.66-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51l-.57-.01c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.06 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.77-.72 2.02-1.42.25-.7.25-1.29.17-1.42-.07-.13-.27-.2-.57-.35zM12 2a10 10 0 0 0-8.6 15.06L2 22l5.05-1.32A10 10 0 1 0 12 2z" />
    </svg>
  ),
};
