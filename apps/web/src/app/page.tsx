"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Bell, CalendarDays, Camera, Download,
  Check, ChevronDown, CircleHelp, Clock3, Dumbbell, LayoutDashboard,
  LogOut, Menu, MoreHorizontal, Package, Pencil, PhoneCall, Plus, Search, Send, Settings2, ShieldAlert, Tag, Trash2, Users,
  MapPin, Wallet, X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { DashboardSummary } from "@fitzone/shared";

const API = "/api";
let apiLocationId = "";
function setApiLocation(locationId: string) { apiLocationId = locationId; }
type User = { id: string; name: string; email: string; role: string };
type GymLocation = { _id: string; name: string; address: string };
type Member = { _id: string; name: string; email: string; phone: string; membershipStatus: string; membershipExpiresAt?: string; planName?: string };
type ManagedUser = Member & { role: "member" | "staff" | "trainer"; joinedAt?: string };
type MemberProfile = { member: Member & { joinedAt: string }; stats: { membershipMonths: number; totalPaid: number; paymentCount: number; checkIns: number; strikeRate: number }; payments: Array<{ _id: string; amount: number; receiptNumber: string; razorpayPaymentId?: string; paidAt: string; planId: { name: string; durationDays: number } | null }> };
type Retention = { _id: string; absentDays: number; priority: string; userId: Member };
type Plan = { _id: string; name: string; durationDays: number; price: number; description: string; offer?: string; active?: boolean };
type Product = { _id: string; name: string; description: string; price: number; imageUrl?: string };
type MemberDashboard = { member: Member & { joinedAt: string }; location: GymLocation | null; stats: { checkIns: number; strikeRate: number; totalPaid: number; paymentCount: number; membershipMonths: number }; payments: Array<{ _id: string; amount: number; receiptNumber: string; razorpayPaymentId?: string; paidAt: string; planId: { name: string; durationDays: number } | null }>; recentAttendance: Array<{ _id: string; checkedInAt: string; source: string }> };

type RazorpayOptions = { key: string; amount: number; currency: string; name: string; description: string; order_id: string; handler: (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => void; modal: { ondismiss: () => void }; prefill: { name: string; email: string }; theme: { color: string } };
declare global { interface Window { Razorpay?: new (options: RazorpayOptions) => { open: () => void } } }
function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
    if (nonce) script.nonce = nonce;
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(apiLocationId ? { "X-Location-Id": apiLocationId } : {}), ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body.error ?? "Request failed");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

const nav = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Members", icon: Users },
  { label: "Team", icon: Users },
  { label: "Retention", icon: ShieldAlert },
  { label: "Attendance", icon: CalendarDays },
  { label: "Membership Plans", icon: Tag },
  { label: "Products", icon: Wallet },
  { label: "Exports", icon: Download },
];

type ReportPeriod = "day" | "week" | "month";
type ReportKind = "attendance" | "membership-payments" | "product-purchases";

