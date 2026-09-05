import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Profile, Sale } from "../types/database";

interface Props {
  profile: Profile;
}

export default function Ventes({ profile }: Props) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Le superviseur n'a pas de politique de lecture sur la table sales
    // directement — seulement sur sales_superviseur, qui masque la prime.
    const source = profile.role === "superviseur" ? "sales_superviseur" : "sales";
    supabase
      .from(source)
      .select("*")
      .order("date_vente", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        setSales((data ?? []) as Sale[]);
        setLoading(false);
      });
  }, [profile.role]);

  if (loading) {
    return <div className="p-8 text-slate-500 text-sm">Chargement...</div>;
  }

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-slate-900 mb-6">Ventes</h1>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2 pr-4 font-medium">Date</th>
              <th className="py-2 pr-4 font-medium">Agence</th>
              <th className="py-2 pr-4 font-medium">Offre</th>
              <th className="py-2 pr-4 font-medium">CA TTC</th>
              <th className="py-2 pr-4 font-medium">Statut</th>
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr key={s.id} className="border-b border-slate-100">
                <td className="py-2 pr-4 text-slate-700">{s.date_vente ?? "—"}</td>
                <td className="py-2 pr-4 text-slate-700">{s.agence}</td>
                <td className="py-2 pr-4 text-slate-700">{s.offre}</td>
                <td className="py-2 pr-4 text-slate-700">
                  {s.ca_ttc.toLocaleString("fr-FR")} F
                </td>
                <td className="py-2 pr-4">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    {s.statut}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
