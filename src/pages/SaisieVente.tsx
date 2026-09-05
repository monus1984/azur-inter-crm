import { useState, useEffect, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import type { Profile, UniversOffre } from "../types/database";

interface Props {
  profile: Profile;
  onSuccess?: () => void;
}

const OFFRES_PAR_UNIVERS: Record<UniversOffre, string[]> = {
  MOBILE: [
    "Business Mobile Mix 5",
    "Business Mobile Mix 10",
    "Business Mobile Mix 15",
    "Business Mobile Mix 30",
    "Business Mobile Mix 50",
    "Business Mobile Mix 100",
    "Business Mobile Mix 200",
    "Business Mobile Flex 30",
    "Business Mobile Flex 50",
    "B2B Kit community PAVI",
    "SMS Affaires",
  ],
  INTERNET: [
    "Fibre 50M",
    "Fibre 100M",
    "Fibre 200M",
    "Fibre 500M",
    "Fibre 1G",
    "PACK 4GH FLYBOX mini",
    "PACK 4GH FLYBOX standard",
    "Internet TopUp",
  ],
  ICT: [
    "Easy Office 49K",
    "Easy Office 59K",
    "Easy Office 109K",
    "YouScribe",
    "BaaS",
    "MSSP",
    "EDR",
  ],
  FIXE: ["Monoligne"],
  AUTRES: ["Autre"],
};

// Agences disponibles
const AGENCES = [
  "Angré 7ème Tranche",
  "Angré Djibi",
  "SmartStore",
  "Plateau Nord / Pyramide",
  "Adjamé Mosquée",
  "Adjamé 220 Logts",
  "Bassam",
];

export default function SaisieVente({ profile, onSuccess }: Props) {
  const [univers, setUnivers] = useState<UniversOffre>("MOBILE");
  const [offre, setOffre] = useState("");
  const [offreLibre, setOffreLibre] = useState("");
  const [client, setClient] = useState("");
  const [agence, setAgence] = useState(profile.agence_courante ?? AGENCES[0]);
  const [dateVente, setDateVente] = useState(new Date().toISOString().slice(0, 10));
  const [quantite, setQuantite] = useState(1);
  const [prixUnitaire, setPrixUnitaire] = useState("");
  const [nFacture, setNFacture] = useState("");
  const [nClient, setNClient] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset offre quand univers change
  useEffect(() => {
    setOffre(OFFRES_PAR_UNIVERS[univers][0]);
  }, [univers]);

  const offresDisponibles = OFFRES_PAR_UNIVERS[univers];
  const offreFinal = offre === "Autre" ? offreLibre : offre;
  const caTTC = quantite * (parseFloat(prixUnitaire) || 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!offreFinal) { setError("Veuillez préciser l'offre."); return; }
    if (caTTC <= 0) { setError("Le prix unitaire doit être supérieur à 0."); return; }

    setLoading(true);

    const { error: err } = await supabase.from("sales").insert({
      // profile_id n'est pas envoyé ici : le RLS l'impose à auth.uid()
      // Si le RLS ne le force pas encore, on l'envoie explicitement :
      profile_id: profile.id,
      date_vente: dateVente,
      agence,
      univers,
      offre: offreFinal,
      client: client || null,
      quantite,
      prix_unitaire: parseFloat(prixUnitaire) || 0,
      ca_ttc: caTTC,
      commission_oci: 0, // calculé lors de la validation
      points: 0,
      prime: 0,
      n_facture: nFacture || null,
      n_client: nClient || null,
      statut: "saisie",
      est_avoir: false,
      cree_par: profile.id,
    });

    if (err) {
      setError("Erreur lors de la saisie : " + err.message);
    } else {
      setSuccess(true);
      // Reset form
      setClient("");
      setNFacture("");
      setNClient("");
      setPrixUnitaire("");
      setQuantite(1);
      setTimeout(() => setSuccess(false), 3000);
      onSuccess?.();
    }
    setLoading(false);
  }

  return (
    <div className="p-8 max-w-xl">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Nouvelle vente</h1>
      <p className="text-sm text-slate-500 mb-6">
        La vente sera enregistrée à votre nom et soumise à validation.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">

        {/* Date */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Date de vente</label>
          <input
            type="date"
            required
            value={dateVente}
            onChange={e => setDateVente(e.target.value)}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
          />
        </div>

        {/* Agence */}
        {profile.role === "admin" && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Agence</label>
            <select
              value={agence}
              onChange={e => setAgence(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            >
              {AGENCES.map(a => <option key={a}>{a}</option>)}
            </select>
          </div>
        )}

        {/* Univers */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Univers</label>
          <div className="flex gap-2 flex-wrap">
            {(["MOBILE", "INTERNET", "ICT", "FIXE"] as UniversOffre[]).map(u => (
              <button
                key={u}
                type="button"
                onClick={() => setUnivers(u)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  univers === u
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-600 border-slate-300 hover:border-slate-500"
                }`}
              >
                {u}
              </button>
            ))}
          </div>
        </div>

        {/* Offre */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Offre</label>
          <select
            value={offre}
            onChange={e => setOffre(e.target.value)}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
          >
            {offresDisponibles.map(o => <option key={o}>{o}</option>)}
          </select>
          {offre === "Autre" && (
            <input
              type="text"
              placeholder="Préciser l'offre"
              value={offreLibre}
              onChange={e => setOffreLibre(e.target.value)}
              className="mt-2 w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
          )}
        </div>

        {/* Client */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Client</label>
          <input
            type="text"
            placeholder="Nom du client ou de l'entreprise"
            value={client}
            onChange={e => setClient(e.target.value)}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
          />
        </div>

        {/* Quantité + Prix */}
        <div className="flex gap-3">
          <div className="w-24">
            <label className="block text-sm font-medium text-slate-700 mb-1">Qté</label>
            <input
              type="number"
              min={1}
              required
              value={quantite}
              onChange={e => setQuantite(parseInt(e.target.value) || 1)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-700 mb-1">Prix unitaire TTC (F CFA)</label>
            <input
              type="number"
              min={0}
              required
              placeholder="ex: 21185"
              value={prixUnitaire}
              onChange={e => setPrixUnitaire(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
          </div>
        </div>

        {/* CA calculé */}
        {caTTC > 0 && (
          <div className="bg-slate-50 rounded-md px-4 py-3 text-sm">
            <span className="text-slate-500">CA TTC total : </span>
            <span className="font-semibold text-slate-900">
              {caTTC.toLocaleString("fr-FR")} F CFA
            </span>
          </div>
        )}

        {/* Références */}
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-700 mb-1">N° facture</label>
            <input
              type="text"
              placeholder="OCI-ANG.009.xxxxx"
              value={nFacture}
              onChange={e => setNFacture(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-700 mb-1">N° client</label>
            <input
              type="text"
              value={nClient}
              onChange={e => setNClient(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600" role="alert">{error}</p>
        )}

        {success && (
          <p className="text-sm text-green-600" role="status">
            Vente enregistrée. En attente de validation.
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-slate-900 text-white rounded-md py-2 text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? "Enregistrement..." : "Enregistrer la vente"}
        </button>
      </form>
    </div>
  );
}
