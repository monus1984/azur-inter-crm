import { useEffect, useState, useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types/database";

interface Props { profile: Profile; }

// ─── Constantes visuelles (héritées de l'ancien CRM) ──────────────────────────
const C = {
  orange: "#E85D00", orangeL: "#FF7A20", orangeDim: "rgba(232,93,0,0.10)",
  blue: "#1A6FC4", green: "#0F9B6E", red: "#D93055", yellow: "#C98A00",
  purple: "#6D4FC4", text: "#1A2332", muted: "#6B7C8E",
  border: "rgba(0,0,0,0.07)", card: "#FFFFFF", bg: "#F0F2F7", nav: "#1A2E42",
};
const UNIVERS_COLORS: Record<string, string> = {
  INTERNET: C.blue, MOBILE: C.orange, ICT: C.purple,
  FIXE: C.green, AUTRES: C.muted,
};
const AGENCE_COLORS = [C.orange, C.blue, C.green, C.purple, C.yellow, C.red];

// Objectifs mensuels équipe T4 2026 (OCI officiels)
const OBJECTIF_EQUIPE: Record<string, number> = {
  INTERNET: 3000000, MOBILE: 7500000, ICT: 1500000, FIXE: 300000, TOTAL: 12300000,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(0) + "K" : String(Math.round(n));
const fmtN = (n: number) => new Intl.NumberFormat("fr-FR").format(Math.round(n));
const moisLabel = (iso: string) => {
  const [y, m] = iso.split("-");
  return new Date(+y, +m - 1, 1).toLocaleDateString("fr-FR", { month: "short", year: "2-digit" });
};

// ─── Types internes ────────────────────────────────────────────────────────────
interface VenteBrute {
  date_vente: string;
  ca_ttc: number;
  commission_oci: number;
  univers: string;
  agence: string | null;
  profile_id: string | null;
  nom_commercial?: string;
}

interface KpiUnivers { name: string; ca: number; comm: number; nb: number; color: string; }
interface KpiAgence  { name: string; ca: number; comm: number; nb: number; }
interface KpiAgent   { name: string; ca: number; comm: number; nb: number; }
interface LigneMois  { mois: string; label: string; ca: number; comm: number; nb: number; }

// ─── Sous-composants ──────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = C.orange, dark = false }: {
  label: string; value: string | number; sub?: string; color?: string; dark?: boolean;
}) {
  return (
    <div className={`rounded-xl p-4 flex flex-col gap-1 ${dark ? "bg-slate-900 text-white" : "bg-white border border-slate-200"}`}>
      <div className={`text-xs ${dark ? "text-slate-400" : "text-slate-500"}`}>{label}</div>
      <div className={`text-xl font-semibold ${dark ? "text-white" : "text-slate-900"}`} style={dark ? {} : { color }}>
        {value}
      </div>
      {sub && <div className={`text-xs ${dark ? "text-slate-400" : "text-slate-400"}`}>{sub}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">{children}</div>
  );
}

function TooltipCA({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs shadow-sm">
      <div className="text-slate-400 mb-1">{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.color }} className="font-semibold">
          {p.name} : {fmtN(p.value)} F
        </div>
      ))}
    </div>
  );
}

