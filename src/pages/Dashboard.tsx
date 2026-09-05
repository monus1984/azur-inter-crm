import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Profile, Sale } from "../types/database";

interface Props {
  profile: Profile;
}

interface MonthTotal {
  mois: string;
  ca: number;
  comm: number;
  nb: number;
}

// Le Dashboard ne fait aucun filtrage par rôle en JS : il interroge la table
// "sales" telle quelle, et c'est le RLS côté Supabase qui décide ce que
// chaque rôle reçoit. Un commercial ne reçoit que ses lignes, même si le
// code ici est identique pour tous les rôles. C'est le point central du
// cloisonnement — voir schema_lot1.sql section 8.
export default function Dashboard({ profile }: Props) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    // Le superviseur n'a aucune politique de lecture sur la table sales —
    // uniquement sur la vue sales_superviseur, qui masque la prime. Un
    // commercial ou l'admin/DG lisent la table directement, filtrée par RLS.
    const source = profile.role === "superviseur" ? "sales_superviseur" : "sales";
    supabase
      .from(source)
      .select("*")
      .eq("est_avoir", false)
      .order("date_vente", { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          setError(error.message);
        } else {
          setSales((data ?? []) as Sale[]);
        }
        setLoading(false);
      });
  }, [profile.role]);

  const byMonth = sales.reduce<Record<string, MonthTotal>>((acc, s) => {
    const mois = s.date_vente.slice(0, 7);
    if (!acc[mois]) acc[mois] = { mois, ca: 0, comm: 0, nb: 0 };
    acc[mois].ca += s.ca_ttc || 0;
    acc[mois].comm += s.commission_oci || 0;
    acc[mois].nb += 1;
    return acc;
  }, {});

  const months = Object.values(byMonth).sort((a, b) => (a.mois < b.mois ? 1 : -1));

  if (loading) {
    return <div className="p-8 text-slate-500 text-sm">Chargement...</div>;
  }

  if (error) {
    return (
      <div className="p-8 text-red-600 text-sm">
        Erreur de chargement : {error}
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">
          Bonjour {profile.nom}
        </h1>
        <p className="text-sm text-slate-500">
          {profile.role === "commercial"
            ? "Vos ventes et commissions"
            : profile.role === "superviseur"
            ? "Performance de l'équipe — CA et commission OCI"
            : "Vue d'ensemble des ventes"}
        </p>
      </div>

      {months.length === 0 ? (
        <p className="text-sm text-slate-500">
          Aucune vente enregistrée pour le moment.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 pr-4 font-medium">Mois</th>
                <th className="py-2 pr-4 font-medium">Ventes</th>
                <th className="py-2 pr-4 font-medium">CA TTC</th>
                <th className="py-2 pr-4 font-medium">Commission OCI</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.mois} className="border-b border-slate-100">
                  <td className="py-2 pr-4 text-slate-900">{m.mois}</td>
                  <td className="py-2 pr-4 text-slate-700">{m.nb}</td>
                  <td className="py-2 pr-4 text-slate-700">
                    {m.ca.toLocaleString("fr-FR")} F
                  </td>
                  <td className="py-2 pr-4 text-slate-700">
                    {m.comm.toLocaleString("fr-FR")} F
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
