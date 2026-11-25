import { create } from "zustand";
import { useEffect, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  prompt?: {
    label: string;
    placeholder?: string;
    minLength?: number;
  };
}

export interface PromptOptions extends Omit<ConfirmOptions, "prompt"> {
  label: string;
  placeholder?: string;
  minLength?: number;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (value: boolean | string) => void;
}

interface ConfirmState {
  current: ConfirmRequest | null;
  open: (opts: ConfirmOptions, resolve: (v: boolean | string) => void) => void;
  settle: (value: boolean | string) => void;
}

let counter = 0;

const useConfirm = create<ConfirmState>((set, get) => ({
  current: null,
  open: (opts, resolve) =>
    set({ current: { ...opts, id: ++counter, resolve } }),
  settle: (value) => {
    const cur = get().current;
    if (cur) cur.resolve(value);
    set({ current: null });
  },
}));

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) =>
    useConfirm.getState().open(opts, (v) => resolve(v === true))
  );
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  const { label, placeholder, minLength, ...rest } = opts;
  return new Promise((resolve) =>
    useConfirm
      .getState()
      .open({ ...rest, prompt: { label, placeholder, minLength } }, (v) =>
        resolve(typeof v === "string" ? v : null)
      )
  );
}

export function ConfirmHost() {
  const { current, settle } = useConfirm();
  const [text, setText] = useState("");

  const prompt = current?.prompt;
  const min = prompt?.minLength ?? 3;
  const ready = !prompt || text.trim().length >= min;

  useEffect(() => {
    if (current) setText("");
  }, [current]);

  const danger = !!current?.danger;

  return (
    <Dialog
      open={!!current}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="flex flex-row items-start gap-3 text-left">
          <div
            className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
              danger
                ? "bg-destructive/10 text-destructive"
                : "bg-primary/10 text-primary"
            }`}
          >
            {danger ? (
              <AlertTriangle className="h-5 w-5" />
            ) : (
              <ShieldCheck className="h-5 w-5" />
            )}
          </div>
          <div className="space-y-1">
            <DialogTitle>
              {current?.title || (danger ? "Are you sure?" : "Please confirm")}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {current?.message}
            </DialogDescription>
          </div>
        </DialogHeader>

        {prompt && (
          <div className="space-y-1.5 pt-2">
            <Label htmlFor="confirm-prompt-input">{prompt.label}</Label>
            <Input
              id="confirm-prompt-input"
              autoFocus
              value={text}
              placeholder={prompt.placeholder}
              maxLength={300}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ready) {
                  e.preventDefault();
                  settle(text.trim());
                }
              }}
            />
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={() => settle(false)}>
            {current?.cancelLabel || "Cancel"}
          </Button>
          <Button
            type="button"
            variant={danger ? "destructive" : "default"}
            disabled={!ready}
            onClick={() => settle(prompt ? text.trim() : true)}
          >
            {current?.confirmLabel || (danger ? "Delete" : "Confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