// ─── Composant principal ──────────────────────────────────────────────────────
export default function Dashboard({ profile }: Props) {
  const [ventes, setVentes] = useState<VenteBrute[]>([]);
  const [loading, setLoading] = useState(true);
  const [moisOffset, setMoisOffset] = useState(0); // 0 = mois courant

  // Période sélectionnée
  const periodeDebut = useMemo(() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - moisOffset);
    return d.toISOString().slice(0, 10);
  }, [moisOffset]);

  const periodeFin = useMemo(() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - moisOffset + 1);
    return d.toISOString().slice(0, 10);
  }, [moisOffset]);

  const periodeLabel = useMemo(() => {
    return new Date(periodeDebut).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  }, [periodeDebut]);

  // Chargement ventes — 12 mois glissants pour l'historique
  useEffect(() => {
    async function charger() {
      setLoading(true);
      const debut12 = new Date();
      debut12.setDate(1);
      debut12.setMonth(debut12.getMonth() - 11);

      let query = supabase
        .from("sales")
        .select(`
          date_vente, ca_ttc, commission_oci, univers, agence, profile_id,
          profiles ( nom )
        `)
        .in("statut", ["validee", "en_attente_oci"])
        .eq("est_avoir", false)
        .gte("date_vente", debut12.toISOString().slice(0, 10))
        .order("date_vente", { ascending: true });

      // Filtre commercial — ne voit que ses propres ventes
      if (profile.role === "commercial") {
        query = query.eq("profile_id", profile.id);
      }

      const { data } = await query;
      const rows = (data ?? []).map((v: any) => ({
        ...v,
        ca_ttc: v.ca_ttc || 0,
        commission_oci: v.commission_oci || 0,
        nom_commercial: v.profiles?.nom ?? "—",
      }));
      setVentes(rows);
      setLoading(false);
    }
    charger();
  }, [profile.id, profile.role]);

  // ── Ventes de la période sélectionnée ──────────────────────────────────────
  const ventesPeriode = useMemo(
    () => ventes.filter(v => v.date_vente >= periodeDebut && v.date_vente < periodeFin),
    [ventes, periodeDebut, periodeFin]
  );

  // ── KPIs globaux ────────────────────────────────────────────────────────────
  const totalCA   = ventesPeriode.reduce((s, v) => s + v.ca_ttc, 0);
  const totalComm = ventesPeriode.reduce((s, v) => s + v.commission_oci, 0);
  const nbVentes  = ventesPeriode.length;
  const tauxObj   = OBJECTIF_EQUIPE.TOTAL > 0 ? Math.round((totalCA / OBJECTIF_EQUIPE.TOTAL) * 100) : 0;

  // ── Par univers ─────────────────────────────────────────────────────────────
  const byUnivers = useMemo<KpiUnivers[]>(() => {
    const map: Record<string, KpiUnivers> = {};
    ventesPeriode.forEach(v => {
      const u = v.univers || "AUTRES";
      if (!map[u]) map[u] = { name: u, ca: 0, comm: 0, nb: 0, color: UNIVERS_COLORS[u] || C.muted };
      map[u].ca += v.ca_ttc;
      map[u].comm += v.commission_oci;
      map[u].nb += 1;
    });
    return Object.values(map).sort((a, b) => b.ca - a.ca);
  }, [ventesPeriode]);

  // ── Par agence ──────────────────────────────────────────────────────────────
  const byAgence = useMemo<KpiAgence[]>(() => {
    const map: Record<string, KpiAgence> = {};
    ventesPeriode.forEach(v => {
      const a = v.agence || "Non assignée";
      if (!map[a]) map[a] = { name: a, ca: 0, comm: 0, nb: 0 };
      map[a].ca += v.ca_ttc;
      map[a].comm += v.commission_oci;
      map[a].nb += 1;
    });
    return Object.values(map).sort((a, b) => b.ca - a.ca);
  }, [ventesPeriode]);

  // ── Par commercial ──────────────────────────────────────────────────────────
  const byAgent = useMemo<KpiAgent[]>(() => {
    const map: Record<string, KpiAgent> = {};
    ventesPeriode.forEach(v => {
      const nom = v.nom_commercial || "—";
      if (!map[nom]) map[nom] = { name: nom.split(" ")[0], ca: 0, comm: 0, nb: 0 };
      map[nom].ca += v.ca_ttc;
      map[nom].comm += v.commission_oci;
      map[nom].nb += 1;
    });
    return Object.values(map).sort((a, b) => b.ca - a.ca).slice(0, 10);
  }, [ventesPeriode]);

  // ── Historique 12 mois ──────────────────────────────────────────────────────
  const historique = useMemo<LigneMois[]>(() => {
    const map: Record<string, LigneMois> = {};
    ventes.forEach(v => {
      const m = v.date_vente.slice(0, 7);
      if (!map[m]) map[m] = { mois: m, label: moisLabel(m), ca: 0, comm: 0, nb: 0 };
      map[m].ca += v.ca_ttc;
      map[m].comm += v.commission_oci;
      map[m].nb += 1;
    });
    return Object.values(map).sort((a, b) => a.mois.localeCompare(b.mois));
  }, [ventes]);

  if (loading) {
    return <div className="p-8 text-sm text-slate-400">Chargement...</div>;
  }

  const isAdmin = ["admin", "dg"].includes(profile.role);

  return (
    <div className="p-6 max-w-5xl space-y-6">

      {/* ── En-tête + sélecteur de mois ─────────────────────────────────── */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-0.5 capitalize">{periodeLabel}</p>
          <h1 className="text-2xl font-semibold text-slate-900">
            {profile.role === "commercial"
              ? `Bonjour, ${profile.nom.split(" ")[0]}`
              : profile.role === "dg" ? "Tableau de bord DG"
              : "Vue d'ensemble"}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMoisOffset(o => o + 1)}
            className="px-3 py-1.5 text-xs border border-slate-200 rounded-md text-slate-600 hover:bg-slate-50"
          >← mois préc.</button>
          <span className="text-xs font-medium text-slate-700 px-2 capitalize">{periodeLabel}</span>
          <button
            onClick={() => setMoisOffset(o => Math.max(0, o - 1))}
            disabled={moisOffset === 0}
            className="px-3 py-1.5 text-xs border border-slate-200 rounded-md text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >mois suiv. →</button>
        </div>
      </div>

      {/* ── KPIs ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="CA TTC" value={fmt(totalCA) + " F"} sub={`HT ≈ ${fmt(Math.round(totalCA / 1.18))} F`} dark />
        <KpiCard label="Commission OCI" value={fmt(totalComm) + " F"} sub={`${nbVentes} vente(s)`} color={C.blue} />
        <KpiCard
          label="Objectif équipe"
          value={tauxObj + "%"}
          sub={`/ ${fmt(OBJECTIF_EQUIPE.TOTAL)} F`}
          color={tauxObj >= 100 ? C.green : tauxObj >= 70 ? C.yellow : C.red}
        />
        <KpiCard label="Univers actifs" value={byUnivers.length} sub={byUnivers.map(u => u.name).join(" · ")} color={C.purple} />
      </div>

      {/* ── Graphe évolution + Répartition univers ───────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Évolution 12 mois */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5">
          <SectionTitle>Évolution CA mensuel</SectionTitle>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={historique} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="gCA" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.orange} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={C.orange} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gComm" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.blue} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={C.blue} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
              <XAxis dataKey="label" tick={{ fill: C.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} tickLine={false} axisLine={false}
                tickFormatter={v => fmt(v)} width={48} />
              <Tooltip content={<TooltipCA />} />
              <Area type="monotone" dataKey="ca" name="CA TTC"
                stroke={C.orange} strokeWidth={2} fill="url(#gCA)" />
              <Area type="monotone" dataKey="comm" name="Commission OCI"
                stroke={C.blue} strokeWidth={1.5} fill="url(#gComm)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Répartition univers */}
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <SectionTitle>Répartition univers</SectionTitle>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie data={byUnivers} cx="50%" cy="50%" innerRadius={42} outerRadius={68}
                paddingAngle={3} dataKey="ca">
                {byUnivers.map((e, i) => <Cell key={i} fill={e.color} />)}
              </Pie>
              <Tooltip formatter={(v: number) => [fmtN(v) + " F", "CA"]}
                contentStyle={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 8, fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="space-y-2 mt-1">
            {byUnivers.map(u => (
              <div key={u.name} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-sm" style={{ background: u.color }} />
                  <span className="text-slate-500">{u.name}</span>
                </div>
                <div className="text-right">
                  <span className="font-semibold text-slate-800">{fmt(u.ca)} F</span>
                  {isAdmin && (
                    <span className="text-slate-400 ml-1">
                      ({OBJECTIF_EQUIPE[u.name]
                        ? Math.round((u.ca / OBJECTIF_EQUIPE[u.name]) * 100) + "%"
                        : "—"})
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Top commerciaux + CA agences ──────────────────────────────────── */}
      {isAdmin && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Commerciaux */}
          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5">
            <SectionTitle>CA &amp; Commissions par commercial</SectionTitle>
            <ResponsiveContainer width="100%" height={Math.max(180, byAgent.length * 34)}>
              <BarChart data={byAgent} layout="vertical" margin={{ left: 70, right: 12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" horizontal={false} />
                <XAxis type="number" tick={{ fill: C.muted, fontSize: 9 }} tickLine={false}
                  axisLine={false} tickFormatter={v => fmt(v)} />
                <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 10 }}
                  tickLine={false} axisLine={false} width={70} />
                <Tooltip content={<TooltipCA />} />
                <Bar dataKey="ca" name="CA TTC" fill={C.orange} radius={[0, 3, 3, 0]} />
                <Bar dataKey="comm" name="Commission" fill={C.blue} fillOpacity={0.7}
                  radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
            {/* Tableau synthétique */}
            <div className="mt-4 pt-3 border-t border-slate-100">
              <div className="grid text-xs" style={{ gridTemplateColumns: "1fr auto auto auto" }}>
                <span className="text-slate-400 font-bold uppercase tracking-wide text-[10px]">Commercial</span>
                <span className="text-slate-400 font-bold uppercase tracking-wide text-[10px] text-right pr-3">Ventes</span>
                <span className="text-slate-400 font-bold uppercase tracking-wide text-[10px] text-right pr-3">CA TTC</span>
                <span className="text-slate-400 font-bold uppercase tracking-wide text-[10px] text-right">Commission</span>
                {byAgent.map((a, i) => (
                  <>
                    <div key={`n${i}`} className="py-1.5 border-t border-slate-50 text-slate-700 font-medium">{a.name}</div>
                    <div key={`v${i}`} className="py-1.5 border-t border-slate-50 text-slate-400 text-right pr-3">{a.nb}</div>
                    <div key={`c${i}`} className="py-1.5 border-t border-slate-50 text-right pr-3 font-semibold" style={{ color: C.orange }}>{fmt(a.ca)} F</div>
                    <div key={`o${i}`} className="py-1.5 border-t border-slate-50 text-right font-bold" style={{ color: C.blue }}>{fmt(a.comm)} F</div>
                  </>
                ))}
                <div className="py-2 border-t-2 border-slate-200 text-slate-900 font-bold text-[11px]">TOTAL</div>
                <div className="py-2 border-t-2 border-slate-200 text-right pr-3 text-slate-500 font-semibold">{byAgent.reduce((s, a) => s + a.nb, 0)}</div>
                <div className="py-2 border-t-2 border-slate-200 text-right pr-3 font-bold text-[11px]" style={{ color: C.orange }}>{fmt(byAgent.reduce((s, a) => s + a.ca, 0))} F</div>
                <div className="py-2 border-t-2 border-slate-200 text-right font-bold text-[11px]" style={{ color: C.blue }}>{fmt(byAgent.reduce((s, a) => s + a.comm, 0))} F</div>
              </div>
            </div>
          </div>

          {/* CA par agence */}
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <SectionTitle>CA par agence</SectionTitle>
            <div className="space-y-4">
              {byAgence.map((a, i) => (
                <div key={a.name}>
                  <div className="flex justify-between mb-1">
                    <span className="text-xs font-medium text-slate-700 truncate max-w-[120px]" title={a.name}>
                      {a.name.replace("Angré ", "")}
                    </span>
                    <span className="text-xs font-bold" style={{ color: C.orange }}>{fmt(a.ca)} F</span>
                  </div>
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${totalCA > 0 ? Math.round((a.ca / totalCA) * 100) : 0}%`,
                        background: AGENCE_COLORS[i % AGENCE_COLORS.length],
                      }}
                    />
                  </div>
                  <div className="flex justify-between mt-0.5 text-[10px] text-slate-400">
                    <span>{a.nb} vente(s)</span>
                    <span style={{ color: C.blue }}>{fmt(a.comm)} F comm.</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Tableau historique par mois ────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h2 className="text-sm font-medium text-slate-900">Historique mensuel</h2>
        </div>
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-100 bg-slate-50">
              <th className="px-5 py-2 font-medium">Mois</th>
              <th className="px-5 py-2 font-medium text-right">Ventes</th>
              <th className="px-5 py-2 font-medium text-right">CA TTC</th>
              <th className="px-5 py-2 font-medium text-right">Commission OCI</th>
              {isAdmin && <th className="px-5 py-2 font-medium text-right">Obj. %</th>}
            </tr>
          </thead>
          <tbody>
            {[...historique].reverse().map((h, i) => {
              const objPct = Math.round((h.ca / OBJECTIF_EQUIPE.TOTAL) * 100);
              const isCourant = h.mois === periodeDebut.slice(0, 7);
              return (
                <tr key={h.mois} className={`border-b border-slate-50 ${isCourant ? "bg-orange-50" : ""}`}>
                  <td className="px-5 py-2.5 text-slate-700 capitalize font-medium">
                    {new Date(h.mois + "-01").toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}
                    {isCourant && <span className="ml-2 text-xs text-orange-400">(en cours)</span>}
                  </td>
                  <td className="px-5 py-2.5 text-slate-500 text-right">{h.nb}</td>
                  <td className="px-5 py-2.5 text-right font-semibold text-slate-900">
                    {fmtN(h.ca)} F
                  </td>
                  <td className="px-5 py-2.5 text-right text-slate-600">
                    {fmtN(h.comm)} F
                  </td>
                  {isAdmin && (
                    <td className="px-5 py-2.5 text-right">
                      <span className={`text-xs font-bold ${objPct >= 100 ? "text-green-600" : objPct >= 70 ? "text-amber-500" : "text-red-400"}`}>
                        {objPct}%
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
