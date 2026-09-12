import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types/database";

interface Props { profile: Profile; }

// ─── Types ────────────────────────────────────────────────────────────────────

interface LigneMois {
  mois: string;
  // AZUR (source 1 — nos factures)
  azur_nb: number;
  azur_ca: number;
  azur_comm: number;
  // OCI Distri (source 2 — rapport partenaire)
  oci_nb: number;
  oci_ca: number;
  // Écarts
  ecart_nb: number;
  ecart_ca: number;
  // Couverture OCI disponible ?
  oci_dispo: boolean;
}

interface DetailUnivers {
  univers: string;
  azur_nb: number;
  azur_ca: number;
  oci_nb: number;
  oci_ca: number;
}

interface DetailAgent {
  nom: string;
  login_oci: string | null;
  azur_nb: number;
  azur_ca: number;
  oci_nb: number;
  oci_ca: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt  = (n: number) => new Intl.NumberFormat("fr-FR").format(Math.round(n));
const fmtM = (n: number) => n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1000 ? (n/1000).toFixed(0)+"K" : String(Math.round(n));

function moisLabel(iso: string) {
  const [y, m] = iso.split("-");
  return new Date(+y, +m - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

function derniersMois(n: number): string[] {
  const mois: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    mois.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return mois;
}

function ecartBadge(ecart: number, ociDispo: boolean) {
  if (!ociDispo) return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">OCI en attente</span>
  );
  if (Math.abs(ecart) < 50000) return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">≈ équilibré</span>
  );
  if (ecart > 0) return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">AZUR &gt; OCI</span>
  );
  return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">OCI &gt; AZUR</span>
  );
}

// ─── Composant ────────────────────────────────────────────────────────────────