function csvValue(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\t\r ]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function ExportReports({ onError }: { onError: (message: string) => void }) {
  const [kind, setKind] = useState<ReportKind>("attendance");
  const [period, setPeriod] = useState<ReportPeriod>("day");
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function downloadReport() {
    if (kind === "product-purchases") {
      setMessage("Product purchase transactions are not recorded in this app yet, so there are no product sales to export.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{ locationName: string; range: { start: string; end: string }; rows: Record<string, unknown>[] }>(`/owner/exports/${kind}?period=${period}&date=${encodeURIComponent(date)}`);
      const columns = kind === "attendance"
        ? ["attendanceId", "memberId", "memberName", "memberEmail", "checkedInAt", "source", "assistedReason"]
        : ["category", "paymentId", "memberId", "memberName", "memberEmail", "membershipPlan", "amountINR", "paidAt", "receiptNumber", "razorpayOrderId", "razorpayTransactionId", "status"];
      const metadata = ["gym", "periodStart", "periodEnd"];
      const lines = [
        [...metadata, ...columns].map(csvValue).join(","),
        ...result.rows.map((row) => [result.locationName, result.range.start, result.range.end, ...columns.map((column) => row[column])].map(csvValue).join(",")),
      ];
      const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `fitzone-${kind}-${period}-${date}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not export this report");
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel export-panel"><div className="panel-heading"><div><h2>Export gym data</h2><p>Download owner-only CSV reports for the selected gym and date range.</p></div><Download size={18} className="muted-icon" /></div>
    <div className="export-kind-tabs"><button className={kind === "attendance" ? "export-tab-active" : ""} onClick={() => { setKind("attendance"); setMessage(""); }}><CalendarDays size={15} /> Attendance</button><button className={kind === "membership-payments" ? "export-tab-active" : ""} onClick={() => { setKind("membership-payments"); setMessage(""); }}><Wallet size={15} /> Membership payments</button><button className={kind === "product-purchases" ? "export-tab-active" : ""} onClick={() => { setKind("product-purchases"); setMessage(""); }}><Package size={15} /> Product purchases</button></div>
    <div className="export-controls"><label>Time range<select value={period} onChange={(event) => setPeriod(event.target.value as ReportPeriod)}><option value="day">Single day</option><option value="week">Week containing date</option><option value="month">Calendar month</option></select></label><label>Choose date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label><button className="primary-button" onClick={() => void downloadReport()} disabled={busy || !date || kind === "product-purchases"}>{kind === "product-purchases" ? "No purchase data available" : busy ? "Preparing CSV…" : "Download CSV"}{kind !== "product-purchases" && <Download size={15} />}</button></div>
    <p className="export-note">{message || (kind === "attendance" ? "Includes check-in time, member details, check-in method, and assisted check-in reason." : kind === "membership-payments" ? "Membership renewals only. Each row includes the plan, amount, receipt, and Razorpay transaction ID." : "Product sales are separate from memberships. No product purchase transactions are currently recorded." )}</p>
  </section>;
}

type MemberIssueNotice = { _id: string; message: string; status: "unread" | "read"; createdAt: string; member: { name: string; email: string; phone: string } };

function NotificationsView({ onUnreadChange, onError }: { onUnreadChange: (count: number) => void; onError: (message: string) => void }) {
  const [issues, setIssues] = useState<MemberIssueNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const result = await api<{ issues: MemberIssueNotice[]; unreadCount: number }>("/owner/notifications");
      setIssues(result.issues);
      onUnreadChange(result.unreadCount);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load notifications");
    } finally {
      setLoading(false);
    }
  }, [onError, onUnreadChange]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function markRead(issueId: string) {
    try {
      await api(`/owner/notifications/${issueId}/read`, { method: "PATCH" });
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not mark this message as read");
    }
  }
  return <section className="panel notification-panel"><div className="panel-heading"><div><h2>Member issue messages <span className="case-total">{issues.filter((issue) => issue.status === "unread").length}</span></h2><p>Messages sent from member dashboards for this gym location.</p></div><Bell size={18} className="muted-icon" /></div>
    {loading ? <div className="loading-inline"><span className="loader" /> Loading member messages…</div> : issues.length ? <div className="notification-list">{issues.map((issue) => <article className={`notification-item ${issue.status === "unread" ? "notification-unread" : ""}`} key={issue._id}><div className="notification-avatar">{issue.member.name.slice(0, 1).toUpperCase()}</div><div className="notification-message"><div className="notification-message-heading"><b>{issue.member.name}</b><time>{new Date(issue.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</time></div><small>{issue.member.email}{issue.member.phone ? ` · ${issue.member.phone}` : ""}</small><p>{issue.message}</p></div><div className="notification-actions">{issue.status === "unread" ? <><span className="unread-label">NEW</span><button className="secondary-button" onClick={() => void markRead(issue._id)}>Mark read</button></> : <span className="read-label">Read</span>}</div></article>)}</div> : <div className="empty-state"><span className="empty-icon"><Bell size={20} /></span><b>No member messages</b><p>Messages members send about problems will appear here.</p></div>}
  </section>;
}

function PlansView({ onNotice, onError }: { onNotice: (message: string) => void; onError: (message: string) => void }) {
  const emptyForm = { name: "", durationDays: "30", price: "", description: "", offer: "" };
  const [plans, setPlans] = useState<Plan[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState("");
  const [busy, setBusy] = useState(false);
  const loadPlans = useCallback(async () => {
    const result = await api<{ plans: Plan[] }>("/owner/plans");
    setPlans(result.plans);
  }, []);
  useEffect(() => {
    loadPlans().catch((err: unknown) => onError(err instanceof Error ? err.message : "Could not load membership plans"));
  }, [loadPlans, onError]);
  function editPlan(plan: Plan) {
    setEditingId(plan._id);
    setForm({ name: plan.name, durationDays: String(plan.durationDays), price: String(plan.price), description: plan.description ?? "", offer: plan.offer ?? "" });
  }
  function resetForm() {
    setEditingId("");
    setForm(emptyForm);
  }
  async function savePlan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = { ...form, durationDays: Number(form.durationDays), price: Number(form.price) };
      await api(editingId ? `/owner/plans/${editingId}` : "/owner/plans", { method: editingId ? "PATCH" : "POST", body: JSON.stringify(payload) });
      onNotice(editingId ? "Membership plan updated." : "Membership plan created.");
      resetForm();
      await loadPlans();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save membership plan");
    } finally {
      setBusy(false);
    }
  }
  async function removePlan(plan: Plan) {
    if (!window.confirm(`Remove “${plan.name}” from plans available to members? Existing payment history will be kept.`)) return;
    try {
      await api(`/owner/plans/${plan._id}`, { method: "DELETE" });
      onNotice(`${plan.name} was removed from sale. Existing payment history is preserved.`);
      if (editingId === plan._id) resetForm();
      await loadPlans();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not remove membership plan");
    }
  }
  return <div className="plans-layout">
    <section className="panel plan-form-panel"><div className="panel-heading"><div><h2>{editingId ? "Edit membership plan" : "Create a membership plan"}</h2><p>Set the price, duration, and an optional member offer.</p></div>{editingId ? <Pencil size={18} className="muted-icon" /> : <Plus size={18} className="muted-icon" />}</div>
      <form className="assisted-form" onSubmit={savePlan}>
        <label>Plan name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} minLength={2} maxLength={100} placeholder="e.g. Monthly membership" required /></label>
        <div className="plan-form-row"><label>Duration (days)<input type="number" value={form.durationDays} onChange={(event) => setForm({ ...form, durationDays: event.target.value })} min="1" max="3650" step="1" required /></label><label>Price (₹)<input type="number" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} min="0" step="0.01" placeholder="1499" required /></label></div>
        <label>Description <span className="optional-tag">OPTIONAL</span><textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={500} placeholder="What is included in this plan?" /></label>
        <label>Offer for members <span className="optional-tag">OPTIONAL</span><input value={form.offer} onChange={(event) => setForm({ ...form, offer: event.target.value })} maxLength={200} placeholder="e.g. 10% off this month" /></label>
        <button className="primary-button full-button" disabled={busy}>{busy ? "Saving…" : editingId ? "Save changes" : "Create plan"}<ArrowRight size={15} /></button>
        {editingId && <button type="button" className="secondary-button full-button" onClick={resetForm}>Cancel editing</button>}
      </form>
    </section>
    <section className="panel plans-list-panel"><div className="panel-heading"><div><h2>Plans at this location <span className="case-total">{plans.filter((plan) => plan.active !== false).length}</span></h2><p>Changes appear on the member renewal page for this gym.</p></div></div>
      {plans.length ? <div className="owner-plan-list">{plans.map((plan) => <article key={plan._id} className={`owner-plan-row ${plan.active === false ? "plan-archived" : ""}`}><div className="owner-plan-main"><span className="owner-plan-icon"><Tag size={17} /></span><div><b>{plan.name}</b><small>{plan.durationDays} days · ₹{plan.price.toLocaleString("en-IN")}{plan.description ? ` · ${plan.description}` : ""}</small>{plan.offer && <span className="owner-plan-offer"><Tag size={12} /> {plan.offer}</span>}{plan.active === false && <span className="archived-label">Removed from sale</span>}</div></div>{plan.active !== false && <div className="owner-plan-actions"><button className="icon-button" aria-label={`Edit ${plan.name}`} onClick={() => editPlan(plan)}><Pencil size={15} /></button><button className="icon-button plan-delete-button" aria-label={`Remove ${plan.name}`} onClick={() => void removePlan(plan)}><Trash2 size={15} /></button></div>}</article>)}</div> : <div className="empty-state compact-empty">No plans yet. Create the first one to offer memberships.</div>}
    </section>
  </div>;
}

function TeamView({ onNotice, onError }: { onNotice: (message: string) => void; onError: (message: string) => void }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", role: "member" as ManagedUser["role"], password: "" });
  const loadUsers = useCallback(async () => {
    const result = await api<{ users: ManagedUser[] }>("/users");
    setUsers(result.users);
  }, []);
  useEffect(() => {
    loadUsers().catch((err: unknown) => onError(err instanceof Error ? err.message : "Could not load accounts"));
  }, [loadUsers, onError]);
  const filtered = users.filter((item) => `${item.name} ${item.email} ${item.role}`.toLowerCase().includes(search.toLowerCase()));
  async function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/users", { method: "POST", body: JSON.stringify(form) });
      onNotice(`${form.role[0].toUpperCase()}${form.role.slice(1)} account created for ${form.name}.`);
      setForm({ name: "", email: "", phone: "", role: "member", password: "" });
      await loadUsers();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create account");
    } finally {
      setBusy(false);
    }
  }
  return <div className="team-layout">
    <section className="panel account-form-panel">
      <div className="panel-heading"><div><h2>Create an account</h2><p>Add a member, staff account, or trainer.</p></div><Plus size={18} className="muted-icon" /></div>
      <form className="assisted-form" onSubmit={createAccount}>
        <label>Full name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} minLength={2} maxLength={100} autoComplete="name" required /></label>
        <label>Email address<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} autoComplete="email" required /></label>
        <label>Phone number <span className="optional-tag">OPTIONAL</span><input type="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} autoComplete="tel" /></label>
        <label>Account type<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as ManagedUser["role"] })}><option value="member">Member</option><option value="staff">Staff</option><option value="trainer">Trainer</option></select></label>
        <label>Temporary password<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} minLength={12} maxLength={100} autoComplete="new-password" required /><span className="form-hint">At least 12 characters. Share it with the new account holder.</span></label>
        <button className="primary-button full-button" disabled={busy}>{busy ? "Creating account…" : "Create account"}<ArrowRight size={15} /></button>
      </form>
    </section>
    <section className="panel table-panel team-list-panel">
      <div className="panel-heading"><div><h2>People <span className="case-total">{users.length}</span></h2><p>Members, staff, and trainers at your gym.</p></div><label className="table-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search people" /></label></div>
      <div className="table-wrap"><table><thead><tr><th>NAME</th><th>ROLE</th><th>CONTACT</th><th>MEMBERSHIP</th></tr></thead><tbody>{filtered.map((item, index) => <tr key={item._id}><td><span className={`mini-avatar mini-${index % 4}`}>{item.name.slice(0, 1)}</span><span className="member-cell"><b>{item.name}</b><small>{item.email}</small></span></td><td><span className={`role-pill role-${item.role}`}>{item.role}</span></td><td>{item.phone || "—"}</td><td>{item.role === "member" ? <span className={`status-pill ${item.membershipStatus}`}>{item.membershipStatus}</span> : "—"}</td></tr>)}</tbody></table>{!filtered.length && <div className="empty-state">{search ? "No accounts matched your search." : "No accounts yet. Create the first one using the form."}</div>}</div>
    </section>
  </div>;
}

function AccountSettings({ user, onNotice, onError, onLocationCreated }: { user: User; onNotice: (message: string) => void; onError: (message: string) => void; onLocationCreated: (location: GymLocation) => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [locationName, setLocationName] = useState("");
  const [locationAddress, setLocationAddress] = useState("");
  const [locationBusy, setLocationBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  async function updatePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/auth/password", { method: "PATCH", body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword("");
      setNewPassword("");
      onNotice("Your password has been updated.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update password");
    } finally {
      setBusy(false);
    }
  }
  async function addLocation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocationBusy(true);
    try {
      const result = await api<{ location: GymLocation }>("/locations", { method: "POST", body: JSON.stringify({ name: locationName, address: locationAddress }) });
      onLocationCreated(result.location);
      setLocationName("");
      setLocationAddress("");
      onNotice(`${result.location.name} added. You are now viewing it.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add this location");
    } finally {
      setLocationBusy(false);
    }
  }
  return <div className="settings-layout">
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Account details</h2><p>Your signed-in FitZone account.</p></div><Settings2 size={18} className="muted-icon" /></div><dl className="account-details"><div><dt>Name</dt><dd>{user.name}</dd></div><div><dt>Email</dt><dd>{user.email}</dd></div><div><dt>Role</dt><dd className="capitalize">{user.role}</dd></div></dl></section>
    <section className="panel settings-card"><div className="panel-heading"><div><h2>Change password</h2><p>Choose a new password with at least 12 characters.</p></div></div><form className="assisted-form" onSubmit={updatePassword}><label>Current password<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label><label>New password<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={12} maxLength={100} autoComplete="new-password" required /></label><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Update password"}<Check size={15} /></button></form></section>
    {user.role === "owner" && <section className="panel settings-card location-settings-card"><div className="panel-heading"><div><h2>Add a gym location</h2><p>Each new location gets its own members, staff, attendance and sales.</p></div><Plus size={18} className="muted-icon" /></div><form className="assisted-form" onSubmit={addLocation}><label>Location name<input value={locationName} onChange={(event) => setLocationName(event.target.value)} minLength={2} maxLength={100} placeholder="e.g. FitZone Noida" required /></label><label>Address<input value={locationAddress} onChange={(event) => setLocationAddress(event.target.value)} maxLength={250} placeholder="City, state" /></label><button className="primary-button" disabled={locationBusy}>{locationBusy ? "Adding…" : "Add location"}<Plus size={15} /></button></form></section>}
  </div>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<{ user: User }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      onLogin(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-shell">
      <section className="login-visual">
        <div className="login-brand"><span className="brand-mark"><Dumbbell size={23} /></span> FITZONE <span>FITNESS HUB</span></div>
        <div className="visual-copy"><span className="eyebrow">STRONGER, TOGETHER</span><h1>Build habits.<br /><em>Keep showing up.</em></h1><p>Your people are your greatest investment. Let&apos;s help them stay on track.</p></div>
        <div className="visual-foot"><span>DEORIA· UTTAR PRADESH</span><span>MOVE WITH PURPOSE</span></div>
      </section>
      <section className="login-side">
        <div className="login-card"><div className="mobile-mark"><span className="brand-mark"><Dumbbell size={21} /></span> FITZONE</div>
          <div className="eyebrow red">MEMBER RETENTION, REIMAGINED</div>
          <h2>Welcome<br />back.</h2><p className="muted">Sign in to your FitZone workspace.</p>
          <form onSubmit={submit}>
            <label>Email address<input autoComplete="username" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <label>Password<input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            {error && <div className="error-note">{error}</div>}
            <button className="primary-button full-button" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<ArrowRight size={17} /></button>
          </form>
          <div className="login-copyright">© 2025 FITZONE FITNESS HUB <span>·</span> MADE FOR MOVEMENT</div>
        </div>
      </section>
    </main>
  );
}

function MemberHome({ user, onLogout, entryLocationId }: { user: User; onLogout: () => void; entryLocationId: string }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [dashboard, setDashboard] = useState<MemberDashboard | null>(null);
  const [selectedPlan, setSelectedPlan] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [paymentEnabled, setPaymentEnabled] = useState(false);
  const [issueMessage, setIssueMessage] = useState("");
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueSent, setIssueSent] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const entryHandled = useRef("");
  const checkinBusy = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const refreshDashboard = useCallback(async () => setDashboard(await api<MemberDashboard>("/member/dashboard")), []);
  useEffect(() => {
    Promise.all([api<{ plans: Plan[] }>("/plans"), api<{ products: Product[] }>("/products"), refreshDashboard(), api<{ enabled: boolean }>("/renewals/config")])
      .then(([planData, productData, _dashboard, paymentConfig]) => {
        setPlans(planData.plans);
        setSelectedPlan(planData.plans[0]?._id ?? "");
        setProducts(productData.products);
        setPaymentEnabled(paymentConfig.enabled);
      }).catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load your dashboard"));
  }, [refreshDashboard]);
  const verifyEntry = useCallback(async (locationId: string) => {
    if (checkinBusy.current) return;
    checkinBusy.current = true;
    setBusy(true);
    setError("");
    try {
      await api("/attendance/check-in", { method: "POST", body: JSON.stringify({ locationId }) });
      setNotice("Entry approved. Have a great workout!");
      await refreshDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Entry could not be verified");
    } finally {
      checkinBusy.current = false;
      setBusy(false);
    }
  }, [refreshDashboard]);
  async function submitIssue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIssueBusy(true);
    setError("");
    setIssueSent(false);
    try {
      await api("/member/issues", { method: "POST", body: JSON.stringify({ message: issueMessage }) });
      setIssueMessage("");
      setIssueSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send your message");
    } finally {
      setIssueBusy(false);
    }
  }
  useEffect(() => {
    if (!entryLocationId || entryHandled.current === entryLocationId) return;
    entryHandled.current = entryLocationId;
    window.history.replaceState(null, "", window.location.pathname);
    void verifyEntry(entryLocationId);
  }, [entryLocationId, verifyEntry]);
  useEffect(() => {
    if (!cameraOpen || !videoRef.current) return;
    const reader = new BrowserQRCodeReader();
    let mounted = true;
    let stopScanner: (() => void) | undefined;
    void reader.decodeFromVideoDevice(undefined, videoRef.current, (result, _error, controls) => {
      if (!mounted || !result) return;
      controls.stop();
      setCameraOpen(false);
      try {
        const scannedUrl = new URL(result.getText());
        const locationId = scannedUrl.searchParams.get("entry");
        if (scannedUrl.origin !== window.location.origin || scannedUrl.pathname !== "/" || !locationId || !/^[0-9a-fA-F]{24}$/.test(locationId)) {
          throw new Error("This is not a valid FitZone entry QR code.");
        }
        void verifyEntry(locationId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read the gym entry QR code");
      }
    }).then((controls) => {
      if (!mounted) controls.stop();
      else stopScanner = () => controls.stop();
    }).catch((err: unknown) => {
      if (mounted) {
        setCameraOpen(false);
        setError(err instanceof Error ? err.message : "Could not open the camera");
      }
    });
    return () => {
      mounted = false;
      stopScanner?.();
    };
  }, [cameraOpen, verifyEntry]);
  async function renew() {
    if (!selectedPlan) return;
    setBusy(true);
    setError("");
    try {
      const checkout = await api<{ orderId: string; amount: number; currency: string; keyId: string }>("/renewals/checkout", {
        method: "POST",
        body: JSON.stringify({ planId: selectedPlan, idempotencyKey: crypto.randomUUID() }),
      });
      if (!(await loadRazorpay()) || !window.Razorpay) throw new Error("Could not load Razorpay checkout. Please check your connection and try again.");
      const selected = plans.find((plan) => plan._id === selectedPlan);
      const gateway = new window.Razorpay({
        key: checkout.keyId, amount: checkout.amount, currency: checkout.currency, name: "FitZone Fitness Hub",
        description: `${selected?.name ?? "Membership"} renewal`, order_id: checkout.orderId,
        prefill: { name: user.name, email: user.email }, theme: { color: "#bd343b" },
        handler: (response) => {
          void api<{ payment: { receiptNumber: string; razorpayPaymentId?: string } }>("/renewals/verify", { method: "POST", body: JSON.stringify(response) })
            .then(async (result) => { setNotice(`Payment successful · Transaction ID ${result.payment.razorpayPaymentId ?? response.razorpay_payment_id}`); await refreshDashboard(); })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : "Payment verification failed"))
            .finally(() => setBusy(false));
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      gateway.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Renewal failed");
      setBusy(false);
    }
  }
  return <main className="member-portal">
    <header className="member-header"><a className="brand" href="#"><span className="brand-mark"><Dumbbell size={21} /></span><span>FITZONE<small>MEMBER DASHBOARD</small></span></a><div className="member-user"><span>Welcome, <b>{user.name.split(" ")[0]}</b></span><button className="icon-button" onClick={onLogout} aria-label="Sign out"><LogOut size={17} /></button></div></header>
    <div id="member-dashboard" className="member-content member-dashboard"><div className="eyebrow red">YOUR MEMBER SPACE</div><h1>Your progress,<br /><em>all in one place.</em></h1><p className="member-intro">Membership, visits and payments. Keep your momentum going.</p>
      {notice && <div className="success-banner"><Check size={16} />{notice}</div>}{error && <div className="error-banner"><ShieldAlert size={16} />{error}</div>}
      {dashboard && <>
        <section className="member-welcome"><div><span>MEMBERSHIP STATUS</span><h2>{dashboard.member.planName ?? "FitZone Member"}</h2><p className="member-plan-meta"><i className={`status-dot ${dashboard.member.membershipStatus}`} /> {dashboard.member.membershipStatus} {dashboard.member.membershipExpiresAt ? `· Expires ${new Date(dashboard.member.membershipExpiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : "· No expiry date"}</p></div><div className="member-welcome-mark"><Dumbbell size={34} /></div></section>
        <section className="member-profile-strip"><div className="member-location-badge"><MapPin size={19} /></div><div className="member-location-copy"><span>YOUR FITZONE GYM</span><b>{dashboard.location?.name ?? "Gym location"}</b><small>{dashboard.location?.address || "Address not added yet"}</small></div><div className="member-profile-divider" /><div className="member-profile-detail"><span>MEMBER SINCE</span><b>{new Date(dashboard.member.joinedAt).toLocaleDateString("en-IN", { month: "short", year: "numeric" })}</b></div><div className="member-profile-detail"><span>MEMBERSHIP RENEWS</span><b>{dashboard.member.membershipExpiresAt ? new Date(dashboard.member.membershipExpiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "No expiry set"}</b></div></section>
        <div className="member-metric-grid"><article><span><Activity size={16} /> ATTENDANCE STRIKE RATE</span><b>{dashboard.stats.strikeRate}%</b><small>{dashboard.stats.checkIns} visit days since joining</small></article><article><span><CalendarDays size={16} /> CHECK-INS</span><b>{dashboard.stats.checkIns}</b><small>Recorded gym visits</small></article><article><span><Wallet size={16} /> TOTAL PAID</span><b>₹{dashboard.stats.totalPaid.toLocaleString("en-IN")}</b><small>{dashboard.stats.paymentCount} successful payments</small></article><article><span><Clock3 size={16} /> MEMBERSHIP BOUGHT</span><b>{dashboard.stats.membershipMonths} mo</b><small>Across paid memberships</small></article></div>
        <div className="member-dashboard-grid"><section className="panel member-dashboard-panel"><div className="panel-heading"><div><h2>Recent attendance</h2><p>Your latest gym visits</p></div><Activity size={18} className="muted-icon" /></div>{dashboard.recentAttendance.length ? <div className="member-history-list">{dashboard.recentAttendance.map((visit) => <div className="member-history-row" key={visit._id}><span className="history-icon"><Check size={15} /></span><span><b>Gym check-in</b><small>{visit.source === "assisted" ? "Front desk assisted" : "QR check-in"}</small></span><time>{new Date(visit.checkedInAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</time></div>)}</div> : <p className="member-empty">Your visits will show up here after your first check-in.</p>}</section>
          <section className="panel member-dashboard-panel"><div className="panel-heading"><div><h2>Payment history</h2><p>Your membership receipts</p></div><Wallet size={18} className="muted-icon" /></div>{dashboard.payments.length ? <div className="member-history-list">{dashboard.payments.slice(0, 5).map((payment) => <div className="member-history-row" key={payment._id}><span className="history-icon"><Check size={15} /></span><span><b>{payment.planId?.name ?? "Membership"}</b><small>{payment.receiptNumber} · {new Date(payment.paidAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</small><small>Razorpay Transaction ID: {payment.razorpayPaymentId ?? "Unavailable for this payment"}</small></span><strong>₹{payment.amount.toLocaleString("en-IN")}</strong></div>)}</div> : <p className="member-empty">No payments recorded yet.</p>}</section></div>
        <section className="panel member-dashboard-panel member-products"><div className="panel-heading"><div><h2>From FitZone</h2><p>Products picked by your gym</p></div><Dumbbell size={18} className="muted-icon" /></div>{products.length ? <div className="product-grid">{products.map((product) => <article className="product-card" key={product._id}>{product.imageUrl ? <img src={product.imageUrl} alt={product.name} /> : <div className="product-placeholder"><Dumbbell size={25} /></div>}<div><b>{product.name}</b><p>{product.description || "Available at FitZone"}</p><strong>₹{product.price.toLocaleString("en-IN")}</strong></div></article>)}</div> : <p className="member-empty">Your gym’s latest products will appear here.</p>}</section>
      </>}
      <div className="member-cards"><section className="panel member-action-card"><div className="panel-heading"><div><h2>Gym entry check-in</h2><p>Scan the permanent QR code displayed at your gym entrance.</p></div><Activity size={18} className="muted-icon" /></div><button type="button" className="secondary-button camera-button" onClick={() => setCameraOpen((open) => !open)} disabled={busy}><Camera size={15} />{cameraOpen ? "Close scanner" : "Scan entrance QR"}</button>{cameraOpen && <video ref={videoRef} className="scanner-video" muted playsInline />}<div className="form-hint"><ShieldAlert size={14} /> {cameraOpen ? "Point your camera at the permanent FitZone QR code." : "You can also scan the QR with your phone’s camera app. The server verifies your gym, membership, and today’s check-in."}</div>{busy && <div className="loading-inline"><span className="loader" /> Verifying your entry…</div>}</section>
        <section className="panel member-action-card"><div className="panel-heading"><div><h2>Renew your membership</h2><p>Choose a plan to keep your momentum going.</p></div><Wallet size={18} className="muted-icon" /></div><div className="member-plans">{plans.length ? plans.map((plan) => <button type="button" key={plan._id} className={`plan-choice ${selectedPlan === plan._id ? "plan-selected" : ""}`} onClick={() => setSelectedPlan(plan._id)}><span><b>{plan.name}</b><small>{plan.durationDays} days · {plan.description}</small>{plan.offer && <em className="member-plan-offer"><Tag size={12} /> {plan.offer}</em>}</span><strong>₹{plan.price.toLocaleString("en-IN")}</strong></button>) : <div className="empty-state plan-empty"><b>No plans are available right now.</b><p>Please refresh this page. If the plans are still missing, contact FitZone staff.</p></div>}</div><button className="primary-button full-button" onClick={renew} disabled={!selectedPlan || busy || !paymentEnabled}>{!paymentEnabled ? "Payments unavailable" : busy ? "Opening secure checkout…" : plans.length ? "Pay securely with Razorpay" : "Plans unavailable"} <ArrowRight size={15} /></button><div className="form-hint"><ShieldAlert size={14} />{paymentEnabled ? "Secure payment processed by Razorpay." : "Razorpay is not configured yet. Add API keys to the server environment to enable payments."}</div></section></div>
      <section className="panel member-help-card member-issue-card"><span className="help-icon"><CircleHelp size={17} /></span><div><b>My issue</b><small>Have a problem or need help? Send a message directly to your gym.</small></div><button className="secondary-button" type="button" onClick={() => { setIssueSent(false); setIssueOpen((open) => !open); }}>{issueOpen ? "Close form" : "Send an issue"} <ArrowRight size={14} /></button></section>
      {issueOpen && <section className="panel member-issue-panel"><div className="panel-heading"><div><h2>Send a message to your gym</h2><p>Your message goes to the owner&apos;s notifications for this location.</p></div><Send size={17} className="muted-icon" /></div><form className="assisted-form" onSubmit={submitIssue}><label>Describe the issue<textarea value={issueMessage} onChange={(event) => setIssueMessage(event.target.value)} minLength={5} maxLength={1500} placeholder="Tell us what happened or how we can help…" required /></label><button className="primary-button" disabled={issueBusy || issueMessage.trim().length < 5}>{issueBusy ? "Sending…" : "Send message"}<Send size={14} /></button>{issueSent && <p className="issue-sent-note"><Check size={14} /> Message sent to your gym.</p>}</form></section>}
      <div className="member-footer">FITZONE FITNESS HUB <span>·</span> STRONGER, TOGETHER</div>
    </div>
  </main>;
}

function TrainerHome({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ members: Member[] }>("/trainer/members").then((data) => setMembers(data.members))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load your member list"));
  }, []);
  return <main className="member-portal">
    <header className="member-header"><a className="brand" href="#"><span className="brand-mark"><Dumbbell size={21} /></span><span>FITZONE<small>TRAINER DESK</small></span></a><div className="member-user"><span>Coach <b>{user.name}</b></span><button className="icon-button" onClick={onLogout} aria-label="Sign out"><LogOut size={17} /></button></div></header>
    <div className="member-content"><div className="eyebrow red">YOUR COACHING SPACE</div><h1>Good to see you,<br /><em>Coach {user.name.split(" ")[0]}.</em></h1><p className="member-intro">Members assigned to you at FitZone Fitness Hub.</p>
      {error && <div className="error-banner"><ShieldAlert size={16} />{error}</div>}
      <section className="panel table-panel trainer-panel"><div className="panel-heading"><div><h2>My members <span className="case-total">{members.length}</span></h2><p>Reach out, keep them moving, and celebrate every milestone.</p></div></div><div className="table-wrap"><table><thead><tr><th>MEMBER</th><th>CONTACT</th><th>MEMBERSHIP</th><th>PLAN</th><th>STATUS</th></tr></thead><tbody>{members.map((member, index) => <tr key={member._id}><td><span className={`mini-avatar mini-${index % 4}`}>{member.name.slice(0, 1)}</span><span className="member-cell"><b>{member.name}</b><small>{member.email}</small></span></td><td>{member.phone || "—"}</td><td>{member.membershipExpiresAt ? new Date(member.membershipExpiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}</td><td>{member.planName ?? "—"}</td><td><span className={`status-pill ${member.membershipStatus}`}>{member.membershipStatus}</span></td></tr>)}</tbody></table>{!members.length && !error && <div className="empty-state"><b>No members assigned yet</b><p>Ask the gym owner to assign members to your trainer profile.</p></div>}</div></section>
      <div className="member-footer">FITZONE FITNESS HUB <span>·</span> COACH WITH PURPOSE</div>
    </div>
  </main>;
}

type HelpMessage = { from: "coach" | "you"; text: string };

function workoutAnswer(question: string) {
  const q = question.toLowerCase();
  if (["fat", "weight", "lose", "slim"].some((word) => q.includes(word))) {
    return "For a fat-loss focused session, start with a 5-minute easy warm-up, then walk briskly or cycle for 20 minutes. Finish with 2 rounds of 10 chair squats, 8 wall push-ups, and 12 glute bridges, resting 60 seconds between rounds. Cool down with 5 minutes of gentle stretching. Start with strength training 3 days a week and comfortable walks on other days."
  }
  if (["muscle", "strength", "gain", "strong"].some((word) => q.includes(word))) {
    return "For strength, warm up for 5 minutes, then do 3 sets each of 8–10 chair squats, 6–10 wall or incline push-ups, 10 backpack rows, and 12 glute bridges. Rest 60–90 seconds between sets. Try this 3 days a week with a recovery day between sessions. Focus on good form before adding weight."
  }
  if (["ghar", "home", "without", "equipment"].some((word) => q.includes(word))) {
    return "Here is a 25–30 minute no-equipment home workout: march in place and do joint circles for 5 minutes, then complete 2–3 rounds of 10 chair squats, 8 wall push-ups, 12 glute bridges, and 8 bird-dogs per side. Rest 60 seconds between rounds and finish with 5 minutes of gentle stretching. Use fewer rounds if you are new to exercise."
  }
  if (["week", "weekly", "schedule", "hafte"].some((word) => q.includes(word))) {
    return "A simple week could look like this: Monday strength (20–30 minutes), Tuesday brisk walk (20 minutes), Wednesday rest or mobility (10 minutes), Thursday strength, Friday walk or cycling (20–30 minutes), Saturday light full-body strength, and Sunday rest. If you are new to exercise, start with 2 strength days and allow time to recover."
  }
  if (["beginner", "naya", "start", "shuru"].some((word) => q.includes(word))) {
    return "If you are a beginner, start with 20 minutes: warm up easily for 5 minutes, then spend 10 minutes doing 1–2 rounds of 8 chair squats, 6 wall push-ups, and 10 glute bridges. Cool down for 5 minutes. Two or three days a week is enough to start. Keep a pace that still lets you talk comfortably."
  }
  return "Today's routine (about 35 minutes): warm up with 5 minutes of brisk walking or marching and shoulder and hip mobility. Do 2–3 rounds of 10 chair squats, 8 wall push-ups, 12 glute bridges, and 8 bird-dogs per side, resting 45–60 seconds between rounds. Then walk briskly for 10 minutes and cool down for 5 minutes. If you are new to exercise, do 2 rounds. Stop if you feel sharp pain or dizzy. Is your goal fat loss, strength, or a home workout?"
}

function WorkoutHelp() {
  const [messages, setMessages] = useState<HelpMessage[]>([
    { from: "coach", text: "Hi! I’m your FitZone Coach. I can suggest daily exercise routines and how long to do them.\n\nToday's routine (about 35 minutes): 5 minutes of warm-up, 15–18 minutes of strength exercises, 10 minutes of brisk walking, and a 5-minute cool-down. If you are new to exercise, start with 2 rounds. Send me your goal or question below." },
  ]);
  const [draft, setDraft] = useState("");
  const ask = (value: string) => {
    const question = value.trim();
    if (!question) return;
    setMessages((current) => [...current, { from: "you", text: question }, { from: "coach", text: workoutAnswer(question) }]);
    setDraft("");
  };
  return <div className="workout-help-layout">
    <section className="panel coach-chat">
      <header className="coach-chat-head"><span className="coach-avatar"><Dumbbell size={18} /></span><div><h2>FitZone Workout Coach</h2><p>Daily routines and exercise guidance</p></div><span className="coach-status"><i /> READY</span></header>
      <div className="coach-messages" aria-live="polite">{messages.map((message, index) => <div key={index} className={`coach-message ${message.from === "you" ? "user" : "coach"}`}>{message.text}</div>)}</div>
      <div className="coach-suggestions">{["Today's routine", "Fat loss", "Build strength", "Home workout", "Weekly plan"].map((label) => <button type="button" key={label} onClick={() => ask(label)}>{label}</button>)}</div>
      <form className="coach-input" onSubmit={(event) => { event.preventDefault(); ask(draft); }}><input aria-label="Type your question" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Type your goal or question..." /><button type="submit" aria-label="Send message" disabled={!draft.trim()}><Send size={16} /></button></form>
    </section>
    <aside className="panel coach-call-card"><span className="coach-call-icon"><PhoneCall size={19} /></span><h2>Still need help?</h2><p>If you need more guidance, speak with us by phone or WhatsApp.</p><a className="coach-call-button" href="tel:7800330409"><PhoneCall size={15} /> Call 7800330409</a><a className="coach-whatsapp-button" href="https://wa.me/917800330409" target="_blank" rel="noreferrer">Message us on WhatsApp</a><small>Both options use 7800330409.</small></aside>
  </div>;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [section, setSection] = useState("Overview");
  const [locations, setLocations] = useState<GymLocation[]>([]);
  const [activeLocationId, setActiveLocationId] = useState("");
  const [workspaceLocation, setWorkspaceLocation] = useState<GymLocation | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [memberProfile, setMemberProfile] = useState<MemberProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [cases, setCases] = useState<Retention[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productForm, setProductForm] = useState({ name: "", description: "", price: "", imageUrl: "" });
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [entryLocationId, setEntryLocationId] = useState("");
  const [assistedMember, setAssistedMember] = useState("");
  const [reason, setReason] = useState("");

  const loadSummary = useCallback(async () => {
    const data = await api<DashboardSummary>("/dashboard");
    setSummary(data);
  }, []);
  const loadMembers = useCallback(async (query = "") => {
    const data = await api<{ members: Member[] }>(`/members${query ? `?search=${encodeURIComponent(query)}` : ""}`);
    setMembers(data.members);
  }, []);
  async function openMemberProfile(memberId: string) {
    setProfileLoading(true);
    setMemberProfile(null);
    setError("");
    try {
      setMemberProfile(await api<MemberProfile>(`/members/${memberId}/profile`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load member profile");
    } finally {
      setProfileLoading(false);
    }
  }
  const loadCases = useCallback(async () => {
    const data = await api<{ cases: Retention[] }>("/retention");
    setCases(data.cases);
  }, []);
  const loadProducts = useCallback(async () => {
    const data = await api<{ products: Product[] }>("/products");
    setProducts(data.products);
  }, []);
  const refreshNotificationCount = useCallback(async () => {
    if (user?.role !== "owner") {
      setNotificationCount(0);
      return;
    }
    try {
      const result = await api<{ unreadCount: number }>("/owner/notifications");
      setNotificationCount(result.unreadCount);
    } catch {
      // The notifications view displays request errors when opened.
    }
  }, [user?.role]);

  async function initializeUser(nextUser: User, branch?: GymLocation | null) {
    if (nextUser.role === "owner") {
      const result = await api<{ locations: GymLocation[] }>("/locations");
      const first = result.locations[0];
      setLocations(result.locations);
      setWorkspaceLocation(first ?? null);
      setActiveLocationId(first?._id ?? "");
      setApiLocation(first?._id ?? "");
    } else {
      let assignedLocation = branch;
      if (branch === undefined) {
        assignedLocation = (await api<{ location: GymLocation | null }>("/auth/me")).location;
      }
      setLocations([]);
      setWorkspaceLocation(assignedLocation ?? null);
      setActiveLocationId("");
      setApiLocation("");
    }
    setUser(nextUser);
  }
  useEffect(() => {
    let mounted = true;
    const entryId = new URLSearchParams(window.location.search).get("entry");
    if (entryId && /^[0-9a-fA-F]{24}$/.test(entryId)) setEntryLocationId(entryId);
    api<{ user: User; location: GymLocation | null }>("/auth/me")
      .then((data) => mounted ? initializeUser(data.user, data.location) : undefined)
      .catch(() => { if (mounted) setUser(null); })
      .finally(() => { if (mounted) setChecking(false); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    if (!user || user.role === "member" || user.role === "trainer") return;
    setError("");
    const jobs = [loadSummary()];
    if (section === "Members" || section === "Attendance") jobs.push(loadMembers());
    if (section === "Retention") jobs.push(loadCases());
    if (section === "Products") jobs.push(loadProducts());
    Promise.all(jobs).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load this view"));
  }, [user, section, activeLocationId, loadCases, loadMembers, loadProducts, loadSummary]);
  useEffect(() => {
    if (user?.role !== "owner") return;
    void refreshNotificationCount();
    const timer = window.setInterval(() => void refreshNotificationCount(), 30_000);
    return () => window.clearInterval(timer);
  }, [user?.role, activeLocationId, refreshNotificationCount]);
  if (checking) return <div className="loading-screen"><div className="loader" />Loading FitZone…</div>;
  if (!user) return <Login onLogin={(loggedInUser) => { void initializeUser(loggedInUser); }} />;

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setApiLocation("");
    setLocations([]);
    setActiveLocationId("");
    setUser(null);
  }
  function switchLocation(locationId: string) {
    const location = locations.find((item) => item._id === locationId);
    if (!location) return;
    setApiLocation(locationId);
    setActiveLocationId(locationId);
    setWorkspaceLocation(location);
    setSummary(null);
    setMembers([]);
    setCases([]);
    setProducts([]);
    setMemberProfile(null);
    setNotice(`Now viewing ${location.name}.`);
    setError("");
  }
  function locationCreated(location: GymLocation) {
    setLocations((current) => [...current, location]);
    setApiLocation(location._id);
    setActiveLocationId(location._id);
    setWorkspaceLocation(location);
    setSection("Overview");
    setSummary(null);
    setMembers([]);
    setCases([]);
    setProducts([]);
  }
  if (user.role === "member") return <MemberHome user={user} entryLocationId={entryLocationId} onLogout={() => { void logout(); }} />;
  if (user.role === "trainer") return <TrainerHome user={user} onLogout={() => { void logout(); }} />;
  const qrLocationId = user.role === "owner" ? activeLocationId : workspaceLocation?._id ?? "";
  const permanentEntryUrl = typeof window !== "undefined" && qrLocationId
    ? `${window.location.origin}/?entry=${encodeURIComponent(qrLocationId)}`
    : "";
  async function scan() {
    try {
      const data = await api<{ scanned: number; opened: number }>("/retention/scan", { method: "POST" });
      setNotice(`Scan complete · ${data.opened} new follow-up ${data.opened === 1 ? "case" : "cases"} created from ${data.scanned} eligible members.`);
      await Promise.all([loadSummary(), loadCases()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    }
  }
  async function submitOutcome(item: Retention, outcome: string) {
    try {
      await api(`/retention/${item._id}/follow-ups`, { method: "POST", body: JSON.stringify({ outcome, note: "" }) });
      setNotice(`Follow-up recorded for ${item.userId.name}.`);
      await Promise.all([loadCases(), loadSummary()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record follow-up");
    }
  }
  async function assistedCheckin(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api("/attendance/assisted", { method: "POST", body: JSON.stringify({ memberId: assistedMember, reason }) });
      setNotice("Assisted check-in recorded. Any open retention case was resolved.");
      setReason("");
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record check-in");
    }
  }

  async function addProduct(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/products", { method: "POST", body: JSON.stringify({ ...productForm, price: Number(productForm.price) }) });
      setProductForm({ name: "", description: "", price: "", imageUrl: "" });
      setNotice("Product added to the member dashboard.");
      await loadProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add product");
    }
  }

  async function archiveProduct(productId: string) {
    try {
      await api(`/products/${productId}/archive`, { method: "PATCH" });
      await loadProducts();
      setNotice("Product removed from the member dashboard.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove product");
    }
  }

  const cards = [
    { label: "Active members", value: summary?.activeMembers ?? "—", change: "Members on an active plan", icon: Users, tone: "peach" },
    { label: "Check-ins today", value: summary?.checkInsToday ?? "—", change: "Keep the momentum going", icon: Activity, tone: "lavender" },
    { label: "Need a follow-up", value: summary?.openRetentionCases ?? "—", change: "Members away 10+ days", icon: ShieldAlert, tone: "mint" },
    { label: "Revenue this month", value: `₹${(summary?.revenueThisMonth ?? 0).toLocaleString("en-IN")}`, change: "From verified renewals", icon: Wallet, tone: "blue" },
  ];
  const filteredMembers = members.filter((member) => `${member.name} ${member.email}`.toLowerCase().includes(search.toLowerCase()));
  const heading = section === "Overview" ? "Good morning" : section;

  return (
    <div className="app-shell">
      {mobileNav && <button aria-label="Close navigation" className="nav-scrim" onClick={() => setMobileNav(false)} />}
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <a className="brand" href="#" onClick={() => setSection("Overview")}><span className="brand-mark"><Dumbbell size={21} /></span><span>FITZONE<small>FITNESS HUB</small></span></a>
        <div className="workspace"><span className="workspace-avatar">F</span><span className="workspace-copy"><b>{workspaceLocation?.name ?? "FitZone Fitness Hub"}</b><small>{workspaceLocation?.address ?? "GYM LOCATION"}</small></span>{user.role === "owner" ? <span className="workspace-switch"><ChevronDown size={14} /><select className="workspace-select" aria-label="Switch gym location" value={activeLocationId} onChange={(event) => event.target.value === "__add_location__" ? setSection("Settings") : switchLocation(event.target.value)}>{locations.map((location) => <option key={location._id} value={location._id}>{location.name}</option>)}<option value="__add_location__">+ Add a location</option></select></span> : <ChevronDown size={14} />}</div>
        <div className="nav-caption">WORKSPACE</div>
        <nav>{nav.filter(({ label }) => (label !== "Products" && label !== "Team" && label !== "Membership Plans" && label !== "Exports") || user.role === "owner").map(({ label, icon: Icon }) => <button key={label} className={`nav-item ${section === label ? "nav-active" : ""}`} onClick={() => { setSection(label); setMobileNav(false); }}><Icon size={17} /><span>{label}</span>{label === "Retention" && !!summary?.openRetentionCases && <i className="nav-count">{summary.openRetentionCases}</i>}</button>)}</nav>
        <div className="sidebar-bottom">
          <div className="sidebar-help"><span className="help-icon"><CircleHelp size={17} /></span><b>Need a hand?</b><small>We&apos;re here to help your gym thrive.</small><button onClick={() => { setSection("Help"); setMobileNav(false); }}>Visit help center <ArrowRight size={13} /></button></div>
          <button className={`nav-item settings-item ${section === "Settings" ? "nav-active" : ""}`} onClick={() => { setSection("Settings"); setMobileNav(false); }}><Settings2 size={17} /><span>Settings</span></button>
          <div className="profile-row"><div className="profile-avatar">{user.name.slice(0, 1)}</div><span><b>{user.name}</b><small>{user.role[0].toUpperCase() + user.role.slice(1)}</small></span><button aria-label="Sign out" className="icon-button" onClick={logout}><LogOut size={16} /></button></div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar"><button aria-label="Open navigation" className="mobile-menu icon-button" onClick={() => setMobileNav(true)}><Menu size={19} /></button><div className="breadcrumbs">Workspace <span>/</span> <b>{section}</b></div><div className="top-actions"><div className="today-label"><CalendarDays size={15} /> {new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</div>{searchOpen && <input autoFocus className="top-search-input" aria-label="Search members" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setSearchOpen(false); }} placeholder="Search members" />}<button aria-label={searchOpen ? "Close member search" : "Search members"} title="Search members" className="icon-button search-toggle" onClick={() => { setSection("Members"); setSearchOpen((open) => !open); }}><Search size={17} /></button>{user.role === "owner" && <button aria-label="Notifications" title="Member messages" className="icon-button notification-button" onClick={() => setSection("Notifications")}><Bell size={17} />{notificationCount > 0 && <span className="notification-count">{notificationCount > 99 ? "99+" : notificationCount}</span>}</button>}<button type="button" aria-label="Open account settings" title="Account settings" className="top-avatar top-avatar-button" onClick={() => setSection("Settings")}>{user.name.slice(0, 1)}</button></div></header>
        <div className="page-content">
          <div className="page-heading"><div><div className="eyebrow">{section === "Overview" ? new Date().toLocaleDateString("en-IN", { weekday: "long", month: "long", day: "numeric" }).toUpperCase() : "FITZONE FITNESS HUB"}</div><h1>{heading}{section === "Overview" && <span>, {user.name.split(" ")[0]} <span className="wave">✳</span></span>}</h1><p>{section === "Overview" ? "Here’s what’s happening at your gym today." : section === "Retention" ? "A little encouragement can make all the difference." : section === "Members" ? "Your community, all in one place." : section === "Team" ? "Create and manage member, staff, and trainer accounts." : section === "Membership Plans" ? "Manage membership pricing, durations, and offers for this location." : section === "Settings" ? "Manage your account details and password." : section === "Products" ? "Add products for members to discover in their dashboard." : section === "Help" ? "Ask about your workout or daily routine." : "Make every visit count. Keep your members moving."}</p></div>{section === "Retention" && <button className="primary-button scan-button" onClick={scan}><Activity size={16} /> Run daily scan</button>}{section === "Overview" && <button className="secondary-button" onClick={() => setSection("Attendance")}><CalendarDays size={16} /> Record attendance</button>}</div>
          {notice && <div className="success-banner"><Check size={16} />{notice}<button aria-label="Dismiss message" onClick={() => setNotice("")}><X size={15} /></button></div>}
          {error && <div className="error-banner"><ShieldAlert size={16} />{error}<button aria-label="Dismiss error" onClick={() => setError("")}><X size={15} /></button></div>}

          {section === "Overview" && <>
            <div className="welcome-banner"><div className="welcome-art"><span className="sun-shape" /><span className="banner-spark">✳</span><Dumbbell size={70} strokeWidth={1.1} /></div><div><div className="banner-tag">YOUR GYM, IN GOOD SHAPE</div><h2>Small check-ins.<br /><em>Big comebacks.</em></h2><p>Every member who walks back through the door is a win. Let&apos;s make more of them.</p><button onClick={() => setSection("Retention")}>View follow-up list <ArrowRight size={15} /></button></div><div className="banner-index">01 <span>/</span> 03</div></div>
            <div className="section-title"><div><h2>Your gym at a glance</h2><p>A little snapshot of today&apos;s progress.</p></div><button className="text-button">This month <ChevronDown size={14} /></button></div>
            <div className="stats-grid">{cards.map(({ label, value, change, icon: Icon, tone }, i) => <article className="stat-card" key={label}><div className={`stat-icon ${tone}`}><Icon size={18} /></div><button className="more-button" aria-label={`More ${label} options`}><MoreHorizontal size={18} /></button><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-foot">{i === 0 ? <span className="trend up"><ArrowUpRight size={13} /> 8.2%</span> : i === 2 ? <span className="trend down"><ArrowDownRight size={13} /> Action</span> : <span className="trend neutral"><Clock3 size={12} /></span>}<span>{change}</span></div></article>)}</div>
            <div className="lower-grid"><section className="panel activity-panel"><div className="panel-heading"><div><h2>Retention pulse</h2><p>Member activity over the last 7 days</p></div><span className="live-pill"><i /> LIVE</span></div><div className="pulse-content"><div className="pulse-score">{summary?.activityRate7d ?? 0}<span>%</span></div><div className="pulse-copy"><b>of active members visited this week</b><span>Let&apos;s keep that number climbing.</span></div><div className="pulse-bars">{[40, 62, 48, 81, 58, 72, 52, 92, 65, 78, 50, 73].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div></div><div className="panel-bottom"><span><i className="legend-dot" /> Member check-ins</span><button className="text-button" onClick={() => setSection("Attendance")}>View activity <ArrowRight size={14} /></button></div></section>
              <section className="panel recent-panel"><div className="panel-heading"><div><h2>Recent check-ins</h2><p>The latest faces through the door.</p></div><button className="more-button"><MoreHorizontal size={18} /></button></div><div className="recent-list">{summary?.recentAttendance.length ? summary.recentAttendance.slice(0, 4).map((item, index) => <div className="recent-row" key={`${item.memberName}-${item.checkedInAt}-${index}`}><div className={`mini-avatar mini-${index % 4}`}>{item.memberName.slice(0, 1)}</div><div className="recent-name"><b>{item.memberName}</b><span>Member check-in</span></div><div className="recent-time">{new Date(item.checkedInAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</div></div>) : <div className="empty-inline">No check-ins yet today.</div>}</div><button className="panel-link" onClick={() => setSection("Attendance")}>See all attendance <ArrowRight size={14} /></button></section></div>
            <div className="bottom-note"><span><span className="note-mark">✳</span> CONSISTENCY IS BUILT ONE VISIT AT A TIME</span><span>FITZONE RETENTION DESK <b>·</b> 2025</span></div>
          </>}
          {section === "Members" && <>
            {profileLoading && <section className="panel member-profile-panel"><div className="loading-inline"><div className="loader" />Loading member profile…</div></section>}
            {memberProfile && <section className="panel member-profile-panel"><div className="panel-heading"><div><div className="eyebrow red">MEMBER PROFILE</div><h2 className="profile-title">{memberProfile.member.name}</h2><p>ID: {memberProfile.member._id} · {memberProfile.member.email} · {memberProfile.member.phone || "No phone added"} · Joined {new Date(memberProfile.member.joinedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</p></div><button className="icon-button profile-close" aria-label="Close member profile" onClick={() => setMemberProfile(null)}><X size={18} /></button></div><div className="profile-stats"><div><small>MEMBERSHIP BOUGHT</small><b>{memberProfile.stats.membershipMonths} months</b></div><div><small>TOTAL PAID</small><b>₹{memberProfile.stats.totalPaid.toLocaleString("en-IN")}</b><span>{memberProfile.stats.paymentCount} payments</span></div><div><small>CHECK-INS</small><b>{memberProfile.stats.checkIns}</b><span>All recorded visits</span></div><div><small>ATTENDANCE STRIKE RATE</small><b>{memberProfile.stats.strikeRate}%</b><span>Check-ins ÷ days since joining</span></div></div><div className="profile-membership">Current plan: <b>{memberProfile.member.planName ?? "No active plan"}</b><span className={`status-pill ${memberProfile.member.membershipStatus}`}>{memberProfile.member.membershipStatus}</span>{memberProfile.member.membershipExpiresAt && <span>Expires {new Date(memberProfile.member.membershipExpiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>}</div><div className="payment-history"><b>Payment history</b>{memberProfile.payments.length ? memberProfile.payments.map((payment) => <div className="payment-row" key={payment._id}><span><b>{payment.planId?.name ?? "Membership"}</b><small>{new Date(payment.paidAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · {payment.receiptNumber}</small><small>Razorpay Transaction ID: {payment.razorpayPaymentId ?? "Unavailable for this payment"}</small></span><strong>₹{payment.amount.toLocaleString("en-IN")}</strong></div>) : <p>No payments recorded yet.</p>}</div></section>}
            <section className="panel table-panel"><div className="panel-heading"><div><h2>Member directory</h2><p>{members.length} members in your community · Select a member to view their profile</p></div><label className="table-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name or email" /></label></div><div className="table-wrap"><table><thead><tr><th>MEMBER</th><th>CONTACT</th><th>PLAN</th><th>EXPIRES</th><th>STATUS</th></tr></thead><tbody>{filteredMembers.map((member, index) => <tr key={member._id} className="member-select-row" onClick={() => void openMemberProfile(member._id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") void openMemberProfile(member._id); }}><td><span className={`mini-avatar mini-${index % 4}`}>{member.name.slice(0, 1)}</span><span className="member-cell"><b>{member.name}</b><small>{member.email}</small></span></td><td>{member.phone || "—"}</td><td>{member.planName ?? "—"}</td><td>{member.membershipExpiresAt ? new Date(member.membershipExpiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"}</td><td><span className={`status-pill ${member.membershipStatus}`}>{member.membershipStatus}</span></td></tr>)}</tbody></table>{!filteredMembers.length && <div className="empty-state">No members matched that search.</div>}</div></section>
          </>}
          {section === "Team" && <TeamView key={activeLocationId} onNotice={setNotice} onError={setError} />}
          {section === "Membership Plans" && <PlansView key={activeLocationId} onNotice={setNotice} onError={setError} />}
          {section === "Settings" && <AccountSettings user={user} onNotice={setNotice} onError={setError} onLocationCreated={locationCreated} />}
          {section === "Exports" && user.role === "owner" && <ExportReports onError={setError} />}
          {section === "Notifications" && user.role === "owner" && <NotificationsView onUnreadChange={setNotificationCount} onError={setError} />}
          {section === "Help" && <WorkoutHelp />}
          {section === "Retention" && <section className="panel table-panel"><div className="panel-heading"><div><h2>Follow-up list <span className="case-total">{cases.length}</span></h2><p>Active members with 10 or more days away.</p></div><div className="risk-legend"><span><i className="risk-high" /> 20+ days</span><span><i className="risk-medium" /> 14+ days</span><span><i className="risk-low" /> 10+ days</span></div></div>{cases.length ? <div className="table-wrap"><table><thead><tr><th>MEMBER</th><th>AWAY FOR</th><th>LAST PLAN</th><th>PRIORITY</th><th>FOLLOW-UP</th></tr></thead><tbody>{cases.map((item) => <tr key={item._id}><td><span className="mini-avatar mini-1">{item.userId.name.slice(0, 1)}</span><span className="member-cell"><b>{item.userId.name}</b><small>{item.userId.phone || item.userId.email}</small></span></td><td><b>{item.absentDays} days</b></td><td>{item.userId.planName ?? "Active plan"}</td><td><span className={`priority ${item.priority}`}>{item.priority}</span></td><td><div className="follow-actions"><a href={`https://wa.me/${(item.userId.phone ?? "").replace(/\D/g, "")}?text=${encodeURIComponent(`Hi ${item.userId.name.split(" ")[0]}, we missed you at FitZone! Hope all is well. Let us know how we can help you get back to your routine.`)}`} target="_blank" rel="noreferrer" className="whatsapp-button">WhatsApp</a><select aria-label={`Record follow-up for ${item.userId.name}`} value="" onChange={(event) => { if (event.target.value) void submitOutcome(item, event.target.value); }}><option value="">Record outcome</option><option value="will_return">Will return</option><option value="injured">Injured</option><option value="travelling">Travelling</option><option value="timing_issue">Timing issue</option><option value="unhappy">Unhappy</option><option value="no_response">No response</option><option value="cancelled">Cancelled</option></select></div></td></tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-icon"><Check size={22} /></span><b>All caught up!</b><p>No members currently need a follow-up. Run a fresh scan to check for anyone newly inactive.</p><button className="secondary-button" onClick={scan}><Activity size={15} /> Run daily scan</button></div>}</section>}
          {section === "Attendance" && <div className="attendance-grid"><section className="panel attendance-panel"><div className="panel-heading"><div><h2>Permanent gym entry QR</h2><p>This gym-specific QR code never expires or needs regeneration.</p></div><span className="live-pill"><i /> MEMBER ENTRY</span></div><div className="qr-area">{permanentEntryUrl ? <div className="qr-token"><QRCodeSVG value={permanentEntryUrl} size={190} level="Q" includeMargin /><span>Scan with a phone camera · sign in required</span></div> : <div className="qr-empty"><span>Select an active gym location to show its permanent entry QR.</span></div>}</div><div className="form-hint"><ShieldAlert size={14} /> Keep this QR at the entrance. Each scan is checked against the member account, gym branch, active membership, and same-day attendance.</div></section><section className="panel attendance-panel"><div className="panel-heading"><div><h2>Assisted check-in</h2><p>Record a visit at the front desk.</p></div><Users size={18} className="muted-icon" /></div><form className="assisted-form" onSubmit={assistedCheckin}><label>Member<select value={assistedMember} onChange={(event) => setAssistedMember(event.target.value)} required><option value="">Choose a member</option>{members.length ? members.map((member) => <option value={member._id} key={member._id}>{member.name} · {member.email}</option>) : <option disabled value="">Open Members first to load the list</option>}</select></label><label>Reason <span className="required-tag">REQUIRED</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={300} placeholder="Why is staff recording this check-in?" required /></label><p className="form-hint"><ShieldAlert size={14} /> Assisted visits require a reason for auditability.</p><button className="primary-button full-button">Record check-in <Check size={15} /></button></form></section></div>}
          {section === "Products" && <div className="products-admin-grid"><section className="panel product-admin-panel"><div className="panel-heading"><div><h2>Add a product</h2><p>Members can see these products when they sign in.</p></div><Plus size={18} className="muted-icon" /></div><form className="assisted-form" onSubmit={addProduct}><label>Product name<input value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} minLength={2} maxLength={100} placeholder="e.g. FitZone whey protein" required /></label><label>Description<textarea value={productForm.description} onChange={(event) => setProductForm({ ...productForm, description: event.target.value })} maxLength={500} placeholder="Short product details" /></label><label>Price (₹)<input type="number" min="0" step="0.01" value={productForm.price} onChange={(event) => setProductForm({ ...productForm, price: event.target.value })} placeholder="0" required /></label><label>Image URL <span className="optional-tag">OPTIONAL</span><input type="url" value={productForm.imageUrl} onChange={(event) => setProductForm({ ...productForm, imageUrl: event.target.value })} placeholder="https://…" /></label><button className="primary-button full-button"><Package size={15} /> Add product</button></form></section><section className="panel product-admin-panel"><div className="panel-heading"><div><h2>Member products <span className="case-total">{products.length}</span></h2><p>Active products shown on member dashboards.</p></div></div>{products.length ? products.map((product) => <div className="admin-product-row" key={product._id}><span className="admin-product-icon"><Package size={17} /></span><span><b>{product.name}</b><small>{product.description || "No description"}</small></span><strong>₹{product.price.toLocaleString("en-IN")}</strong><button className="icon-button" aria-label={`Remove ${product.name}`} onClick={() => void archiveProduct(product._id)}><X size={16} /></button></div>) : <div className="empty-state compact-empty">No products added yet.</div>}</section></div>}
          <div className="bottom-note"><span><span className="note-mark">✳</span> CONSISTENCY IS BUILT ONE VISIT AT A TIME</span><span>FITZONE RETENTION DESK <b>·</b> 2025</span></div>
        </div>
      </main>
    </div>
  );
}
