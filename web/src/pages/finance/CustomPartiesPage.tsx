import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowDownLeft,
  ArrowUpRight,
  Loader2,
  MessageCircle,
  Pencil,
  Plus,
  Receipt,
  Search,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import { customPartiesApi, banksApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/shared/EmptyState";
import { FormField } from "../../components/shared/FormSection";
import { InfoTooltip } from "../../components/shared/InfoTooltip";
import { DateInput } from "../../components/DateInput";
import { confirmDialog } from "../../components/Confirm";
import { toast } from "../../components/Toast";
import {
  formatINR,
  formatDate,
  formatDateTime,
  initials,
} from "../../lib/format";
import { liveQueryOptions } from "../../lib/live";
import type {
  CustomParty,
  CustomTransaction,
  BankAccount,
} from "../../lib/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const CATEGORIES: { value: string; label: string }[] = [
  { value: "personal", label: "Personal / Friends" },
  { value: "vendor", label: "Vendor / Supplier" },
  { value: "loan", label: "Loan / Borrowing" },
  { value: "landlord", label: "Office / Rent" },
  { value: "other", label: "Other Party" },
];

function categoryLabel(cat: string): string {
  const found = CATEGORIES.find((c) => c.value === cat);
  return found ? found.label : cat || "General";
}

