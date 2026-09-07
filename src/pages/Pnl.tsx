import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types/database";

interface Props {
  profile: Profile;
}

interface LignePnl {
  mois: string;
  revenus_commission_oci: number;
  charges_salaires: number;
  charges_diverses: number;
  resultat_net: number;
}

export default function Pnl({ profile }: Props) {
  const [lignes, setLignes] = useState<LignePnl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  if (profile.role !== "admin" && profile.role !== "dg") {
    return (
      <div className="p-8 text-slate-500 text-sm">
        Accès réservé à l'administrateur et à la direction générale.
      </div>
    );
  }

  useEffect(() => {
    supabase
      .from("pnl_mensuel")
      .select("*")
      .order("mois", { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          setError(error.message);
        } else {
          setLignes((data ?? []) as LignePnl[]);
        }
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="p-8 text-slate-500 text-sm">Chargement...</div>;
  if (error) return <div className="p-8 text-red-600 text-sm">Erreur : {error}</div>;

  // Seuls les mois avec une activité réelle (revenus OU charges déjà connus,
  // pas les mois futurs vides) comptent dans les totaux cumulés.
  const moisAvecActivite = lignes.filter(
    (l) => l.revenus_commission_oci > 0 || l.charges_salaires > 0
  );
  const totalRevenus = moisAvecActivite.reduce((s, l) => s + l.revenus_commission_oci, 0);
  const totalCharges = moisAvecActivite.reduce(
    (s, l) => s + l.charges_salaires + l.charges_diverses,
    0
  );
  const totalResultat = totalRevenus - totalCharges;

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">P&L — Compte de résultat</h1>
      <p className="text-sm text-slate-500 mb-6">
        Commission OCI perçue moins masse salariale et charges diverses, par mois.
      </p>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500 mb-1">Revenus cumulés</div>
          <div className="text-lg font-semibold text-slate-900">
            {totalRevenus.toLocaleString("fr-FR")} F
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500 mb-1">Charges cumulées</div>
          <div className="text-lg font-semibold text-slate-900">
            {totalCharges.toLocaleString("fr-FR")} F
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500 mb-1">Résultat net cumulé</div>
          <div
            className={`text-lg font-semibold ${
              totalResultat >= 0 ? "text-green-700" : "text-red-600"
            }`}
          >
            {totalResultat.toLocaleString("fr-FR")} F
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2 pr-4 font-medium">Mois</th>
              <th className="py-2 pr-4 font-medium">Revenus (commission OCI)</th>
              <th className="py-2 pr-4 font-medium">Charges salaires</th>
              <th className="py-2 pr-4 font-medium">Charges diverses</th>
              <th className="py-2 pr-4 font-medium">Résultat net</th>
            </tr>
          </thead>
          <tbody>
            {lignes.map((l) => {
              const vide = l.revenus_commission_oci === 0 && l.charges_salaires === 0;
              return (
                <tr key={l.mois} className={`border-b border-slate-100 ${vide ? "opacity-40" : ""}`}>
                  <td className="py-2 pr-4 text-slate-900 font-medium capitalize">
                    {new Date(l.mois).toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}
                  </td>
                  <td className="py-2 pr-4 text-slate-700">
                    {l.revenus_commission_oci.toLocaleString("fr-FR")} F
                  </td>
                  <td className="py-2 pr-4 text-slate-700">
                    {l.charges_salaires.toLocaleString("fr-FR")} F
                  </td>
                  <td className="py-2 pr-4 text-slate-700">
                    {l.charges_diverses.toLocaleString("fr-FR")} F
                  </td>
                  <td
                    className={`py-2 pr-4 font-medium ${
                      l.resultat_net >= 0 ? "text-green-700" : "text-red-600"
                    }`}
                  >
                    {l.resultat_net.toLocaleString("fr-FR")} F
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400 mt-6">
        Les mois estompés n'ont ni vente ni charge enregistrée (mois futurs ou hors historique).
        Les primes commerciales sont déjà comprises dans la commission OCI (elles en sont un
        pourcentage), pas comptées séparément. Charges diverses = loyer d'agence et autres frais
        fixes, à alimenter au fur et à mesure — vide pour l'instant.
      </p>
    </div>
  );
}
