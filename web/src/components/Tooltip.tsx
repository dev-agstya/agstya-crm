import { useState, useRef, useEffect, useId, type ReactNode } from "react";
import { Icon } from "./Icon";

export interface TooltipProps {
  content: ReactNode;
  children?: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  triggerClassName?: string;
}

export function Tooltip({
  content,
  children,
  side = "top",
  className = "",
  triggerClassName = "",
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const tooltipId = useId();

  useEffect(() => {
    if (!open) return;
    const handleDown = (e: MouseEvent | TouchEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        contentRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("touchstart", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("touchstart", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  if (!content) return <>{children}</>;

  const sideClasses = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
    left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  }[side];

  return (
    <span className={`relative inline-flex items-center align-middle ${className}`}>
      {children ? (
        <button
          ref={triggerRef}
          type="button"
          aria-describedby={open ? tooltipId : undefined}
          className={`inline-flex items-center text-inherit bg-transparent border-0 p-0 m-0 cursor-pointer ${triggerClassName}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          {children}
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-describedby={open ? tooltipId : undefined}
          aria-label="More information"
          className={`inline-flex items-center justify-center p-0.5 text-slate-400 hover:text-slate-700 transition-colors rounded-full focus:outline-none focus:ring-1 focus:ring-brand-500 cursor-pointer ${triggerClassName}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          <Icon.Info size={13} />
        </button>
      )}

      {open && (
        <div
          ref={contentRef}
          id={tooltipId}
          role="tooltip"
          className={`absolute z-menu px-2.5 py-1.5 text-xs font-normal leading-snug text-white bg-slate-900 rounded-md shadow-lg min-w-[140px] max-w-[280px] pointer-events-auto transition-opacity animate-in fade-in duration-150 ${sideClasses}`}
        >
          {content}
        </div>
      )}
    </span>
  );
}

export function InfoTooltip({ text, side = "top" }: { text: string; side?: "top" | "bottom" | "left" | "right" }) {
  if (!text) return null;
  return <Tooltip content={text} side={side} />;
}
