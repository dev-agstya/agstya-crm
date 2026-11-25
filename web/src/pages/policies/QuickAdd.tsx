import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { customersApi, usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormField } from "../../components/shared/FormSection";
import { toast } from "../../components/Toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function AddCustomerModal({
  partnerId,
  initial,
  onClose,
  onCreated,
}: {
  partnerId?: string;
  initial?: { name?: string; mobile?: string; email?: string };
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}) {
  const [f, setF] = useState({
    name: initial?.name ?? "",
    mobile: initial?.mobile ?? "",
    email: initial?.email ?? "",
  });
  const set = (k: keyof typeof f, v: string) =>
    setF((s) => ({ ...s, [k]: v }));
  const valid =
    f.name.trim().length >= 2 &&
    (f.mobile.trim().length === 0 || f.mobile.trim().length === 10);

  const create = useMutation({
    mutationFn: () =>
      customersApi.create({
        name: f.name.trim(),
        mobile: f.mobile.trim() || null,
        email: f.email.trim() || null,
        partner_id: partnerId || null,
      }),
    onSuccess: (res) => {
      toast.success("Customer added.");
      onCreated(res.data.id, res.data.name);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add New Customer</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) create.mutate();
          }}
        >
          <FormField label="Full name" required>
            <Input
              value={f.name}
              required
              autoFocus
              onChange={(e) => set("name", e.target.value)}
            />
          </FormField>
          <FormField
            label="Mobile number (optional)"
            hint="Optional. 10 digits without +91"
          >
            <div className="flex">
              <span className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-2.5 text-xs text-muted-foreground">
                +91
              </span>
              <Input
                className="rounded-l-none"
                value={f.mobile}
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit number"
                onChange={(e) =>
                  set("mobile", e.target.value.replace(/\D/g, ""))
                }
              />
            </div>
          </FormField>
          <FormField label="Email">
            <Input
              type="email"
              value={f.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!valid || create.isPending}
            >
              {create.isPending ? "Saving…" : "Save & continue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AddPartnerQuickModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [f, setF] = useState({
    full_name: "",
    mobile: "",
    email: "",
    relationship_manager_id: "",
  });
  const set = (k: keyof typeof f, v: string) =>
    setF((s) => ({ ...s, [k]: v }));
  const managers = useQuery({
    queryKey: ["assignable-managers"],
    queryFn: async () => (await usersApi.assignableManagers()).data,
  });
  useEffect(() => {
    if (!f.relationship_manager_id && (managers.data?.length ?? 0) > 0)
      set("relationship_manager_id", managers.data![0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managers.data]);

  const valid =
    f.full_name.trim().length >= 2 &&
    f.mobile.trim().length === 10 &&
    /^\S+@\S+\.\S+$/.test(f.email) &&
    !!f.relationship_manager_id;

  const create = useMutation({
    mutationFn: () =>
      usersApi.createPartner({
        full_name: f.full_name.trim(),
        email: f.email.trim(),
        mobile: f.mobile.trim(),
        relationship_manager_id: f.relationship_manager_id,
      }),
    onSuccess: (res) => {
      toast.success("Channel Partner added. Sign-in details emailed to them.");
      onCreated(res.data.id);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Channel Partner</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) create.mutate();
          }}
        >
          <FormField label="Full name" required>
            <Input
              value={f.full_name}
              required
              autoFocus
              onChange={(e) => set("full_name", e.target.value)}
            />
          </FormField>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Mobile" required>
              <div className="flex">
                <span className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-2.5 text-xs text-muted-foreground">
                  +91
                </span>
                <Input
                  className="rounded-l-none"
                  value={f.mobile}
                  required
                  inputMode="numeric"
                  maxLength={10}
                  placeholder="10-digit number"
                  onChange={(e) =>
                    set("mobile", e.target.value.replace(/\D/g, ""))
                  }
                />
              </div>
            </FormField>
            <FormField label="Email" required>
              <Input
                type="email"
                value={f.email}
                required
                onChange={(e) => set("email", e.target.value)}
              />
            </FormField>
          </div>
          <FormField label="Relationship manager" required>
            <Select
              value={f.relationship_manager_id}
              onValueChange={(v) => set("relationship_manager_id", v)}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="— Select —" />
              </SelectTrigger>
              <SelectContent>
                {managers.data?.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!valid || create.isPending}
            >
              {create.isPending ? "Saving…" : "Save & select"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
