import { useEffect, useState, useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types/database";

interface Props { profile: Profile; }

const C = {
  orange: "#E85D00", blue: "#1A6FC4", green: "#0F9B6E",
  red: "#D93055", yellow: "#C98A00", purple: "#6D4FC4",
  text: "#1A2332", muted: "#6B7C8E",
};
const UNIVERS_COLORS: Record<string, string> = {
  INTERNET: C.blue, MOBILE: C.orange, ICT: C.purple,
  FIXE: C.green, AUTRES: C.muted,
};
const AGENCE_COLORS = [C.orange, C.blue, C.green, C.purple, C.yellow, C.red];
const OBJECTIF_EQUIPE_TOTAL = 12300000;
const OBJECTIF_UNIVERS: Record<string, number> = {
  INTERNET: 3000000, MOBILE: 7500000, ICT: 1500000, FIXE: 300000,
};

const fmt = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" :
  n >= 1000 ? (n / 1000).toFixed(0) + "K" :
  String(Math.round(n));
const fmtN = (n: number) => new Intl.NumberFormat("fr-FR").format(Math.round(n));
const moisLabel = (iso: string) => {
  const [y, m] = iso.split("-");
  return new Date(+y, +m - 1, 1).toLocaleDateString("fr-FR", { month: "short", year: "2-digit" });
};

interface VenteRow {
  date_vente: string;
  ca_ttc: number;
  commission_oci: number;
  univers: string;
  agence: string | null;
  profile_id: string | null;
}

function KpiCard({ label, value, sub, color = C.orange, dark = false }: {
  label: string; value: string | number; sub?: string; color?: string; dark?: boolean;
}) {
  return (
    <div className={`rounded-xl p-4 ${dark ? "bg-slate-900 text-white" : "bg-white border border-slate-200"}`}>
      <div className={`text-xs mb-1 ${dark ? "text-slate-400" : "text-slate-500"}`}>{label}</div>
      <div className={`text-xl font-semibold ${dark ? "text-white" : ""}`} style={dark ? {} : { color }}>
        {value}
      </div>
      {sub && <div className={`text-xs mt-0.5 ${dark ? "text-slate-400" : "text-slate-400"}`}>{sub}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">{children}</div>;
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

export default function Dashboard({ profile }: Props) {
  const [ventes, setVentes] = useState<VenteRow[]>([]);
  const [nomById, setNomById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  // Démarrer sur le dernier mois avec données (août 2026)
  // Septembre 2026 est en cours et peut être vide — on bascule automatiquement
  const [moisOffset, setMoisOffset] = useState(1);

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

  const periodeLabel = useMemo(() =>
    new Date(periodeDebut).toLocaleDateString("fr-FR", { month: "long", year: "numeric" }),
    [periodeDebut]
  );

  useEffect(() => {
    async function charger() {
      setLoading(true);

      // Date début : 12 mois glissants
      const debut12 = new Date();
      debut12.setDate(1);
      debut12.setMonth(debut12.getMonth() - 13); // 14 mois pour couvrir tout l'historique
      const debut12Iso = debut12.toISOString().slice(0, 10);

      // ── 1. Ventes (sans jointure profiles) ────────────────────────────────
      let q = supabase
        .from("sales")
        .select("date_vente, ca_ttc, commission_oci, univers, agence, profile_id")
        .in("statut", ["validee", "en_attente_oci"])
        .eq("est_avoir", false)
        .gte("date_vente", debut12Iso)
        .order("date_vente", { ascending: true })
        .limit(5000);

      if (profile.role === "commercial") {
        q = q.eq("profile_id", profile.id);
      }

      const { data: ventesData, error: errVentes } = await q;

      if (errVentes) {
        console.error("Dashboard erreur ventes:", errVentes.message);
        setLoading(false);
        return;
      }

      // ── 2. Profils (requête séparée) ───────────────────────────────────────
      const { data: profils } = await supabase
        .from("profiles")
        .select("id, nom")
        .eq("actif", true);

      const map = new Map<string, string>();
      (profils ?? []).forEach((p: { id: string; nom: string }) => map.set(p.id, p.nom));
      setNomById(map);

      setVentes(
        (ventesData ?? []).map((v: any) => ({
          ...v,
          ca_ttc: Number(v.ca_ttc) || 0,
          commission_oci: Number(v.commission_oci) || 0,
        }))
      );
      setLoading(false);
    }
    charger();
  }, [profile.id, profile.role]);

  // ── Ventes de la période ───────────────────────────────────────────────────
  const ventesPeriode = useMemo(
    () => ventes.filter(v => v.date_vente >= periodeDebut && v.date_vente < periodeFin),
    [ventes, periodeDebut, periodeFin]
  );

  const totalCA   = ventesPeriode.reduce((s, v) => s + v.ca_ttc, 0);
  const totalComm = ventesPeriode.reduce((s, v) => s + v.commission_oci, 0);
  const nbVentes  = ventesPeriode.length;
  const tauxObj   = OBJECTIF_EQUIPE_TOTAL > 0 ? Math.round((totalCA / OBJECTIF_EQUIPE_TOTAL) * 100) : 0;

  // ── Agrégats ───────────────────────────────────────────────────────────────
  const byUnivers = useMemo(() => {
    const map: Record<string, { ca: number; comm: number; nb: number }> = {};
    ventesPeriode.forEach(v => {
      const u = v.univers || "AUTRES";
      if (!map[u]) map[u] = { ca: 0, comm: 0, nb: 0 };
      map[u].ca += v.ca_ttc;
      map[u].comm += v.commission_oci;
      map[u].nb += 1;
    });
    return Object.entries(map)
      .map(([name, d]) => ({ name, ...d, color: UNIVERS_COLORS[name] || C.muted }))
      .sort((a, b) => b.ca - a.ca);
  }, [ventesPeriode]);

  const byAgence = useMemo(() => {
    const map: Record<string, { ca: number; comm: number; nb: number }> = {};
    ventesPeriode.forEach(v => {
      const a = v.agence || "Non assignée";
      if (!map[a]) map[a] = { ca: 0, comm: 0, nb: 0 };
      map[a].ca += v.ca_ttc;
      map[a].comm += v.commission_oci;
      map[a].nb += 1;
    });
    return Object.entries(map)
      .map(([name, d]) => ({ name, ...d }))
      .sort((a, b) => b.ca - a.ca);
  }, [ventesPeriode]);

  const byAgent = useMemo(() => {
    const map: Record<string, { nom: string; ca: number; comm: number; nb: number }> = {};
    ventesPeriode.forEach(v => {
      const pid = v.profile_id || "?";
      const nom = nomById.get(pid) || "NON IDENTIFIÉ";
      const key = pid;
      if (!map[key]) map[key] = { nom: nom.split(" ")[0], ca: 0, comm: 0, nb: 0 };
      map[key].ca += v.ca_ttc;
      map[key].comm += v.commission_oci;
      map[key].nb += 1;
    });
    return Object.values(map).sort((a, b) => b.ca - a.ca).slice(0, 10);
  }, [ventesPeriode, nomById]);

  const historique = useMemo(() => {
    const map: Record<string, { mois: string; label: string; ca: number; comm: number; nb: number }> = {};
    ventes.forEach(v => {
      const m = v.date_vente.slice(0, 7);
      if (!map[m]) map[m] = { mois: m, label: moisLabel(m), ca: 0, comm: 0, nb: 0 };
      map[m].ca += v.ca_ttc;
      map[m].comm += v.commission_oci;
      map[m].nb += 1;
    });
    return Object.values(map).sort((a, b) => a.mois.localeCompare(b.mois));
  }, [ventes]);

  const isAdmin = ["admin", "dg"].includes(profile.role);

  if (loading) return <div className="p-8 text-sm text-slate-400">Chargement...</div>;

  // Ne pas bloquer le rendu si le mois sélectionné est vide — l'historique reste visible

  return (
    <div className="p-6 max-w-5xl space-y-6">

      {/* En-tête + sélecteur mois */}
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
          <button onClick={() => setMoisOffset(o => o + 1)}
            className="px-3 py-1.5 text-xs border border-slate-200 rounded-md text-slate-600 hover:bg-slate-50">
            ← mois préc.
          </button>
          <span className="text-xs font-medium text-slate-700 px-2 capitalize">{periodeLabel}</span>
          <button onClick={() => setMoisOffset(o => Math.max(0, o - 1))}
            disabled={moisOffset === 0}
            className="px-3 py-1.5 text-xs border border-slate-200 rounded-md text-slate-600 hover:bg-slate-50 disabled:opacity-40">
            mois suiv. →
          </button>
        </div>
      </div>

      {/* KPIs */}
      {nbVentes === 0 && ventes.length > 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-sm text-slate-500">
          Aucune vente pour <span className="font-medium capitalize">{periodeLabel}</span> — navigue vers un mois précédent pour voir les données.
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="CA TTC" value={nbVentes > 0 ? fmt(totalCA) + " F" : "—"}
          sub={nbVentes > 0 ? `HT ≈ ${fmt(Math.round(totalCA / 1.18))} F` : periodeLabel} dark />
        <KpiCard label="Commission OCI" value={nbVentes > 0 ? fmt(totalComm) + " F" : "—"}
          sub={`${nbVentes} vente(s)`} color={C.blue} />
        <KpiCard label="Objectif équipe"
          value={nbVentes > 0 ? tauxObj + "%" : "—"}
          sub={`/ ${fmt(OBJECTIF_EQUIPE_TOTAL)} F`}
          color={tauxObj >= 100 ? C.green : tauxObj >= 70 ? C.yellow : C.red} />
        <KpiCard label="Univers actifs" value={byUnivers.length || "—"}
          sub={byUnivers.length > 0 ? byUnivers.map(u => u.name).join(" · ") : "aucune vente ce mois"} color={C.purple} />
      </div>

      {/* Graphe + Univers */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
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
              <Area type="monotone" dataKey="ca" name="CA TTC" stroke={C.orange} strokeWidth={2} fill="url(#gCA)" />
              <Area type="monotone" dataKey="comm" name="Commission OCI" stroke={C.blue} strokeWidth={1.5} fill="url(#gComm)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

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
                  {isAdmin && OBJECTIF_UNIVERS[u.name] && (
                    <span className="text-slate-400 ml-1">
                      ({Math.round((u.ca / OBJECTIF_UNIVERS[u.name]) * 100)}%)
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Commerciaux + Agences (admin/DG uniquement) */}
      {isAdmin && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5">
            <SectionTitle>CA &amp; Commissions par commercial</SectionTitle>
            <ResponsiveContainer width="100%" height={Math.max(180, byAgent.length * 34)}>
              <BarChart data={byAgent} layout="vertical" margin={{ left: 75, right: 12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" horizontal={false} />
                <XAxis type="number" tick={{ fill: C.muted, fontSize: 9 }} tickLine={false}
                  axisLine={false} tickFormatter={v => fmt(v)} />
                <YAxis type="category" dataKey="nom" tick={{ fill: C.text, fontSize: 10 }}
                  tickLine={false} axisLine={false} width={75} />
                <Tooltip content={<TooltipCA />} />
                <Bar dataKey="ca" name="CA TTC" fill={C.orange} radius={[0, 3, 3, 0]} />
                <Bar dataKey="comm" name="Commission" fill={C.blue} fillOpacity={0.7} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
            {/* Tableau synthétique */}
            <div className="mt-4 pt-3 border-t border-slate-100 text-xs">
              <div className="grid gap-x-4" style={{ gridTemplateColumns: "1fr auto auto auto" }}>
                {["Commercial","Ventes","CA TTC","Commission"].map(h => (
                  <span key={h} className="text-slate-400 font-bold uppercase tracking-wide text-[10px] pb-1 text-right first:text-left">{h}</span>
                ))}
                {byAgent.map((a, i) => (
                  <>
                    <div key={`n${i}`} className="py-1.5 border-t border-slate-50 text-slate-700 font-medium">{a.nom}</div>
                    <div key={`v${i}`} className="py-1.5 border-t border-slate-50 text-slate-400 text-right">{a.nb}</div>
                    <div key={`c${i}`} className="py-1.5 border-t border-slate-50 text-right font-semibold" style={{ color: C.orange }}>{fmt(a.ca)} F</div>
                    <div key={`o${i}`} className="py-1.5 border-t border-slate-50 text-right font-bold" style={{ color: C.blue }}>{fmt(a.comm)} F</div>
                  </>
                ))}
                <div className="py-2 border-t-2 border-slate-200 font-bold text-[11px]">TOTAL</div>
                <div className="py-2 border-t-2 border-slate-200 text-right text-slate-500 font-semibold">{byAgent.reduce((s,a)=>s+a.nb,0)}</div>
                <div className="py-2 border-t-2 border-slate-200 text-right font-bold text-[11px]" style={{ color: C.orange }}>{fmt(byAgent.reduce((s,a)=>s+a.ca,0))} F</div>
                <div className="py-2 border-t-2 border-slate-200 text-right font-bold text-[11px]" style={{ color: C.blue }}>{fmt(byAgent.reduce((s,a)=>s+a.comm,0))} F</div>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <SectionTitle>CA par agence</SectionTitle>
            <div className="space-y-4">
              {byAgence.map((a, i) => (
                <div key={a.name}>
                  <div className="flex justify-between mb-1">
                    <span className="text-xs font-medium text-slate-700 truncate max-w-[130px]" title={a.name}>
                      {a.name.replace("Angré ", "")}
                    </span>
                    <span className="text-xs font-bold" style={{ color: C.orange }}>{fmt(a.ca)} F</span>
                  </div>
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{
                      width: `${totalCA > 0 ? Math.round((a.ca / totalCA) * 100) : 0}%`,
                      background: AGENCE_COLORS[i % AGENCE_COLORS.length],
                    }} />
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

      {/* Historique */}
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
              const objPct = Math.round((h.ca / OBJECTIF_EQUIPE_TOTAL) * 100);
              const isCourant = h.mois === periodeDebut.slice(0, 7);
              return (
                <tr key={h.mois} className={`border-b border-slate-50 ${isCourant ? "bg-orange-50" : ""}`}>
                  <td className="px-5 py-2.5 text-slate-700 capitalize font-medium">
                    {new Date(h.mois + "-01").toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}
                    {isCourant && <span className="ml-2 text-xs text-orange-400">(en cours)</span>}
                  </td>
                  <td className="px-5 py-2.5 text-slate-500 text-right">{h.nb}</td>
                  <td className="px-5 py-2.5 text-right font-semibold text-slate-900">{fmtN(h.ca)} F</td>
                  <td className="px-5 py-2.5 text-right text-slate-600">{fmtN(h.comm)} F</td>
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
