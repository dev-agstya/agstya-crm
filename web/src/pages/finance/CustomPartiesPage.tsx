import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customPartiesApi, banksApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import {
  StatCard,
  StatRow,
  Modal,
  Field,
  SearchInput,
  EmptyState,
  Avatar,
  Spinner,
} from "../../components/ui";
import { DateInput } from "../../components/DateInput";
import { confirmDialog } from "../../components/Confirm";
import { toast } from "../../components/Toast";
import { formatINR, formatDate, formatDateTime } from "../../lib/format";
import { liveQueryOptions } from "../../lib/live";
import type {
  CustomParty,
  CustomTransaction,
  BankAccount,
} from "../../lib/types";

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

  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get("id"));
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  // Modals
  const [partyModalOpen, setPartyModalOpen] = useState(false);
  const [editingParty, setEditingParty] = useState<CustomParty | null>(null);

  // Transaction Modal
  const [txnModalOpen, setTxnModalOpen] = useState(false);
  const [txnDirection, setTxnDirection] = useState<"gave" | "got">("gave");

  // Fetch overview & party list
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

  // Fetch bank accounts for payment logging
  const banksQuery = useQuery({
    queryKey: ["finance", "bank-accounts-active"],
    queryFn: async () => {
      const res = await banksApi.list({ include_inactive: false });
      return res.data?.items ?? [];
    },
    staleTime: 60_000,
  });
  const bankAccounts: BankAccount[] = banksQuery.data ?? [];

  // Auto-select first party if none selected or if current selection is invalid
  useEffect(() => {
    if (parties.length > 0) {
      if (!selectedId || !parties.some((p) => p.id === selectedId)) {
        const nextId = parties[0].id;
        setSelectedId(nextId);
        setSearchParams((prev) => {
          const p = new URLSearchParams(prev);
          p.set("id", nextId);
          return p;
        }, { replace: true });
      }
    } else {
      setSelectedId(null);
    }
  }, [parties, selectedId, setSearchParams]);

  // Handle URL action=pay
  useEffect(() => {
    if (searchParams.get("action") === "pay" && selectedId) {
      setTxnDirection("gave");
      setTxnModalOpen(true);
      setSearchParams((prev) => {
        const p = new URLSearchParams(prev);
        p.delete("action");
        return p;
      }, { replace: true });
    }
  }, [searchParams, selectedId, setSearchParams]);

  // Fetch selected party details & ledger transactions
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

  // Form states for Party Create/Edit
  const [formName, setFormName] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formCategory, setFormCategory] = useState("personal");
  const [formNotes, setFormNotes] = useState("");
  const [openingBalanceDirection, setOpeningBalanceDirection] = useState<"none" | "gave" | "got">("none");
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

  // Save Party Mutation
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
      toast.success(editingParty ? "Party details updated." : "Party created successfully.");
      setPartyModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ["finance", "custom-parties"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "bank-accounts-active"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "banks"] });
      if (saved?.id) {
        handleSelectParty(saved.id);
      }
    },
    onError: (err) => {
      toast.error(apiError(err));
    },
  });

  // Archive Party Mutation
  const archivePartyMutation = useMutation({
    mutationFn: async (partyId: string) => {
      return (await customPartiesApi.archive(partyId)).data;
    },
    onSuccess: () => {
      toast.success("Party archived.");
      queryClient.invalidateQueries({ queryKey: ["finance", "custom-parties"] });
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

  // Form states for Record Transaction
  const [txnRupees, setTxnRupees] = useState("");
  const [txnBankId, setTxnBankId] = useState("");
  const [txnDate, setTxnDate] = useState(() => new Date().toISOString().slice(0, 10));
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

  // Save Transaction Mutation
  const saveTxnMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId) throw new Error("No party selected.");
      const amtPaise = Math.round(parseFloat(txnRupees || "0") * 100);
      if (amtPaise <= 0) throw new Error("Please enter a valid amount greater than zero.");

      const isToday = !txnDate || txnDate === new Date().toISOString().slice(0, 10);
      const occurredIso = isToday ? new Date().toISOString() : new Date(`${txnDate}T12:00:00Z`).toISOString();

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
      toast.success(txnDirection === "gave" ? "Payment (Outflow) logged." : "Receipt (Inflow) logged.");
      setTxnModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ["finance", "custom-parties"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "custom-party-detail", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["finance", "bank-accounts-active"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "banks"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "balance-sheet"] });
    },
    onError: (err) => {
      toast.error(apiError(err));
    },
  });

  // Delete Transaction Mutation
  const deleteTxnMutation = useMutation({
    mutationFn: async (txnId: string) => {
      return (await customPartiesApi.deleteTxn(txnId)).data;
    },
    onSuccess: () => {
      toast.success("Transaction reversed and bank balance updated.");
      queryClient.invalidateQueries({ queryKey: ["finance", "custom-parties"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "custom-party-detail", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["finance", "bank-accounts-active"] });
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
      message: `Delete this ${formatINR(txn.amount_paise)} transaction? This will automatically reverse its effect on your linked bank or cash account.`,
      confirmLabel: "Reverse Transaction",
      danger: true,
    });
    if (ok) {
      deleteTxnMutation.mutate(txn.id);
    }
  };

  const overview = overviewQuery.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Khata (Custom Parties)"
        subtitle="Manage personal loans, friends, vendors, and non-policy cash movements. Every payment stays matched with your Bank & Cash balances."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate("/finance/balance-sheet")}
              className="btn-secondary flex items-center gap-1.5"
            >
              <Icon.Receipt size={16} />
              Balance Sheet
            </button>
            <button
              onClick={openAddPartyModal}
              className="btn-primary flex items-center gap-1.5"
            >
              <Icon.Plus size={16} />
              Add Party
            </button>
          </div>
        }
      />

      {/* Top Summary KPI Cards */}
      <StatRow cols={4}>
        <StatCard
          label="You Will Get"
          value={formatINR(overview?.total_you_will_get_paise)}
          tone="in"
          hint="Money others owe you"
          tooltip="Total outstanding amount that parties owe you from payments given or opening balances."
        />
        <StatCard
          label="You Will Give"
          value={formatINR(overview?.total_you_will_give_paise)}
          tone="out"
          hint="Money you owe to others"
          tooltip="Total outstanding amount you owe to parties from payments received or borrowing."
        />
        <StatCard
          label="Net Khata Balance"
          value={overview?.net_balance_paise != null ? formatINR(Math.abs(overview.net_balance_paise)) : "—"}
          tone={(overview?.net_balance_paise ?? 0) >= 0 ? "in" : "out"}
          hint={(overview?.net_balance_paise ?? 0) >= 0 ? "Net receivable position" : "Net payable position"}
          tooltip="Overall difference between total receivables and total payables across all custom parties."
        />
        <StatCard
          label="Active Parties"
          value={String(overview?.total_parties ?? 0)}
          hint="Friends, vendors & loans"
          tooltip="Count of active parties currently tracked in your Khata book."
        />
      </StatRow>

      {/* Main 2-Column Split Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Party Roster (4 cols) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="card card-body space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-800">Parties Directory</h2>
              <span className="text-xs text-slate-500">{parties.length} parties</span>
            </div>

            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search by name or phone..."
            />

            {/* Category Filter Pills */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button
                onClick={() => setCategoryFilter("all")}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition ${
                  categoryFilter === "all"
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                All
              </button>
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  onClick={() => setCategoryFilter(cat.value)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition ${
                    categoryFilter === cat.value
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Party List Cards */}
          <div className="space-y-2">
            {overviewQuery.isLoading ? (
              <div className="card card-body flex items-center justify-center p-8 text-slate-500">
                <Spinner className="mr-2" /> Loading parties...
              </div>
            ) : parties.length === 0 ? (
              <div className="card card-body text-center p-8">
                <EmptyState
                  icon={<Icon.Users size={20} />}
                  title="No parties found"
                  hint={
                    search
                      ? "No parties match your search query."
                      : "Add your first custom party to start logging personal loans or vendor payments."
                  }
                  action={
                    <button onClick={openAddPartyModal} className="btn-primary btn-sm">
                      <Icon.Plus size={14} className="mr-1" /> Add New Party
                    </button>
                  }
                />
              </div>
            ) : (
              parties.map((party) => {
                const isSelected = party.id === selectedId;
                const bal = party.balance_paise;
                const isGet = bal > 0;
                const isGive = bal < 0;

                return (
                  <div
                    key={party.id}
                    onClick={() => handleSelectParty(party.id)}
                    className={`card p-3.5 cursor-pointer transition border ${
                      isSelected
                        ? "border-slate-800 bg-slate-50/80 shadow-sm"
                        : "border-line hover:border-slate-300 hover:bg-slate-50/50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <Avatar name={party.name} size="md" />
                        <div className="min-w-0">
                          <h3 className="font-semibold text-sm text-slate-900 truncate">
                            {party.name}
                          </h3>
                          <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-500">
                            {party.phone ? <span>{party.phone}</span> : null}
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                              {categoryLabel(party.category)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Balance Pill */}
                      <div className="shrink-0 text-right">
                        {isGet ? (
                          <div className="rounded-md bg-money-in/10 px-2 py-1 text-right">
                            <span className="block text-[11px] font-medium text-money-in">
                              You will get
                            </span>
                            <span className="font-semibold text-sm text-money-in tabular-nums">
                              {formatINR(bal)}
                            </span>
                          </div>
                        ) : isGive ? (
                          <div className="rounded-md bg-money-out/10 px-2 py-1 text-right">
                            <span className="block text-[11px] font-medium text-money-out">
                              You will give
                            </span>
                            <span className="font-semibold text-sm text-money-out tabular-nums">
                              {formatINR(Math.abs(bal))}
                            </span>
                          </div>
                        ) : (
                          <div className="rounded-md bg-slate-100 px-2 py-1 text-right">
                            <span className="block text-[11px] font-medium text-slate-500">
                              Settled
                            </span>
                            <span className="font-semibold text-sm text-slate-600 tabular-nums">
                              ₹0
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Selected Party Ledger & Actions (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          {!selectedParty ? (
            <div className="card card-body flex flex-col items-center justify-center p-12 text-center">
              <EmptyState
                icon={<Icon.Users size={20} />}
                title="Select a Party"
                hint="Click on any party from the directory on the left to view their detailed Khata ledger and log payments."
                action={
                  <button onClick={openAddPartyModal} className="btn-primary">
                    <Icon.Plus size={16} className="mr-1.5" />
                    Add New Party
                  </button>
                }
              />
            </div>
          ) : (
            <>
              {/* Party Header Banner */}
              <div className="card card-body space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Avatar name={selectedParty.name} size="lg" />
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-section font-bold text-slate-900">
                          {selectedParty.name}
                        </h2>
                        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                          {categoryLabel(selectedParty.category)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                        {selectedParty.phone && (
                          <span className="flex items-center gap-1">
                            <Icon.Users size={12} />
                            {selectedParty.phone}
                          </span>
                        )}
                        <span>Added {formatDate(selectedParty.created_at)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    {selectedParty.phone && (
                      <a
                        href={`https://wa.me/91${selectedParty.phone.replace(/\D/g, "")}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-secondary btn-sm flex items-center gap-1.5"
                        title="Send WhatsApp message"
                      >
                        <Icon.WhatsApp size={14} />
                        WhatsApp
                      </a>
                    )}
                    <button
                      onClick={() => openEditPartyModal(selectedParty)}
                      className="btn-secondary btn-sm flex items-center gap-1"
                    >
                      <Icon.Edit size={14} />
                      Edit
                    </button>
                    <button
                      onClick={() => handleArchiveParty(selectedParty)}
                      className="btn-secondary btn-sm text-slate-500 hover:text-due flex items-center gap-1"
                      title="Archive party"
                    >
                      <Icon.Archive size={14} />
                    </button>
                  </div>
                </div>

                {selectedParty.notes && (
                  <div className="rounded-md bg-slate-50 p-2.5 text-xs text-slate-600 border border-line-soft">
                    <span className="font-semibold text-slate-700">Notes:</span> {selectedParty.notes}
                  </div>
                )}

                {/* Big Balance Hero Banner with 2 Main Buttons */}
                <div className="rounded-md border border-line bg-gradient-to-br from-slate-50 to-white p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <span className="text-caption uppercase text-slate-500 font-semibold tracking-wider">
                        Current Khata Balance
                      </span>
                      <div className="mt-1 flex items-baseline gap-2">
                        {selectedParty.balance_paise > 0 ? (
                          <>
                            <span className="text-metric font-bold text-money-in tabular-nums">
                              {formatINR(selectedParty.balance_paise)}
                            </span>
                            <span className="text-sm font-semibold text-money-in">
                              (You will get)
                            </span>
                          </>
                        ) : selectedParty.balance_paise < 0 ? (
                          <>
                            <span className="text-metric font-bold text-money-out tabular-nums">
                              {formatINR(Math.abs(selectedParty.balance_paise))}
                            </span>
                            <span className="text-sm font-semibold text-money-out">
                              (You will give)
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="text-metric font-bold text-slate-700 tabular-nums">
                              ₹0
                            </span>
                            <span className="text-sm font-medium text-slate-500">
                              (Settled)
                            </span>
                          </>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        Total Outflow Given: {formatINR(selectedParty.total_charged_paise)} · Total Inflow Received: {formatINR(selectedParty.total_settled_paise)}
                      </p>
                    </div>

                    {/* View in Balance Sheet link */}
                    <button
                      onClick={() => navigate(`/finance/balance-sheet`)}
                      className="text-xs font-semibold text-slate-700 hover:text-slate-900 underline flex items-center gap-1"
                    >
                      <Icon.Receipt size={14} />
                      View in Balance Sheet
                    </button>
                  </div>

                  {/* 2 Prominent Primary Actions */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    <button
                      onClick={() => openRecordModal("gave")}
                      className="flex items-center justify-center gap-2 py-3 px-4 rounded-md bg-money-out text-white font-semibold shadow-sm hover:opacity-90 active:scale-[0.99] transition"
                    >
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-white/80" />
                      <span>You Gave ₹ (Outflow)</span>
                    </button>
                    <button
                      onClick={() => openRecordModal("got")}
                      className="flex items-center justify-center gap-2 py-3 px-4 rounded-md bg-money-in text-white font-semibold shadow-sm hover:opacity-90 active:scale-[0.99] transition"
                    >
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-white/80" />
                      <span>You Got ₹ (Inflow)</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Transactions Ledger Table */}
              <div className="card overflow-hidden">
                <div className="card-header flex items-center justify-between border-b border-line px-5 py-3">
                  <div className="flex items-center gap-2">
                    <Icon.Receipt size={16} className="text-slate-500" />
                    <h3 className="font-semibold text-sm text-slate-800">
                      Ledger History
                    </h3>
                  </div>
                  <span className="text-xs text-slate-500">
                    {transactions.length} {transactions.length === 1 ? "entry" : "entries"}
                  </span>
                </div>

                {detailQuery.isLoading ? (
                  <div className="p-8 text-center text-slate-500">
                    <Spinner className="mr-2" /> Loading ledger transactions...
                  </div>
                ) : transactions.length === 0 ? (
                  <div className="p-8 text-center">
                    <p className="text-sm font-medium text-slate-700">No transactions yet.</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Use the &quot;You Gave&quot; or &quot;You Got&quot; buttons above to record your first transaction.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm border-collapse">
                      <thead>
                        <tr className="border-b border-line bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                          <th className="px-4 py-2.5">Date</th>
                          <th className="px-4 py-2.5">Details & Account</th>
                          <th className="px-4 py-2.5 text-right">You Gave</th>
                          <th className="px-4 py-2.5 text-right">You Got</th>
                          <th className="px-4 py-2.5 text-right">Balance</th>
                          <th className="px-3 py-2.5 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {transactions.map((txn) => {
                          const isGave = txn.direction === "gave";
                          const isGot = txn.direction === "got";

                          return (
                            <tr key={txn.id} className="hover:bg-slate-50/60 transition">
                              <td className="px-4 py-3 align-top whitespace-nowrap">
                                <span className="block font-medium text-slate-900 text-xs">
                                  {formatDate(txn.occurred_at)}
                                </span>
                                <span className="block text-[11px] text-slate-500">
                                  {formatDateTime(txn.occurred_at).split(",")[1]?.trim()}
                                </span>
                              </td>
                              <td className="px-4 py-3 align-top">
                                <span className="font-medium text-slate-800 text-xs block">
                                  {txn.note || (isGave ? "Money paid out" : "Money received")}
                                </span>
                                <div className="flex flex-wrap items-center gap-2 mt-0.5 text-[11px] text-slate-500">
                                  {txn.bank_account_name ? (
                                    <span className="flex items-center gap-1 font-medium text-slate-600">
                                      <Icon.Wallet size={11} />
                                      {txn.bank_account_name}
                                    </span>
                                  ) : (
                                    <span>Direct Ledger Entry</span>
                                  )}
                                  {txn.reference && (
                                    <span className="rounded bg-slate-100 px-1 py-0.2 text-[10px]">
                                      Ref: {txn.reference}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                                {isGave ? (
                                  <span className="font-semibold text-money-out tabular-nums">
                                    {formatINR(txn.amount_paise)}
                                  </span>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                                {isGot ? (
                                  <span className="font-semibold text-money-in tabular-nums">
                                    {formatINR(txn.amount_paise)}
                                  </span>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                                <span
                                  className={`font-semibold tabular-nums ${
                                    txn.running_balance_paise > 0
                                      ? "text-money-in"
                                      : txn.running_balance_paise < 0
                                      ? "text-money-out"
                                      : "text-slate-600"
                                  }`}
                                >
                                  {formatINR(Math.abs(txn.running_balance_paise))}
                                </span>
                                <span className="block text-[10px] text-slate-500">
                                  {txn.running_balance_paise > 0
                                    ? "Receivable"
                                    : txn.running_balance_paise < 0
                                    ? "Payable"
                                    : "Settled"}
                                </span>
                              </td>
                              <td className="px-3 py-3 align-top text-right whitespace-nowrap">
                                <button
                                  onClick={() => handleDeleteTxn(txn)}
                                  className="rounded p-1 text-slate-400 hover:text-due hover:bg-slate-100 transition"
                                  title="Delete & reverse transaction"
                                >
                                  <Icon.Trash size={14} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Modal: Add or Edit Party */}
      <Modal
        open={partyModalOpen}
        onClose={() => setPartyModalOpen(false)}
        title={editingParty ? `Edit ${editingParty.name}` : "Add New Khata Party"}
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPartyModalOpen(false)}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="party-form"
              disabled={savePartyMutation.isPending}
              className="btn-primary"
            >
              {savePartyMutation.isPending
                ? "Saving..."
                : editingParty
                ? "Save Changes"
                : "Create Party"}
            </button>
          </div>
        }
      >
        <form
          id="party-form"
          onSubmit={(e) => {
            e.preventDefault();
            savePartyMutation.mutate();
          }}
          className="space-y-4"
        >
          <Field label="Party Name *" tooltip="Name of the person, friend, vendor, or entity.">
            <input
              type="text"
              required
              className="input w-full"
              placeholder="e.g. Ramesh Sharma, Apex Printers, etc."
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Mobile Number" tooltip="Optional 10-digit mobile number for WhatsApp ledger sharing.">
              <input
                type="tel"
                maxLength={10}
                className="input w-full"
                placeholder="9876543210"
                value={formPhone}
                onChange={(e) => setFormPhone(e.target.value.replace(/\D/g, ""))}
              />
            </Field>

            <Field label="Category *" tooltip="Helps group your khata entries.">
              <select
                className="select w-full"
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {!editingParty && (
            <div className="rounded-md border border-line bg-slate-50/70 p-3.5 space-y-3">
              <span className="text-xs font-semibold text-slate-800 block">
                Opening Balance (Optional)
              </span>

              <div className="flex flex-wrap gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setOpeningBalanceDirection("none")}
                  className={`px-3 py-1.5 rounded-md font-medium transition ${
                    openingBalanceDirection === "none"
                      ? "bg-slate-900 text-white"
                      : "bg-white border border-line text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  No Opening Balance (₹0)
                </button>
                <button
                  type="button"
                  onClick={() => setOpeningBalanceDirection("gave")}
                  className={`px-3 py-1.5 rounded-md font-medium transition ${
                    openingBalanceDirection === "gave"
                      ? "bg-money-out text-white"
                      : "bg-white border border-line text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  You Gave (They owe you)
                </button>
                <button
                  type="button"
                  onClick={() => setOpeningBalanceDirection("got")}
                  className={`px-3 py-1.5 rounded-md font-medium transition ${
                    openingBalanceDirection === "got"
                      ? "bg-money-in text-white"
                      : "bg-white border border-line text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  You Got (You owe them)
                </button>
              </div>

              {openingBalanceDirection !== "none" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                  <Field label="Opening Amount (₹) *">
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      className="input w-full"
                      placeholder="0.00"
                      value={openingBalanceRupees}
                      onChange={(e) => setOpeningBalanceRupees(e.target.value)}
                    />
                  </Field>

                  <Field
                    label="Bank / Cash Account"
                    tooltip="Select account if cash already left/entered this bank account."
                  >
                    <select
                      className="select w-full"
                      value={openingBankId}
                      onChange={(e) => setOpeningBankId(e.target.value)}
                    >
                      <option value="">Do not affect bank balance</option>
                      {bankAccounts.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name || b.bank_name || "Account"} {b.account_last4 ? `(****${b.account_last4})` : ""} — Bal: {formatINR(b.balance_paise)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}
            </div>
          )}

          <Field label="Notes" tooltip="Optional notes or details about this party.">
            <textarea
              rows={2}
              className="input w-full"
              placeholder="e.g. Landlord for 2nd floor office, or Friend from college"
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
            />
          </Field>
        </form>
      </Modal>

      {/* Modal: Record Transaction (You Gave / You Got) */}
      <Modal
        open={txnModalOpen}
        onClose={() => setTxnModalOpen(false)}
        title={
          txnDirection === "gave"
            ? `Record Payment to ${selectedParty?.name || "Party"}`
            : `Record Receipt from ${selectedParty?.name || "Party"}`
        }
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setTxnModalOpen(false)}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="txn-form"
              disabled={saveTxnMutation.isPending}
              className={`font-semibold py-2 px-4 rounded-md text-white transition ${
                txnDirection === "gave" ? "bg-money-out hover:opacity-90" : "bg-money-in hover:opacity-90"
              }`}
            >
              {saveTxnMutation.isPending
                ? "Recording..."
                : txnDirection === "gave"
                ? `Confirm Outflow ${txnRupees ? `(₹${txnRupees})` : ""}`
                : `Confirm Inflow ${txnRupees ? `(₹${txnRupees})` : ""}`}
            </button>
          </div>
        }
      >
        <form
          id="txn-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveTxnMutation.mutate();
          }}
          className="space-y-4"
        >
          {/* Direction Toggle */}
          <div className="grid grid-cols-2 gap-2 p-1 rounded-md bg-slate-100">
            <button
              type="button"
              onClick={() => setTxnDirection("gave")}
              className={`py-2 px-3 rounded-md text-xs font-semibold transition ${
                txnDirection === "gave"
                  ? "bg-money-out text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              You Gave ₹ (Outflow)
            </button>
            <button
              type="button"
              onClick={() => setTxnDirection("got")}
              className={`py-2 px-3 rounded-md text-xs font-semibold transition ${
                txnDirection === "got"
                  ? "bg-money-in text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              You Got ₹ (Inflow)
            </button>
          </div>

          <Field
            label="Amount (₹) *"
            tooltip="Amount in Indian Rupees to log."
          >
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-slate-400 font-semibold">₹</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                autoFocus
                className="input w-full pl-7 text-base font-bold"
                placeholder="0.00"
                value={txnRupees}
                onChange={(e) => setTxnRupees(e.target.value)}
              />
            </div>
          </Field>

          <Field
            label="Paid via Bank / Cash Account *"
            tooltip="Which bank or cash box was used? Balance will update atomically."
          >
            <select
              required
              className="select w-full"
              value={txnBankId}
              onChange={(e) => setTxnBankId(e.target.value)}
            >
              <option value="">Select account...</option>
              {bankAccounts.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name || b.bank_name || "Account"} {b.account_last4 ? `(****${b.account_last4})` : ""} — Available: {formatINR(b.balance_paise)}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Date *" tooltip="Date the transaction took place.">
              <DateInput
                value={txnDate}
                onChange={setTxnDate}
                required
              />
            </Field>

            <Field label="Reference / UTR" tooltip="Optional UPI reference, cheque number, or bank UTR.">
              <input
                type="text"
                className="input w-full"
                placeholder="e.g. UPI/1234567890"
                value={txnReference}
                onChange={(e) => setTxnReference(e.target.value)}
              />
            </Field>
          </div>

          <Field label="Note / Purpose" tooltip="Reason for payment (e.g. Medical emergency loan, Tea vendor bill).">
            <input
              type="text"
              className="input w-full"
              placeholder={txnDirection === "gave" ? "e.g. Loan for personal work" : "e.g. Return of loan"}
              value={txnNote}
              onChange={(e) => setTxnNote(e.target.value)}
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