export default function CustomPartiesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(() =>
    searchParams.get("id")
  );
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const [partyModalOpen, setPartyModalOpen] = useState(false);
  const [editingParty, setEditingParty] = useState<CustomParty | null>(null);

  const [txnModalOpen, setTxnModalOpen] = useState(false);
  const [txnDirection, setTxnDirection] = useState<"gave" | "got">("gave");

  const overviewQuery = useQuery({
    queryKey: ["finance", "custom-parties", search, categoryFilter],
    queryFn: async () => {
      const res = await customPartiesApi.list({
        q: search.trim() || undefined,
        category: categoryFilter !== "all" ? categoryFilter : undefined,
      });
      return res.data;
    },
    ...liveQueryOptions,
  });

  const parties = overviewQuery.data?.parties ?? [];

  const banksQuery = useQuery({
    queryKey: ["finance", "bank-accounts-active"],
    queryFn: async () => {
      const res = await banksApi.list({ include_inactive: false });
      return res.data?.items ?? [];
    },
    staleTime: 60_000,
  });
  const bankAccounts: BankAccount[] = banksQuery.data ?? [];

  useEffect(() => {
    if (parties.length > 0) {
      if (!selectedId || !parties.some((p) => p.id === selectedId)) {
        const nextId = parties[0].id;
        setSelectedId(nextId);
        setSearchParams(
          (prev) => {
            const p = new URLSearchParams(prev);
            p.set("id", nextId);
            return p;
          },
          { replace: true }
        );
      }
    } else {
      setSelectedId(null);
    }
  }, [parties, selectedId, setSearchParams]);

  useEffect(() => {
    if (searchParams.get("action") === "pay" && selectedId) {
      setTxnDirection("gave");
      setTxnModalOpen(true);
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.delete("action");
          return p;
        },
        { replace: true }
      );
    }
  }, [searchParams, selectedId, setSearchParams]);

  const detailQuery = useQuery({
    queryKey: ["finance", "custom-party-detail", selectedId],
    queryFn: async () => {
      if (!selectedId) return null;
      const res = await customPartiesApi.get(selectedId);
      return res.data;
    },
    enabled: !!selectedId,
    ...liveQueryOptions,
  });

  const selectedParty = detailQuery.data?.party;
  const transactions = detailQuery.data?.transactions ?? [];

  const handleSelectParty = (id: string) => {
    setSelectedId(id);
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set("id", id);
      return p;
    });
  };

  const [formName, setFormName] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formCategory, setFormCategory] = useState("personal");
  const [formNotes, setFormNotes] = useState("");
  const [openingBalanceDirection, setOpeningBalanceDirection] = useState<
    "none" | "gave" | "got"
  >("none");
  const [openingBalanceRupees, setOpeningBalanceRupees] = useState("");
  const [openingBankId, setOpeningBankId] = useState("");

  const openAddPartyModal = () => {
    setEditingParty(null);
    setFormName("");
    setFormPhone("");
    setFormCategory("personal");
    setFormNotes("");
    setOpeningBalanceDirection("none");
    setOpeningBalanceRupees("");
    setOpeningBankId("");
    setPartyModalOpen(true);
  };

  const openEditPartyModal = (party: CustomParty) => {
    setEditingParty(party);
    setFormName(party.name);
    setFormPhone(party.phone || "");
    setFormCategory(party.category || "personal");
    setFormNotes(party.notes || "");
    setPartyModalOpen(true);
  };

  const savePartyMutation = useMutation({
    mutationFn: async () => {
      if (editingParty) {
        return (
          await customPartiesApi.update(editingParty.id, {
            name: formName.trim(),
            phone: formPhone.trim() || undefined,
            category: formCategory,
            notes: formNotes.trim() || undefined,
          })
        ).data;
      } else {
        const balNum = parseFloat(openingBalanceRupees || "0");
        let openingPaise = 0;
        if (openingBalanceDirection === "gave") {
          openingPaise = Math.round(balNum * 100);
        } else if (openingBalanceDirection === "got") {
          openingPaise = -Math.round(balNum * 100);
        }

        return (
          await customPartiesApi.create({
            name: formName.trim(),
            phone: formPhone.trim() || undefined,
            category: formCategory,
            notes: formNotes.trim() || undefined,
            opening_balance_paise: openingPaise,
            bank_account_id: openingBankId || undefined,
          })
        ).data;
      }
    },
    onSuccess: (saved) => {
      toast.success(
        editingParty
          ? "Party details updated."
          : "Party created successfully."
      );
      setPartyModalOpen(false);
      queryClient.invalidateQueries({
        queryKey: ["finance", "custom-parties"],
      });
      queryClient.invalidateQueries({
        queryKey: ["finance", "bank-accounts-active"],
      });
      queryClient.invalidateQueries({ queryKey: ["finance", "banks"] });
      if (saved?.id) {
        handleSelectParty(saved.id);
      }
    },
    onError: (err) => {
      toast.error(apiError(err));
    },
  });

  const archivePartyMutation = useMutation({
    mutationFn: async (partyId: string) => {
      return (await customPartiesApi.archive(partyId)).data;
    },
    onSuccess: () => {
      toast.success("Party archived.");
      queryClient.invalidateQueries({
        queryKey: ["finance", "custom-parties"],
      });
      setSelectedId(null);
    },
    onError: (err) => {
      toast.error(apiError(err));
    },
  });

  const handleArchiveParty = async (party: CustomParty) => {
    const ok = await confirmDialog({
      title: `Archive ${party.name}?`,
      message:
        "This party will be removed from your active Khata list. All historical bank transactions remain intact.",
      confirmLabel: "Archive",
      danger: true,
    });
    if (ok) {
      archivePartyMutation.mutate(party.id);
    }
  };

  const [txnRupees, setTxnRupees] = useState("");
  const [txnBankId, setTxnBankId] = useState("");
  const [txnDate, setTxnDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [txnNote, setTxnNote] = useState("");
  const [txnReference, setTxnReference] = useState("");

  const openRecordModal = (direction: "gave" | "got") => {
    setTxnDirection(direction);
    setTxnRupees("");
    setTxnBankId(bankAccounts.length > 0 ? bankAccounts[0].id : "");
    setTxnDate(new Date().toISOString().slice(0, 10));
    setTxnNote("");
    setTxnReference("");
    setTxnModalOpen(true);
  };

  const saveTxnMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId) throw new Error("No party selected.");
      const amtPaise = Math.round(parseFloat(txnRupees || "0") * 100);
      if (amtPaise <= 0)
        throw new Error("Please enter a valid amount greater than zero.");

      const isToday =
        !txnDate || txnDate === new Date().toISOString().slice(0, 10);
      const occurredIso = isToday
        ? new Date().toISOString()
        : new Date(`${txnDate}T12:00:00Z`).toISOString();

      return (
        await customPartiesApi.recordTxn(selectedId, {
          direction: txnDirection,
          amount_paise: amtPaise,
          bank_account_id: txnBankId || undefined,
          occurred_at: occurredIso,
          note: txnNote.trim() || undefined,
          reference: txnReference.trim() || undefined,
        })
      ).data;
    },
    onSuccess: () => {
      toast.success(
        txnDirection === "gave"
          ? "Payment (Outflow) logged."
          : "Receipt (Inflow) logged."
      );
      setTxnModalOpen(false);
      queryClient.invalidateQueries({
        queryKey: ["finance", "custom-parties"],
      });
      queryClient.invalidateQueries({
        queryKey: ["finance", "custom-party-detail", selectedId],
      });
      queryClient.invalidateQueries({
        queryKey: ["finance", "bank-accounts-active"],
      });
      queryClient.invalidateQueries({ queryKey: ["finance", "banks"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "balance-sheet"] });
    },
    onError: (err) => {
      toast.error(apiError(err));
    },
  });

  const deleteTxnMutation = useMutation({
    mutationFn: async (txnId: string) => {
      return (await customPartiesApi.deleteTxn(txnId)).data;
    },
    onSuccess: () => {
      toast.success("Transaction reversed and bank balance updated.");
      queryClient.invalidateQueries({
        queryKey: ["finance", "custom-parties"],
      });
      queryClient.invalidateQueries({
        queryKey: ["finance", "custom-party-detail", selectedId],
      });
      queryClient.invalidateQueries({
        queryKey: ["finance", "bank-accounts-active"],
      });
      queryClient.invalidateQueries({ queryKey: ["finance", "banks"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "balance-sheet"] });
    },
    onError: (err) => {
      toast.error(apiError(err));
    },
  });

  const handleDeleteTxn = async (txn: CustomTransaction) => {
    const ok = await confirmDialog({
      title: "Reverse Transaction?",
      message: `Delete this ${formatINR(
        txn.amount_paise
      )} transaction? This will automatically reverse its effect on your linked bank or cash account.`,
      confirmLabel: "Reverse Transaction",
      danger: true,
    });
    if (ok) {
      deleteTxnMutation.mutate(txn.id);
    }
  };

  const overview = overviewQuery.data;

  return (
    <div className="space-y-3">
      <PageHeader
        title="Khata (Custom Parties)"
        subtitle="Personal loans, friends, vendors, and non-policy cash movements."
        info="Every payment logged here stays matched with your Bank & Cash account balances."
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => navigate("/finance/balance-sheet")}
            >
              <Receipt className="mr-1.5 h-3.5 w-3.5" />
              Balance Sheet
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              onClick={openAddPartyModal}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add Party
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 divide-y divide-border rounded-lg border border-border bg-card sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <div className="px-3.5 py-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <span>You Will Get</span>
            <InfoTooltip content="Total outstanding amount that parties owe you from payments given or opening balances." />
          </div>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-emerald-700">
            {formatINR(overview?.total_you_will_get_paise)}
          </p>
        </div>
        <div className="px-3.5 py-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <span>You Will Give</span>
            <InfoTooltip content="Total outstanding amount you owe to parties from payments received or borrowing." />
          </div>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-destructive">
            {formatINR(overview?.total_you_will_give_paise)}
          </p>
        </div>
        <div className="px-3.5 py-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <span>Net Khata Balance</span>
            <InfoTooltip content="Overall difference between total receivables and total payables across all custom parties." />
          </div>
          <p
            className={`mt-0.5 text-lg font-semibold tabular-nums ${
              (overview?.net_balance_paise ?? 0) >= 0
                ? "text-emerald-700"
                : "text-destructive"
            }`}
          >
            {overview?.net_balance_paise != null
              ? formatINR(Math.abs(overview.net_balance_paise))
              : "—"}
          </p>
        </div>
        <div className="px-3.5 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            Active Parties
          </p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
            {overview?.total_parties ?? 0}
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
              friends, vendors &amp; loans
            </span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        <div className="space-y-3 lg:col-span-5">
          <Card className="space-y-2.5 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Parties Directory
              </h2>
              <span className="text-xs text-muted-foreground">
                {parties.length} parties
              </span>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or phone..."
                className="pl-8"
              />
            </div>

            <div className="flex flex-wrap gap-1 pt-0.5">
              <Button
                type="button"
                variant={categoryFilter === "all" ? "default" : "secondary"}
                size="sm"
                className="h-6 rounded-full px-2.5 text-[11px]"
                onClick={() => setCategoryFilter("all")}
              >
                All
              </Button>
              {CATEGORIES.map((cat) => (
                <Button
                  key={cat.value}
                  type="button"
                  variant={
                    categoryFilter === cat.value ? "default" : "secondary"
                  }
                  size="sm"
                  className="h-6 rounded-full px-2.5 text-[11px]"
                  onClick={() => setCategoryFilter(cat.value)}
                >
                  {cat.label}
                </Button>
              ))}
            </div>
          </Card>

          <div className="space-y-1.5">
            {overviewQuery.isLoading ? (
              <Card className="flex items-center justify-center p-6 text-xs text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading
                parties...
              </Card>
            ) : parties.length === 0 ? (
              <Card className="p-6">
                <EmptyState
                  icon={<Users className="h-5 w-5" />}
                  title="No parties found"
                  description={
                    search
                      ? "No parties match your search query."
                      : "Add your first custom party to start logging personal loans or vendor payments."
                  }
                  action={
                    <Button size="sm" onClick={openAddPartyModal}>
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add New Party
                    </Button>
                  }
                />
              </Card>
            ) : (
              parties.map((party) => {
                const isSelected = party.id === selectedId;
                const bal = party.balance_paise;
                const isGet = bal > 0;
                const isGive = bal < 0;

                return (
                  <button
                    key={party.id}
                    type="button"
                    onClick={() => handleSelectParty(party.id)}
                    className={`w-full rounded-lg border p-3 text-left transition ${
                      isSelected
                        ? "border-primary/50 bg-primary/5 shadow-sm"
                        : "border-border bg-card hover:bg-muted/30"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <Avatar className="h-8 w-8 shrink-0">
                          <AvatarFallback className="bg-primary/10 text-[11px] font-semibold text-primary">
                            {initials(party.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <h3 className="truncate text-[13px] font-semibold text-foreground">
                            {party.name}
                          </h3>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            {party.phone && <span>{party.phone}</span>}
                            <Badge
                              variant="secondary"
                              className="h-4 px-1.5 text-[10px]"
                            >
                              {categoryLabel(party.category)}
                            </Badge>
                          </div>
                        </div>
                      </div>

                      <div className="shrink-0 text-right">
                        {isGet ? (
                          <div className="rounded-md bg-emerald-50 px-2 py-0.5 text-right">
                            <span className="block text-[10px] font-medium text-emerald-700">
                              You will get
                            </span>
                            <span className="text-xs font-semibold tabular-nums text-emerald-700">
                              {formatINR(bal)}
                            </span>
                          </div>
                        ) : isGive ? (
                          <div className="rounded-md bg-red-50 px-2 py-0.5 text-right">
                            <span className="block text-[10px] font-medium text-destructive">
                              You will give
                            </span>
                            <span className="text-xs font-semibold tabular-nums text-destructive">
                              {formatINR(Math.abs(bal))}
                            </span>
                          </div>
                        ) : (
                          <div className="rounded-md bg-muted px-2 py-0.5 text-right">
                            <span className="block text-[10px] font-medium text-muted-foreground">
                              Settled
                            </span>
                            <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                              ₹0
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="space-y-3 lg:col-span-7">
          {!selectedParty ? (
            <Card className="flex flex-col items-center justify-center p-10 text-center">
              <EmptyState
                icon={<Users className="h-5 w-5" />}
                title="Select a Party"
                description="Click on any party from the directory on the left to view their detailed Khata ledger and log payments."
                action={
                  <Button size="sm" onClick={openAddPartyModal}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add New Party
                  </Button>
                }
              />
            </Card>
          ) : (
            <>
              <Card className="space-y-3.5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10 shrink-0">
                      <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                        {initials(selectedParty.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-bold text-foreground">
                          {selectedParty.name}
                        </h2>
                        <Badge
                          variant="secondary"
                          className="h-5 px-1.5 text-[11px]"
                        >
                          {categoryLabel(selectedParty.category)}
                        </Badge>
                      </div>
                      <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                        {selectedParty.phone && (
                          <span>{selectedParty.phone}</span>
                        )}
                        <span>
                          Added {formatDate(selectedParty.created_at)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {selectedParty.phone && (
                      <Button asChild variant="outline" size="sm" className="h-8 text-xs">
                        <a
                          href={`https://wa.me/91${selectedParty.phone.replace(
                            /\D/g,
                            ""
                          )}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Send WhatsApp message"
                        >
                          <MessageCircle className="mr-1.5 h-3.5 w-3.5" />
                          WhatsApp
                        </a>
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => openEditPartyModal(selectedParty)}
                    >
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => handleArchiveParty(selectedParty)}
                      title="Archive party"
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {selectedParty.notes && (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    <strong className="text-foreground">Notes:</strong>{" "}
                    {selectedParty.notes}
                  </div>
                )}

                <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Current Khata Balance
                      </span>
                      <div className="mt-0.5 flex items-baseline gap-2">
                        {selectedParty.balance_paise > 0 ? (
                          <>
                            <span className="text-2xl font-bold tabular-nums text-emerald-700">
                              {formatINR(selectedParty.balance_paise)}
                            </span>
                            <span className="text-xs font-semibold text-emerald-700">
                              (You will get)
                            </span>
                          </>
                        ) : selectedParty.balance_paise < 0 ? (
                          <>
                            <span className="text-2xl font-bold tabular-nums text-destructive">
                              {formatINR(Math.abs(selectedParty.balance_paise))}
                            </span>
                            <span className="text-xs font-semibold text-destructive">
                              (You will give)
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="text-2xl font-bold tabular-nums text-foreground">
                              ₹0
                            </span>
                            <span className="text-xs font-medium text-muted-foreground">
                              (Settled)
                            </span>
                          </>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Total Outflow Given:{" "}
                        {formatINR(selectedParty.total_charged_paise)} · Total
                        Inflow Received:{" "}
                        {formatINR(selectedParty.total_settled_paise)}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => navigate(`/finance/balance-sheet`)}
                      className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      <Receipt className="h-3.5 w-3.5" />
                      View in Balance Sheet
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <Button
                      type="button"
                      variant="destructive"
                      className="h-10 font-semibold"
                      onClick={() => openRecordModal("gave")}
                    >
                      <ArrowUpRight className="mr-1.5 h-4 w-4" />
                      You Gave ₹ (Outflow)
                    </Button>
                    <Button
                      type="button"
                      className="h-10 bg-emerald-600 font-semibold text-white hover:bg-emerald-700"
                      onClick={() => openRecordModal("got")}
                    >
                      <ArrowDownLeft className="mr-1.5 h-4 w-4" />
                      You Got ₹ (Inflow)
                    </Button>
                  </div>
                </div>
              </Card>

              <Card className="overflow-hidden">
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Receipt className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold text-foreground">
                      Ledger History
                    </h3>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {transactions.length}{" "}
                    {transactions.length === 1 ? "entry" : "entries"}
                  </span>
                </div>

                {detailQuery.isLoading ? (
                  <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading
                    ledger transactions...
                  </div>
                ) : transactions.length === 0 ? (
                  <div className="p-8 text-center">
                    <p className="text-sm font-medium text-foreground">
                      No transactions yet.
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Use the &quot;You Gave&quot; or &quot;You Got&quot;
                      buttons above to record your first transaction.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableHead className="h-9 text-xs">Date</TableHead>
                          <TableHead className="h-9 text-xs">
                            Details &amp; Account
                          </TableHead>
                          <TableHead className="h-9 text-right text-xs">
                            You Gave
                          </TableHead>
                          <TableHead className="h-9 text-right text-xs">
                            You Got
                          </TableHead>
                          <TableHead className="h-9 text-right text-xs">
                            Balance
                          </TableHead>
                          <TableHead className="h-9 w-12 text-right text-xs" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {transactions.map((txn) => {
                          const isGave = txn.direction === "gave";
                          const isGot = txn.direction === "got";

                          return (
                            <TableRow key={txn.id}>
                              <TableCell className="whitespace-nowrap py-2 align-top">
                                <span className="block text-xs font-medium text-foreground">
                                  {formatDate(txn.occurred_at)}
                                </span>
                                <span className="block text-[11px] text-muted-foreground">
                                  {formatDateTime(txn.occurred_at)
                                    .split(",")[1]
                                    ?.trim()}
                                </span>
                              </TableCell>
                              <TableCell className="py-2 align-top">
                                <span className="block text-xs font-medium text-foreground">
                                  {txn.note ||
                                    (isGave
                                      ? "Money paid out"
                                      : "Money received")}
                                </span>
                                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                                  {txn.bank_account_name ? (
                                    <span className="flex items-center gap-1 font-medium text-foreground">
                                      <Wallet className="h-3 w-3" />
                                      {txn.bank_account_name}
                                    </span>
                                  ) : (
                                    <span>Direct Ledger Entry</span>
                                  )}
                                  {txn.reference && (
                                    <Badge
                                      variant="secondary"
                                      className="h-4 px-1 text-[10px]"
                                    >
                                      Ref: {txn.reference}
                                    </Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="whitespace-nowrap py-2 text-right align-top">
                                {isGave ? (
                                  <span className="text-xs font-semibold tabular-nums text-destructive">
                                    {formatINR(txn.amount_paise)}
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    —
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="whitespace-nowrap py-2 text-right align-top">
                                {isGot ? (
                                  <span className="text-xs font-semibold tabular-nums text-emerald-700">
                                    {formatINR(txn.amount_paise)}
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    —
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="whitespace-nowrap py-2 text-right align-top">
                                <span
                                  className={`text-xs font-semibold tabular-nums ${
                                    txn.running_balance_paise > 0
                                      ? "text-emerald-700"
                                      : txn.running_balance_paise < 0
                                        ? "text-destructive"
                                        : "text-muted-foreground"
                                  }`}
                                >
                                  {formatINR(
                                    Math.abs(txn.running_balance_paise)
                                  )}
                                </span>
                                <span className="block text-[10px] text-muted-foreground">
                                  {txn.running_balance_paise > 0
                                    ? "Receivable"
                                    : txn.running_balance_paise < 0
                                      ? "Payable"
                                      : "Settled"}
                                </span>
                              </TableCell>
                              <TableCell className="whitespace-nowrap py-2 text-right align-top">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                  onClick={() => handleDeleteTxn(txn)}
                                  title="Delete & reverse transaction"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </div>

      <Dialog open={partyModalOpen} onOpenChange={setPartyModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingParty
                ? `Edit ${editingParty.name}`
                : "Add New Khata Party"}
            </DialogTitle>
          </DialogHeader>
          <form
            id="party-form"
            onSubmit={(e) => {
              e.preventDefault();
              savePartyMutation.mutate();
            }}
            className="space-y-3"
          >
            <FormField label="Party Name" required>
              <Input
                required
                placeholder="e.g. Ramesh Sharma, Apex Printers, etc."
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Mobile Number">
                <Input
                  type="tel"
                  maxLength={10}
                  placeholder="9876543210"
                  value={formPhone}
                  onChange={(e) =>
                    setFormPhone(e.target.value.replace(/\D/g, ""))
                  }
                />
              </FormField>

              <FormField label="Category" required>
                <Select value={formCategory} onValueChange={setFormCategory}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            {!editingParty && (
              <div className="space-y-2.5 rounded-md border border-border bg-muted/30 p-3">
                <span className="block text-xs font-semibold text-foreground">
                  Opening Balance (Optional)
                </span>

                <div className="flex flex-wrap gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      openingBalanceDirection === "none" ? "default" : "outline"
                    }
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setOpeningBalanceDirection("none")}
                  >
                    No Opening Balance (₹0)
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      openingBalanceDirection === "gave"
                        ? "destructive"
                        : "outline"
                    }
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setOpeningBalanceDirection("gave")}
                  >
                    You Gave (They owe you)
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      openingBalanceDirection === "got" ? "default" : "outline"
                    }
                    className={`h-7 px-2.5 text-xs ${
                      openingBalanceDirection === "got"
                        ? "bg-emerald-600 hover:bg-emerald-700"
                        : ""
                    }`}
                    onClick={() => setOpeningBalanceDirection("got")}
                  >
                    You Got (You owe them)
                  </Button>
                </div>

                {openingBalanceDirection !== "none" && (
                  <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
                    <FormField label="Opening Amount (₹)" required>
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        required
                        placeholder="0.00"
                        value={openingBalanceRupees}
                        onChange={(e) =>
                          setOpeningBalanceRupees(e.target.value)
                        }
                      />
                    </FormField>

                    <FormField label="Bank / Cash Account">
                      <Select
                        value={openingBankId || "__none__"}
                        onValueChange={(v) =>
                          setOpeningBankId(v === "__none__" ? "" : v)
                        }
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">
                            Do not affect bank balance
                          </SelectItem>
                          {bankAccounts.map((b) => (
                            <SelectItem key={b.id} value={b.id}>
                              {b.name || b.bank_name || "Account"}{" "}
                              {b.account_last4 ? `(****${b.account_last4})` : ""}{" "}
                              — Bal: {formatINR(b.balance_paise)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                  </div>
                )}
              </div>
            )}

            <FormField label="Notes">
              <Textarea
                rows={2}
                placeholder="e.g. Landlord for 2nd floor office, or Friend from college"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </FormField>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPartyModalOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={savePartyMutation.isPending}
              >
                {savePartyMutation.isPending
                  ? "Saving..."
                  : editingParty
                    ? "Save Changes"
                    : "Create Party"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={txnModalOpen} onOpenChange={setTxnModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {txnDirection === "gave"
                ? `Record Payment to ${selectedParty?.name || "Party"}`
                : `Record Receipt from ${selectedParty?.name || "Party"}`}
            </DialogTitle>
          </DialogHeader>
          <form
            id="txn-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveTxnMutation.mutate();
            }}
            className="space-y-3"
          >
            <div className="grid grid-cols-2 gap-1.5 rounded-md bg-muted p-1">
              <Button
                type="button"
                size="sm"
                variant={txnDirection === "gave" ? "destructive" : "ghost"}
                className="h-8 text-xs"
                onClick={() => setTxnDirection("gave")}
              >
                You Gave ₹ (Outflow)
              </Button>
              <Button
                type="button"
                size="sm"
                variant={txnDirection === "got" ? "default" : "ghost"}
                className={`h-8 text-xs ${
                  txnDirection === "got"
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : ""
                }`}
                onClick={() => setTxnDirection("got")}
              >
                You Got ₹ (Inflow)
              </Button>
            </div>

            <FormField label="Amount (₹)" required>
              <div className="relative">
                <span className="absolute left-3 top-2 text-sm font-semibold text-muted-foreground">
                  ₹
                </span>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  autoFocus
                  className="pl-7 text-base font-bold"
                  placeholder="0.00"
                  value={txnRupees}
                  onChange={(e) => setTxnRupees(e.target.value)}
                />
              </div>
            </FormField>

            <FormField label="Paid via Bank / Cash Account" required>
              <Select value={txnBankId} onValueChange={setTxnBankId} required>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select account..." />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name || b.bank_name || "Account"}{" "}
                      {b.account_last4 ? `(****${b.account_last4})` : ""} —{" "}
                      {formatINR(b.balance_paise)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Date" required>
                <DateInput value={txnDate} onChange={setTxnDate} required />
              </FormField>

              <FormField label="Reference / UTR">
                <Input
                  placeholder="e.g. UPI/1234567890"
                  value={txnReference}
                  onChange={(e) => setTxnReference(e.target.value)}
                />
              </FormField>
            </div>

            <FormField label="Note / Purpose">
              <Input
                placeholder={
                  txnDirection === "gave"
                    ? "e.g. Loan for personal work"
                    : "e.g. Return of loan"
                }
                value={txnNote}
                onChange={(e) => setTxnNote(e.target.value)}
              />
            </FormField>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setTxnModalOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                variant={txnDirection === "gave" ? "destructive" : "default"}
                className={
                  txnDirection === "got"
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : ""
                }
                disabled={saveTxnMutation.isPending}
              >
                {saveTxnMutation.isPending
                  ? "Recording..."
                  : txnDirection === "gave"
                    ? `Confirm Outflow ${txnRupees ? `(₹${txnRupees})` : ""}`
                    : `Confirm Inflow ${txnRupees ? `(₹${txnRupees})` : ""}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