export default function Reconciliation({ profile }: Props) {
  const [lignesMois, setLignesMois] = useState<LigneMois[]>([]);
  const [moisChoisi, setMoisChoisi] = useState<string>("");
  const [detailUnivers, setDetailUnivers] = useState<DetailUnivers[]>([]);
  const [detailAgents, setDetailAgents] = useState<DetailAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const moisDisponibles = derniersMois(14);

  // ── Chargement vue mensuelle ────────────────────────────────────────────────
  useEffect(() => {
    async function charger() {
      setLoading(true);

      const debutHisto = `${new Date().getFullYear() - 1}-08-01`;

      const [{ data: azurData }, { data: ociData }] = await Promise.all([
        supabase
          .from("sales")
          .select("date_vente, ca_ttc, commission_oci, univers")
          .in("statut", ["validee", "en_attente_oci"])
          .eq("est_avoir", false)
          .gte("date_vente", debutHisto),
        supabase
          .from("oci_transactions")
          .select("mois, prix_ttc, source")
          .not("mois", "is", null),
      ]);

      // Agréger AZUR par mois
      const azurByMois: Record<string, { nb: number; ca: number; comm: number }> = {};
      (azurData ?? []).forEach((v: any) => {
        const m = (v.date_vente as string).slice(0, 7);
        if (!azurByMois[m]) azurByMois[m] = { nb: 0, ca: 0, comm: 0 };
        azurByMois[m].nb += 1;
        azurByMois[m].ca += Number(v.ca_ttc) || 0;
        azurByMois[m].comm += Number(v.commission_oci) || 0;
      });

      // Agréger OCI par mois
      const ociByMois: Record<string, { nb: number; ca: number }> = {};
      (ociData ?? []).forEach((o: any) => {
        const m = o.mois as string;
        if (!ociByMois[m]) ociByMois[m] = { nb: 0, ca: 0 };
        ociByMois[m].nb += 1;
        ociByMois[m].ca += Number(o.prix_ttc) || 0;
      });

      // Fusionner
      const tousLesMois = new Set([
        ...Object.keys(azurByMois),
        ...Object.keys(ociByMois),
      ]);

      const lignes: LigneMois[] = [...tousLesMois]
        .sort((a, b) => b.localeCompare(a))
        .map(mois => {
          const a = azurByMois[mois] ?? { nb: 0, ca: 0, comm: 0 };
          const o = ociByMois[mois] ?? { nb: 0, ca: 0 };
          return {
            mois,
            azur_nb: a.nb, azur_ca: a.ca, azur_comm: a.comm,
            oci_nb: o.nb, oci_ca: o.ca,
            ecart_nb: a.nb - o.nb,
            ecart_ca: a.ca - o.ca,
            oci_dispo: o.nb > 0,
          };
        });

      setLignesMois(lignes);
      // Sélectionner le mois le plus récent avec données OCI
      const premierAvecOci = lignes.find(l => l.oci_dispo);
      setMoisChoisi(premierAvecOci?.mois ?? lignes[0]?.mois ?? "");
      setLoading(false);
    }
    charger();
  }, []);

  // ── Chargement détail du mois sélectionné ──────────────────────────────────
  useEffect(() => {
    if (!moisChoisi) return;

    async function chargerDetail() {
      setLoadingDetail(true);

      const debutMois = `${moisChoisi}-01`;
      const finMois = (() => {
        const [y, m] = moisChoisi.split("-").map(Number);
        return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
      })();

      const [
        { data: azurVentes },
        { data: ociTx },
        { data: profils },
      ] = await Promise.all([
        supabase
          .from("sales")
          .select("univers, ca_ttc, commission_oci, profile_id")
          .in("statut", ["validee", "en_attente_oci"])
          .eq("est_avoir", false)
          .gte("date_vente", debutMois)
          .lt("date_vente", finMois),
        supabase
          .from("oci_transactions")
          .select("univers, prix_ttc, login_oci")
          .eq("mois", moisChoisi),
        supabase
          .from("profiles")
          .select("id, nom, login_oci")
          .eq("actif", true)
          .eq("role", "commercial"),
      ]);

      // Map profils
      const profilById  = new Map((profils ?? []).map((p: any) => [p.id, p]));
      const profilByLogin = new Map((profils ?? []).map((p: any) => [p.login_oci, p]));

      // Détail par univers
      const univAzur: Record<string, { nb: number; ca: number }> = {};
      (azurVentes ?? []).forEach((v: any) => {
        const u = v.univers || "AUTRES";
        if (!univAzur[u]) univAzur[u] = { nb: 0, ca: 0 };
        univAzur[u].nb += 1;
        univAzur[u].ca += Number(v.ca_ttc) || 0;
      });

      const univOci: Record<string, { nb: number; ca: number }> = {};
      (ociTx ?? []).forEach((o: any) => {
        const u = o.univers || "AUTRES";
        if (!univOci[u]) univOci[u] = { nb: 0, ca: 0 };
        univOci[u].nb += 1;
        univOci[u].ca += Number(o.prix_ttc) || 0;
      });

      const tousUnivers = new Set([...Object.keys(univAzur), ...Object.keys(univOci)]);
      setDetailUnivers([...tousUnivers].map(u => ({
        univers: u,
        azur_nb: univAzur[u]?.nb ?? 0,
        azur_ca: univAzur[u]?.ca ?? 0,
        oci_nb:  univOci[u]?.nb  ?? 0,
        oci_ca:  univOci[u]?.ca  ?? 0,
      })).sort((a, b) => b.azur_ca - a.azur_ca));

      // Détail par agent
      const agentAzur: Record<string, { nb: number; ca: number; nom: string; login: string | null }> = {};
      (azurVentes ?? []).forEach((v: any) => {
        const pid = v.profile_id || "?";
        const p = profilById.get(pid);
        const nom = p?.nom ?? "NON IDENTIFIÉ";
        if (!agentAzur[pid]) agentAzur[pid] = { nb: 0, ca: 0, nom, login: p?.login_oci ?? null };
        agentAzur[pid].nb += 1;
        agentAzur[pid].ca += Number(v.ca_ttc) || 0;
      });

      const agentOci: Record<string, { nb: number; ca: number }> = {};
      (ociTx ?? []).forEach((o: any) => {
        const login = o.login_oci || "?";
        if (!agentOci[login]) agentOci[login] = { nb: 0, ca: 0 };
        agentOci[login].nb += 1;
        agentOci[login].ca += Number(o.prix_ttc) || 0;
      });

      // Fusionner par agent
      const agentsSet = new Map<string, DetailAgent>();
      Object.values(agentAzur).forEach(a => {
        const key = a.nom;
        const ociLogin = a.login ?? "";
        const oci = agentOci[ociLogin] ?? { nb: 0, ca: 0 };
        agentsSet.set(key, {
          nom: a.nom,
          login_oci: a.login,
          azur_nb: a.nb,
          azur_ca: a.ca,
          oci_nb: oci.nb,
          oci_ca: oci.ca,
        });
      });

      setDetailAgents([...agentsSet.values()].sort((a, b) => b.azur_ca - a.azur_ca));
      setLoadingDetail(false);
    }

    chargerDetail();
  }, [moisChoisi]);

  // ── Rendu ──────────────────────────────────────────────────────────────────

  if (profile.role !== "admin" && profile.role !== "dg") {
    return <div className="p-8 text-slate-500 text-sm">Accès réservé à l'administrateur et à la direction générale.</div>;
  }

  const moisActif = lignesMois.find(l => l.mois === moisChoisi);

  return (
    <div className="p-6 max-w-5xl space-y-6">

      <div>
        <h1 className="text-xl font-semibold text-slate-900 mb-1">Réconciliation AZUR / OCI</h1>
        <p className="text-sm text-slate-500">
          Compare les ventes collectées par AZUR (source 1 — factures commerciaux) avec les transactions
          reconnues par OCI Distri (source 2 — rapport partenaire fin de mois).
          Les écarts sont normaux : OCI ne couvre que FTTH, 4G et Mobile ; ICT, Fixe et prépayé
          n'apparaissent pas dans le rapport OCI.
        </p>
      </div>

      {/* ── Tableau récapitulatif mensuel ─────────────────────────────────── */}
      {loading ? (
        <div className="text-sm text-slate-400">Chargement...</div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-900">Vue mensuelle</h2>
            <span className="text-xs text-slate-400">Cliquer sur un mois pour voir le détail</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-100 bg-slate-50">
                  <th className="px-4 py-2 font-medium">Mois</th>
                  <th className="px-4 py-2 font-medium text-right">Ventes AZUR</th>
                  <th className="px-4 py-2 font-medium text-right">CA AZUR</th>
                  <th className="px-4 py-2 font-medium text-right">Commission OCI</th>
                  <th className="px-4 py-2 font-medium text-right border-l border-slate-100">Transac. OCI</th>
                  <th className="px-4 py-2 font-medium text-right">CA OCI reconnu</th>
                  <th className="px-4 py-2 font-medium text-right">Écart CA</th>
                  <th className="px-4 py-2 font-medium">Statut</th>
                </tr>
              </thead>
              <tbody>
                {lignesMois.map(l => (
                  <tr
                    key={l.mois}
                    onClick={() => setMoisChoisi(l.mois)}
                    className={`border-b border-slate-50 cursor-pointer transition-colors ${
                      l.mois === moisChoisi
                        ? "bg-orange-50"
                        : "hover:bg-slate-50"
                    }`}
                  >
                    <td className="px-4 py-2.5 font-medium text-slate-800 capitalize">
                      {moisLabel(l.mois)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-600">{l.azur_nb}</td>
                    <td className="px-4 py-2.5 text-right font-semibold text-slate-900">{fmtM(l.azur_ca)} F</td>
                    <td className="px-4 py-2.5 text-right text-blue-600">{fmtM(l.azur_comm)} F</td>
                    <td className="px-4 py-2.5 text-right text-slate-500 border-l border-slate-100">
                      {l.oci_dispo ? l.oci_nb : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-500">
                      {l.oci_dispo ? fmtM(l.oci_ca) + " F" : "—"}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-medium ${
                      !l.oci_dispo ? "text-slate-300" :
                      Math.abs(l.ecart_ca) < 50000 ? "text-green-600" :
                      l.ecart_ca > 0 ? "text-amber-600" : "text-red-600"
                    }`}>
                      {l.oci_dispo ? (l.ecart_ca > 0 ? "+" : "") + fmtM(l.ecart_ca) + " F" : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      {ecartBadge(l.ecart_ca, l.oci_dispo)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Détail du mois sélectionné ────────────────────────────────────── */}
      {moisChoisi && (
        <div className="space-y-4">
          <h2 className="text-base font-semibold text-slate-900 capitalize">
            Détail — {moisLabel(moisChoisi)}
          </h2>

          {/* KPIs du mois */}
          {moisActif && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs text-slate-500 mb-1">Ventes AZUR</div>
                <div className="text-xl font-semibold text-slate-900">{moisActif.azur_nb}</div>
                <div className="text-xs text-slate-400 mt-0.5">{fmtM(moisActif.azur_ca)} F CA</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs text-slate-500 mb-1">Commission OCI perçue</div>
                <div className="text-xl font-semibold text-blue-600">{fmtM(moisActif.azur_comm)} F</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs text-slate-500 mb-1">Transactions OCI Distri</div>
                <div className="text-xl font-semibold text-slate-900">
                  {moisActif.oci_dispo ? moisActif.oci_nb : "—"}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {moisActif.oci_dispo ? fmtM(moisActif.oci_ca) + " F" : "rapport non chargé"}
                </div>
              </div>
              <div className={`rounded-xl p-4 border ${
                !moisActif.oci_dispo ? "bg-slate-50 border-slate-200" :
                Math.abs(moisActif.ecart_ca) < 50000 ? "bg-green-50 border-green-100" :
                "bg-amber-50 border-amber-100"
              }`}>
                <div className="text-xs text-slate-500 mb-1">Écart CA (AZUR − OCI)</div>
                <div className={`text-xl font-semibold ${
                  !moisActif.oci_dispo ? "text-slate-400" :
                  Math.abs(moisActif.ecart_ca) < 50000 ? "text-green-700" : "text-amber-700"
                }`}>
                  {moisActif.oci_dispo
                    ? (moisActif.ecart_ca > 0 ? "+" : "") + fmtM(moisActif.ecart_ca) + " F"
                    : "—"}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {!moisActif.oci_dispo ? "OCI non disponible" :
                   Math.abs(moisActif.ecart_ca) < 50000 ? "équilibré" :
                   moisActif.ecart_ca > 0 ? "AZUR non reconnu par OCI" : "OCI > AZUR"}
                </div>
              </div>
            </div>
          )}

          {loadingDetail ? (
            <div className="text-sm text-slate-400">Chargement du détail...</div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

              {/* Détail par univers */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-100">
                  <h3 className="text-sm font-medium text-slate-900">Par univers</h3>
                </div>
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-400 border-b border-slate-100 bg-slate-50">
                      <th className="px-4 py-2 font-medium">Univers</th>
                      <th className="px-4 py-2 font-medium text-right">AZUR nb</th>
                      <th className="px-4 py-2 font-medium text-right">AZUR CA</th>
                      <th className="px-4 py-2 font-medium text-right border-l border-slate-100">OCI nb</th>
                      <th className="px-4 py-2 font-medium text-right">OCI CA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailUnivers.map(u => (
                      <tr key={u.univers} className="border-b border-slate-50">
                        <td className="px-4 py-2 font-medium text-slate-700">{u.univers}</td>
                        <td className="px-4 py-2 text-right text-slate-500">{u.azur_nb}</td>
                        <td className="px-4 py-2 text-right font-semibold text-slate-800">{fmtM(u.azur_ca)} F</td>
                        <td className="px-4 py-2 text-right text-slate-400 border-l border-slate-100">
                          {u.oci_nb > 0 ? u.oci_nb : <span className="text-slate-200">—</span>}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-400">
                          {u.oci_ca > 0 ? fmtM(u.oci_ca) + " F" : <span className="text-slate-200">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-4 py-2 text-xs text-slate-400 bg-slate-50 border-t border-slate-100">
                  ICT, Fixe et prépayé ne remontent pas dans le rapport OCI Distri — écart normal.
                </div>
              </div>

              {/* Détail par agent */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-100">
                  <h3 className="text-sm font-medium text-slate-900">Par commercial</h3>
                </div>
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-400 border-b border-slate-100 bg-slate-50">
                      <th className="px-4 py-2 font-medium">Commercial</th>
                      <th className="px-4 py-2 font-medium text-right">AZUR CA</th>
                      <th className="px-4 py-2 font-medium text-right border-l border-slate-100">OCI CA</th>
                      <th className="px-4 py-2 font-medium text-right">Écart</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailAgents.map(a => {
                      const ecart = a.azur_ca - a.oci_ca;
                      return (
                        <tr key={a.nom} className="border-b border-slate-50">
                          <td className="px-4 py-2">
                            <div className="font-medium text-slate-700">{a.nom.split(" ")[0]}</div>
                            {a.login_oci && <div className="text-slate-400">{a.login_oci}</div>}
                          </td>
                          <td className="px-4 py-2 text-right font-semibold text-slate-800">{fmtM(a.azur_ca)} F</td>
                          <td className="px-4 py-2 text-right text-slate-400 border-l border-slate-100">
                            {a.oci_ca > 0 ? fmtM(a.oci_ca) + " F" : <span className="text-slate-200">—</span>}
                          </td>
                          <td className={`px-4 py-2 text-right font-medium ${
                            a.oci_ca === 0 ? "text-slate-300" :
                            Math.abs(ecart) < 20000 ? "text-green-600" :
                            ecart > 0 ? "text-amber-600" : "text-red-600"
                          }`}>
                            {a.oci_ca > 0
                              ? (ecart > 0 ? "+" : "") + fmtM(ecart) + " F"
                              : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
