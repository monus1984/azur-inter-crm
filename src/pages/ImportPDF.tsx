import { useState, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../lib/supabase";
import { deviserUnivers } from "../lib/univers";
import type { Profile } from "../types/database";
import type { ReçuExtrait } from "./pdf-ocr.worker";

interface Props { profile: Profile; }
type Onglet = "scan_pdf" | "ventes_excel" | "oci_excel";

// ─── Mapping opérateur → login_oci ────────────────────────────────────────────

const OPERATEUR_TO_LOGIN: Record<string, string> = {
  "LINDA ANANI":"c_lamani","ANANI LINDA":"c_lamani",
  "SYRA AIDARA":"c_saidara","AIDARA SYRA":"c_saidara",
  "HABIBATA BANHORO":"c_hbanhoro","BANHORO HABIBATA":"c_hbanhoro",
  "BAKAYOKO MAX":"c_lbakayoko1",
  "NANTENIN BANHORO":"c_nbanhoroep","BANHORO NANTENIN":"c_nbanhoroep",
  "CELESTE BONNY":"c_cbonny","BONNY CELESTE":"c_cbonny",
  "MABOUTE FATIGA":"c_afatiga","FATIGA MABOUTE":"c_afatiga",
  "HADJA SAYON DIAKITE":"c_sdiakite","DIAKITE HADJA SAYON":"c_sdiakite",
  "JEANNETTE N'DRI":"c_jndri1","N'DRI JEANNETTE":"c_jndri1",
  "DORCASSE GUIBILIHONON":"c_dguibiliho","GUIBILIHONON DORCASSE":"c_dguibiliho",
  "HERVE AMOA":"c_hamoa","AMOA HERVE":"c_hamoa","AMOA HERVÉ":"c_hamoa",
  "SAUL ATTAYE":"c_sattaye","ATTAYE SAUL":"c_sattaye",
  "NADEGE KOUASSI":"c_fkouassi5","KOUASSI NADEGE":"c_fkouassi5",
  "KOUASSI NADÈGE-FLORE":"c_fkouassi5",
  "KEVIN ATTO":"c_ratto","ATTO KEVIN":"c_ratto",
  "AYEKO AGBARO":"c_kagbaro","AGBARO AYEKO":"c_kagbaro",
  "HAMADOU DRAMERA":"c_hdramera","DRAMERA HAMADOU":"c_hdramera",
  "JADE SENDZE":"c_jsendze","SENDZE JADE":"c_jsendze",
  "ANABELLE KOFFI":"c_akoffi4","KOFFI ANABELLE":"c_akoffi4",
}

// ─── Types locaux ──────────────────────────────────────────────────────────────

interface LigneRevue extends ReçuExtrait {
  selected: boolean
  page_source: number
  profile_id: string | null
  confiance: "haute" | "moyenne" | "faible"
}

// ─── Sous-composant : Import Scan PDF ─────────────────────────────────────────

function ImportScanPDF({ profile }: { profile: Profile }) {
  const fileRef  = useRef<HTMLInputElement>(null)
  const workerRef = useRef<Worker | null>(null)

  const [step, setStep]       = useState<"idle"|"processing"|"review"|"done">("idle")
  const [progress, setProgress] = useState({ label: "", pct: 0 })
  const [lignes, setLignes]   = useState<LigneRevue[]>([])
  const [saving, setSaving]   = useState(false)
  const [resultats, setResultats] = useState({ reçus: 0, lignes: 0, erreurs: 0 })
  const [loginToId, setLoginToId] = useState<Record<string,string>>({})

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return

    // Charger les profils
    const { data: profils } = await supabase
      .from("profiles")
      .select("id, login_oci")
      .eq("actif", true)
      .eq("role", "commercial")
    const ltoi: Record<string,string> = {}
    ;(profils ?? []).forEach((p: any) => { if (p.login_oci) ltoi[p.login_oci] = p.id })
    setLoginToId(ltoi)

    setStep("processing")
    setLignes([])
    setProgress({ label: "Démarrage...", pct: 1 })

    // Lire les ArrayBuffer (avant de les passer au worker)
    const fileData = await Promise.all(
      files.map(async f => ({ name: f.name, buffer: await f.arrayBuffer() }))
    )

    // Créer le Web Worker
    if (workerRef.current) workerRef.current.terminate()
    const worker = new Worker(
      new URL("./pdf-ocr.worker.ts", import.meta.url),
      { type: "module" }
    )
    workerRef.current = worker

    const accumulées: LigneRevue[] = []

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data

      if (msg.type === "PROGRESS") {
        setProgress({ label: msg.label, pct: msg.pct })
      }

      if (msg.type === "PAGE_DONE") {
        if (msg.result) {
          const reçu: ReçuExtrait = msg.result
          const nom = reçu.operateur.toUpperCase().trim()
          const login = OPERATEUR_TO_LOGIN[nom] ||
            Object.entries(OPERATEUR_TO_LOGIN).find(([k]) =>
              nom.includes(k) || k.includes(nom)
            )?.[1] || null
          const pid = login ? ltoi[login] || null : null

          const confiance: "haute" | "moyenne" | "faible" =
            reçu.erreurs.length === 0 && pid ? "haute" :
            reçu.erreurs.length <= 1 ? "moyenne" : "faible"

          const ligne: LigneRevue = {
            ...reçu,
            profile_id: pid,
            confiance,
            selected: confiance !== "faible",
            page_source: msg.page,
          }
          accumulées.push(ligne)
          // Mise à jour progressive
          setLignes([...accumulées])
        }
      }

      if (msg.type === "DONE") {
        setStep("review")
        worker.terminate()
        workerRef.current = null
      }

      if (msg.type === "ERROR") {
        console.error("Worker error:", msg.message)
        setStep("review")
        worker.terminate()
        workerRef.current = null
      }
    }

    worker.onerror = (err) => {
      console.error("Worker crash:", err)
      setStep("review")
    }

    // Envoyer les fichiers au worker
    // Les ArrayBuffer sont transférés (zero-copy) au worker
    worker.postMessage(
      { type: "PROCESS_FILES", files: fileData },
      fileData.map(f => f.buffer)
    )

    if (fileRef.current) fileRef.current.value = ""
  }

  function annuler() {
    workerRef.current?.terminate()
    workerRef.current = null
    setStep("idle")
    setLignes([])
  }

  function toggleLigne(i: number) {
    setLignes(p => p.map((l, j) => j === i ? { ...l, selected: !l.selected } : l))
  }
  function updateLigne(i: number, field: string, value: any) {
    setLignes(p => p.map((l, j) => j === i ? { ...l, [field]: value } : l))
  }

  async function inserer() {
    const sel = lignes.filter(l => l.selected)
    if (!sel.length) return
    setSaving(true)

    let reçus = 0, lignesIns = 0, erreurs = 0

    for (const l of sel) {
      const statut = l.profile_id && l.n_facture && l.n_journal ? "validee" : "en_attente_oci"

      const rows = l.articles.length > 0
        ? l.articles.map(a => ({
            profile_id:     l.profile_id,
            date_vente:     l.date_vente || null,
            agence:         l.agence_site || "—",
            univers:        deviserUnivers(a.libelle),
            offre:          a.libelle,
            client:         l.client,
            quantite:       a.quantite,
            prix_unitaire:  a.prix_unitaire,
            ca_ttc:         a.total,
            commission_oci: 0, points: 0, prime: 0,
            n_facture:      l.n_facture || null,
            n_journal:      l.n_journal || null,
            n_client:       l.n_client || null,
            mode_paiement:  l.mode_paiement,
            statut,
            est_avoir:      l.est_avoir,
            libelle_source: "pdf_scan",
            cree_par:       profile.id,
          }))
        : [{
            profile_id:     l.profile_id,
            date_vente:     l.date_vente || null,
            agence:         l.agence_site || "—",
            univers:        "AUTRES" as const,
            offre:          "Voir reçu PDF",
            client:         l.client,
            quantite:       1,
            prix_unitaire:  l.montant_total,
            ca_ttc:         l.montant_total,
            commission_oci: 0, points: 0, prime: 0,
            n_facture:      l.n_facture || null,
            n_journal:      l.n_journal || null,
            n_client:       l.n_client || null,
            mode_paiement:  l.mode_paiement,
            statut,
            est_avoir:      l.est_avoir,
            libelle_source: "pdf_scan",
            cree_par:       profile.id,
          }]

      const { error } = await supabase.from("sales").insert(rows)
      if (error) { erreurs++; console.error(l.n_facture, error.message) }
      else { reçus++; lignesIns += rows.length }
    }

    setResultats({ reçus, lignes: lignesIns, erreurs })
    setStep("done")
    setSaving(false)
  }

  const badge = (c: "haute"|"moyenne"|"faible") => {
    const s = { haute:"bg-green-100 text-green-700", moyenne:"bg-amber-100 text-amber-700", faible:"bg-red-100 text-red-700" }
    return <span className={`text-xs px-2 py-0.5 rounded-full ${s[c]}`}>{c}</span>
  }

  // ── Idle ──────────────────────────────────────────────────────────────────────
  if (step === "idle") return (
    <div>
      <p className="text-sm text-slate-500 mb-4">
        Reçus OCI scannés au format PDF. L'OCR tourne dans un <strong>thread arrière-plan</strong> —
        tu peux changer d'onglet ou naviguer, le traitement continue.
      </p>
      <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-slate-400 transition-colors">
        <span className="text-3xl mb-2">🔍</span>
        <span className="text-sm font-medium text-slate-700 mb-1">Choisir les PDF scannés</span>
        <span className="text-xs text-slate-400">.pdf · plusieurs fichiers autorisés</span>
        <input ref={fileRef} type="file" accept=".pdf" multiple onChange={handleFiles} className="hidden" />
      </label>
      <div className="mt-4 bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-blue-700 space-y-1">
        <p>• Chaque page = un reçu · multi-articles gérés → une ligne par article</p>
        <p>• <strong>Thread séparé</strong> : le traitement ne s'arrête pas si tu navigues</p>
        <p>• <strong>Zéro appel externe</strong> : OCR 100% local (Tesseract.js)</p>
        <p>• Révision des données avant toute insertion en base</p>
      </div>
    </div>
  )

  // ── Processing ────────────────────────────────────────────────────────────────
  if (step === "processing") return (
    <div className="py-6">
      <div className="text-center mb-5">
        <div className="text-3xl mb-2">🔍</div>
        <p className="text-sm font-medium text-slate-800">{progress.label}</p>
        <p className="text-xs text-slate-400 mt-0.5">Tu peux naviguer — le traitement continue en arrière-plan</p>
      </div>
      <div className="max-w-sm mx-auto mb-4">
        <div className="bg-slate-100 rounded-full h-2.5 overflow-hidden">
          <div className="bg-slate-800 h-full rounded-full transition-all duration-300"
            style={{ width: `${progress.pct}%` }} />
        </div>
        <div className="flex justify-between text-xs text-slate-400 mt-1">
          <span>OCR local · 0 token</span>
          <span>{progress.pct}%</span>
        </div>
      </div>

      {/* Résultats partiels en temps réel */}
      {lignes.length > 0 && (
        <div className="max-w-sm mx-auto">
          <p className="text-xs text-slate-500 mb-2">{lignes.length} reçu(s) analysé(s) jusqu'ici :</p>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {lignes.map((l, i) => (
              <div key={i} className="flex items-center gap-2 text-xs bg-white border border-slate-100 rounded px-2 py-1">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${l.confiance==="haute"?"bg-green-400":l.confiance==="moyenne"?"bg-amber-400":"bg-red-400"}`} />
                <span className="font-mono text-slate-600 flex-shrink-0">{l.n_facture || "—"}</span>
                <span className="text-slate-400 truncate">{l.operateur || "opérateur inconnu"}</span>
                <span className="text-slate-300 ml-auto flex-shrink-0">p.{l.page_source}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-center mt-4">
        <button onClick={annuler} className="text-xs text-slate-400 underline">Annuler</button>
      </div>
    </div>
  )

  // ── Done ──────────────────────────────────────────────────────────────────────
  if (step === "done") return (
    <div className="text-center py-8">
      <div className="text-3xl mb-3">✅</div>
      <p className="text-base font-semibold text-slate-900 mb-1">Import terminé</p>
      <div className="flex justify-center gap-6 mb-5">
        <div><div className="text-2xl font-bold text-green-600">{resultats.reçus}</div><div className="text-xs text-slate-400">reçus</div></div>
        <div><div className="text-2xl font-bold text-blue-600">{resultats.lignes}</div><div className="text-xs text-slate-400">lignes créées</div></div>
        {resultats.erreurs > 0 && <div><div className="text-2xl font-bold text-red-500">{resultats.erreurs}</div><div className="text-xs text-slate-400">erreurs</div></div>}
      </div>
      <button onClick={() => { setStep("idle"); setLignes([]) }}
        className="text-sm text-slate-600 underline">Importer d'autres PDF</button>
    </div>
  )

  // ── Review ────────────────────────────────────────────────────────────────────
  const nbSel      = lignes.filter(l => l.selected).length
  const nbLignes   = lignes.filter(l => l.selected).reduce((s, l) => s + Math.max(l.articles.length, 1), 0)
  const nbHaute    = lignes.filter(l => l.confiance === "haute").length
  const nbMoyenne  = lignes.filter(l => l.confiance === "moyenne").length
  const nbFaible   = lignes.filter(l => l.confiance === "faible").length

  return (
    <div>
      {/* Résumé extraction */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{lignes.length} reçu(s) extrait(s)</p>
          <div className="flex gap-3 text-xs mt-0.5">
            <span className="text-green-600">✓ {nbHaute} haute</span>
            <span className="text-amber-600">~ {nbMoyenne} moyenne</span>
            {nbFaible > 0 && <span className="text-red-500">✗ {nbFaible} faible</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setLignes(p => p.map(l => ({ ...l, selected: true })))}
            className="text-xs text-slate-500 underline">Tout cocher</button>
          <button onClick={() => setLignes(p => p.map(l => ({ ...l, selected: false })))}
            className="text-xs text-slate-500 underline">Tout décocher</button>
        </div>
      </div>

      <div className="space-y-3 max-h-[58vh] overflow-y-auto mb-4 pr-1">
        {lignes.map((l, i) => (
          <div key={i} className={`border rounded-lg p-4 transition-opacity ${l.selected ? "border-slate-300" : "border-slate-100 opacity-50"}`}>
            <div className="flex items-start gap-3">
              <input type="checkbox" checked={l.selected} onChange={() => toggleLigne(i)} className="mt-1 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                {/* En-tête */}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="font-mono text-sm font-semibold text-slate-800">{l.n_facture || "N° manquant"}</span>
                  <span className="text-xs text-slate-400">J.{l.n_journal || "—"}</span>
                  {badge(l.confiance)}
                  {l.est_avoir && <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">AVOIR</span>}
                  <span className="ml-auto text-xs text-slate-300">p.{l.page_source}</span>
                </div>

                {/* Champs éditables */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5">Date</label>
                    <input type="date" value={l.date_vente}
                      onChange={e => updateLigne(i, "date_vente", e.target.value)}
                      className="w-full border border-slate-200 rounded px-2 py-1 text-xs" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5">Opérateur</label>
                    <input type="text" value={l.operateur}
                      onChange={e => updateLigne(i, "operateur", e.target.value)}
                      className={`w-full border rounded px-2 py-1 text-xs ${!l.profile_id ? "border-amber-300 bg-amber-50" : "border-slate-200"}`} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5">Agence</label>
                    <input type="text" value={l.agence_site}
                      onChange={e => updateLigne(i, "agence_site", e.target.value)}
                      className="w-full border border-slate-200 rounded px-2 py-1 text-xs" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5">Total TTC</label>
                    <p className="text-sm font-bold text-slate-900 px-2 py-1">
                      {l.montant_total.toLocaleString("fr-FR")} F
                    </p>
                  </div>
                </div>

                {/* Articles */}
                {l.articles.length > 0 ? (
                  <div className="bg-slate-50 rounded-md p-2 mb-2">
                    <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wide mb-1">
                      {l.articles.length} article(s) → {l.articles.length} ligne(s) dans sales
                    </p>
                    {l.articles.map((a, j) => (
                      <div key={j} className="flex gap-2 text-xs items-center py-1 border-b border-slate-100 last:border-0">
                        <span className="flex-1 text-slate-700 truncate" title={a.libelle}>{a.libelle}</span>
                        <span className="text-slate-400 flex-shrink-0">× {a.quantite}</span>
                        <span className="text-slate-400 flex-shrink-0">{a.prix_unitaire.toLocaleString("fr-FR")} F</span>
                        <span className="font-semibold text-slate-800 w-24 text-right flex-shrink-0">
                          {a.total.toLocaleString("fr-FR")} F
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="bg-amber-50 border border-amber-100 rounded px-2 py-1 text-xs text-amber-700 mb-2">
                    ⚠ Articles non extraits — 1 ligne à {l.montant_total.toLocaleString("fr-FR")} F sera créée
                  </div>
                )}

                {l.client && (
                  <p className="text-xs text-slate-400">
                    Client : {l.client}{l.n_client ? ` · N° ${l.n_client}` : ""}
                  </p>
                )}
                {l.erreurs.length > 0 && (
                  <p className="text-xs text-amber-600 mt-1">⚠ {l.erreurs.join(" · ")}</p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-3 items-center">
        <button onClick={annuler}
          className="px-4 py-2 text-sm border border-slate-300 rounded-md text-slate-600 hover:bg-slate-50">
          Annuler
        </button>
        <button onClick={inserer} disabled={saving || nbSel === 0}
          className="px-4 py-2 text-sm bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50">
          {saving ? "Insertion..." : `Insérer ${nbSel} reçu(s) → ${nbLignes} ligne(s)`}
        </button>
      </div>
    </div>
  )
}

// ─── Sous-composant : Import Ventes Excel ─────────────────────────────────────

function ImportVentesExcel({ profile }: { profile: Profile }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [log, setLog]     = useState<string[]>([])
  const [status, setStatus] = useState<"idle"|"loading"|"done"|"error">("idle")
  const [stats, setStats]  = useState<{inseres:number;doublons:number;incomplets:number}|null>(null)
  const addLog = (m: string) => setLog(p => [...p, m])

  const NOM_TO_LOGIN: Record<string,string> = {
    "AIDARA SYRA":"c_saidara","BANHORO HABIBATA":"c_hbanhoro","BAKAYOKO MAX":"c_lbakayoko1",
    "BANHORO NANTENIN":"c_nbanhoroep","ANANI LINDA":"c_lamani","BONNY CELESTE":"c_cbonny",
    "FATIGA MABOUTE":"c_afatiga","DIAKITE HADJA SAYON":"c_sdiakite","N'DRI JEANNETTE":"c_jndri1",
    "GUIBILIHONON DORCASSE":"c_dguibiliho","AMOA HERVÉ":"c_hamoa","ATTAYE SAUL":"c_sattaye",
    "KOUASSI NADÈGE-FLORE":"c_fkouassi5","ATTO KEVIN":"c_ratto","AGBARO AYEKO":"c_kagbaro",
    "DRAMERA HAMADOU":"c_hdramera","SENDZE JADE":"c_jsendze","KOFFI ANABELLE":"c_akoffi4",
  }

  function normUnivers(r: string) {
    const u = (r||"").toUpperCase()
    if (/INTERNET|FIBRE|4G|FTTH|FLYBOX|EASYBOX/.test(u)) return "INTERNET"
    if (/MOBILE|MIX|SMS|COMMUNITY|START LITE/.test(u)) return "MOBILE"
    if (/ICT|EASY OFFICE|MSSP|BAAS/.test(u)) return "ICT"
    if (/FIXE|VOIX/.test(u)) return "FIXE"
    return "AUTRES"
  }

  function parseDate(v: unknown): string|null {
    if (!v) return null
    if (typeof v==="number") { const d=new Date(Math.round((v-25569)*86400*1000)); return isNaN(d.getTime())?null:d.toISOString().split("T")[0] }
    const m=String(v).match(/(\d{4})-(\d{2})-(\d{2})/); return m?`${m[1]}-${m[2]}-${m[3]}`:null
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files??[]); if (!files.length) return
    setStatus("loading"); setLog([]); setStats(null)
    try {
      const { data: pr } = await supabase.from("profiles").select("id,login_oci").not("login_oci","is",null)
      const ltoi: Record<string,string> = {}
      ;(pr??[]).forEach((p:any)=>{ if(p.login_oci) ltoi[p.login_oci]=p.id })
      addLog(`${Object.keys(ltoi).length} commerciaux en base`)
      let rows: any[] = []
      for (const f of files) {
        addLog(`📄 ${f.name}`)
        const wb = XLSX.read(await f.arrayBuffer(),{type:"array"})
        const sn = wb.SheetNames.find(n=>n.toLowerCase().includes("ventes")||n.toLowerCase().includes("données"))
        if (!sn) { addLog("   ⚠ Feuille introuvable"); continue }
        const rs = XLSX.utils.sheet_to_json(wb.Sheets[sn],{defval:null}) as any[]
        let skip=0
        for (const r of rs) {
          const dv=parseDate(r["Date"]); if(!dv){skip++;continue}
          const nom=String(r["Commercial"]??"").trim().toUpperCase()
          const login=NOM_TO_LOGIN[nom]
          const pid=login?ltoi[login]:null
          const nf=String(r["N° Reçu-Facture"]??"").trim()||null
          const nj=String(r["N° Journal"]??"").trim()
          const ca=parseFloat(String(r["CA TTC (XOF)"]??r["Prix TTC (XOF)"]??0))
          const jv=/^\d+$/.test(nj)
          rows.push({profile_id:pid??"00000000-0000-0000-0000-000000000020",date_vente:dv,
            agence:String(r["Agence"]??"").trim()||null,univers:normUnivers(String(r["Univers"]??r["Offre / Libellé"]??"")),
            offre:String(r["Offre / Libellé"]??"").trim()||"Inconnu",client:String(r["Client"]??"").trim()||null,
            quantite:parseInt(String(r["Qté"]??1),10),prix_unitaire:parseFloat(String(r["Prix TTC (XOF)"]??0)),
            ca_ttc:ca,commission_oci:parseFloat(String(r["Comm. OCI HT (XOF)"]??0)),
            points:0,prime:0,n_facture:nf,n_journal:jv?nj:null,
            n_client:String(r["N° Client"]??"").trim()||null,
            mode_paiement:String(r["Mode Paiement"]??"").trim()||null,
            statut:pid&&nf&&jv?"validee":"en_attente_oci",est_avoir:ca<0,
            libelle_source:"excel_ventes",cree_par:profile.id,
            _k:`${nf}|${String(r["Offre / Libellé"]??"").trim()}|${ca}`})
        }
        addLog(`   → ${rs.length-skip} lignes (${skip} sans date)`)
      }
      const vus=new Set<string>()
      rows=rows.filter(r=>{if(vus.has(r._k))return false;vus.add(r._k);return true})
      addLog(`Après déduplication : ${rows.length}`)
      const nfs=[...new Set(rows.map(r=>r.n_facture).filter(Boolean))]
      let doublons=0
      if(nfs.length){
        const{data:ex}=await supabase.from("sales").select("n_facture,offre,ca_ttc").in("n_facture",nfs as string[])
        const cb=new Set((ex??[]).map((e:any)=>`${e.n_facture}|${e.offre}|${e.ca_ttc}`))
        const av=rows.length; rows=rows.filter(r=>!cb.has(r._k)); doublons=av-rows.length
        if(doublons) addLog(`⚠ ${doublons} doublons exclus`)
      }
      if(!rows.length){addLog("⚠ Tout déjà en base");setStatus("done");setStats({inseres:0,doublons,incomplets:0});return}
      const ins=rows.map(({_k,...r})=>r)
      const inc=ins.filter((r:any)=>r.statut==="en_attente_oci").length
      addLog(`À insérer : ${ins.length} (${inc} en attente)`)
      for(let i=0;i<Math.ceil(ins.length/200);i++){
        const{error}=await supabase.from("sales").insert(ins.slice(i*200,(i+1)*200))
        if(error) throw new Error(error.message)
        addLog(`  Lot ${i+1} — OK`)
      }
      setStats({inseres:ins.length,doublons,incomplets:inc})
      addLog(`✅ ${ins.length} ventes insérées`)
      setStatus("done")
    } catch(err:any){addLog(`❌ ${err.message}`);setStatus("error")}
    finally{if(fileRef.current)fileRef.current.value=""}
  }

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">
        Fichier : <code className="bg-slate-100 px-1 rounded">AZUR_INTER_Ventes_Justificatif_OCI_*.xlsx</code>
        {" "} — Feuille : <strong>Données ventes AZUR</strong>
      </p>
      <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-slate-400 mb-4">
        <span className="text-2xl mb-2">📂</span>
        <span className="text-sm font-medium text-slate-700">Choisir fichier(s) Excel</span>
        <span className="text-xs text-slate-400">sélection multiple</span>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple onChange={handleFiles} className="hidden" disabled={status==="loading"}/>
      </label>
      {status!=="idle"&&<div className={`text-xs px-3 py-2 rounded-md mb-3 font-medium ${status==="loading"?"bg-blue-50 text-blue-700":status==="done"?"bg-green-50 text-green-700":"bg-red-50 text-red-700"}`}>{status==="loading"?"⏳ En cours…":status==="done"?"✅ Terminé":"❌ Erreur"}</div>}
      {stats&&<div className="grid grid-cols-3 gap-3 mb-4">{[["insérées",stats.inseres,"green"],["en attente OCI",stats.incomplets,"amber"],["doublons exclus",stats.doublons,"slate"]].map(([l,n,c])=><div key={String(l)} className={`bg-${c}-50 rounded-lg p-3 text-center`}><div className={`text-lg font-bold text-${c}-700`}>{n}</div><div className={`text-xs text-${c}-600`}>{l}</div></div>)}</div>}
      {log.length>0&&<div className="bg-slate-900 text-slate-300 rounded-lg p-3 font-mono text-xs max-h-40 overflow-y-auto">{log.map((l,i)=><div key={i} style={{color:l.startsWith("✅")?"#4ade80":l.startsWith("❌")?"#f87171":l.startsWith("⚠")?"#fbbf24":undefined}}>{l}</div>)}</div>}
    </div>
  )
}

// ─── Sous-composant : Import Rapport OCI Excel ────────────────────────────────

function ImportOCIExcel({ profile }: { profile: Profile }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [log, setLog]       = useState<string[]>([])
  const [status, setStatus] = useState<"idle"|"loading"|"done"|"error">("idle")
  const addLog = (m: string) => setLog(p => [...p, m])

  function parseDate(v: unknown): string|null {
    if (!v) return null
    if (typeof v==="number"){const d=new Date(Math.round((v-25569)*86400*1000));return isNaN(d.getTime())?null:d.toISOString().split("T")[0]}
    const m=String(v).match(/(\d{4})-(\d{2})-(\d{2})/);return m?`${m[1]}-${m[2]}-${m[3]}`:null
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files=Array.from(e.target.files??[]);if(!files.length)return
    setStatus("loading");setLog([])
    try {
      let tx: any[]=[]
      for(const file of files){
        addLog(`📄 ${file.name}`)
        const wb=XLSX.read(await file.arrayBuffer(),{type:"array"})
        addLog(`  Feuilles : ${wb.SheetNames.join(", ")}`)
        for(const sn of["Base FTTH","Base Backlog"]){
          const sh=wb.Sheets[sn];if(!sh)continue
          const rs=XLSX.utils.sheet_to_json(sh,{defval:null})as any[]
          addLog(`  ${sn} : ${rs.length}`)
          for(const r of rs){const d=parseDate(r["date_creation_dossier"]);tx.push({ref_externe:String(r["contratclient"]??r["id_dossier"]??"").trim()||null,source:sn==="Base Backlog"?"FTTH_BACKLOG":"FTTH",date_transaction:d,mois:d?.substring(0,7)||null,offre:String(r["offer"]??r["produit"]??"").trim()||null,agence:String(r["pointvente"]??"").trim()||null,login_oci:String(r["Login"]??r["login"]??r["usercrea"]??"").trim()||null,client:String(r["nomclient"]??"").trim()||null,univers:"INTERNET",quantite:1,prix_ttc:parseFloat(String(r["Récurrent"]??0))||null,commission_oci:null,statut_oci:String(r["statut"]??"").trim()||null,n_facture:String(r["rscoptiquepb"]??"").trim()||null,n_journal:null,remarque:String(r["motif"]??r["etape"]??"").trim()||null,fichier_source:sn,importe_par:profile.id})}
        }
        const s4=wb.Sheets["Base 4G"];if(s4){const rs=XLSX.utils.sheet_to_json(s4,{defval:null})as any[];addLog(`  Base 4G : ${rs.length}`);for(const r of rs){const d=parseDate(r["date_facture"]??r["date_jour"]);tx.push({ref_externe:String(r["numero_facture"]??"").trim()||null,source:"4G",date_transaction:d,mois:d?.substring(0,7)||null,offre:String(r["offre"]??"").trim()||null,agence:String(r["code_agence"]??"").trim()||null,login_oci:String(r["Login"]??r["user_name"]??"").trim()||null,client:String(r["customer_name"]??"").trim()||null,univers:"INTERNET",quantite:1,prix_ttc:parseFloat(String(r["montant_facture"]??0))||null,commission_oci:null,statut_oci:"installe",n_facture:String(r["numero_facture"]??"").trim()||null,n_journal:String(r["numero_recu"]??"").trim()||null,remarque:null,fichier_source:"Base 4G",importe_par:profile.id})}}
        const sm=wb.Sheets["Mobile NTS"];if(sm){const rs=XLSX.utils.sheet_to_json(sm,{defval:null})as any[];addLog(`  Mobile NTS : ${rs.length}`);for(const r of rs){const d=parseDate(r["Date de transaction"]??r["Date comptable"]);tx.push({ref_externe:String(r["N< Facture mensuelle/Initiale"]??r["Numéro du journal"]??"").trim()||null,source:"MOBILE",date_transaction:d,mois:d?.substring(0,7)||null,offre:String(r["Offres"]??r["Nom article"]??"").trim()||null,agence:String(r["Nom Agence"]??"").trim()||null,login_oci:String(r["Login utilisateur"]??"").trim()||null,client:String(r["Nom Client"]??"").trim()||null,univers:"MOBILE",quantite:parseInt(String(r["Quantité "]??r["Quantite"]??1),10),prix_ttc:parseFloat(String(r["Prix unitaire"]??0))||null,commission_oci:parseFloat(String(r["Commissions"]??0))||null,statut_oci:"installe",n_facture:String(r["N< Facture mensuelle/Initiale"]??"").trim()||null,n_journal:String(r["Numéro du journal"]??"").trim()||null,remarque:null,fichier_source:"Mobile NTS",importe_par:profile.id})}}
      }
      addLog(`Total : ${tx.length}`)
      if(!tx.length)throw new Error("Aucune donnée")
      for(let i=0;i<Math.ceil(tx.length/200);i++){
        const{error}=await supabase.from("oci_transactions").insert(tx.slice(i*200,(i+1)*200))
        if(error)throw new Error(error.message)
        addLog(`  Lot ${i+1} OK`)
      }
      addLog(`✅ ${tx.length} transactions insérées`);setStatus("done")
    }catch(err:any){addLog(`❌ ${err.message}`);setStatus("error")}
    finally{if(fileRef.current)fileRef.current.value=""}
  }

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">
        Fichier : <code className="bg-slate-100 px-1 rounded">OCI_DISTRI_OSS_AZUR_INTER_*.xlsx</code>
        {" "} — Feuilles : Base FTTH · Base Backlog · Base 4G · Mobile NTS
      </p>
      <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-slate-400 mb-4">
        <span className="text-2xl mb-2">📡</span>
        <span className="text-sm font-medium text-slate-700">Choisir rapport(s) OCI</span>
        <span className="text-xs text-slate-400">sélection multiple</span>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple onChange={handleFiles} className="hidden" disabled={status==="loading"}/>
      </label>
      {status!=="idle"&&<div className={`text-xs px-3 py-2 rounded-md mb-3 font-medium ${status==="loading"?"bg-blue-50 text-blue-700":status==="done"?"bg-green-50 text-green-700":"bg-red-50 text-red-700"}`}>{status==="loading"?"⏳ En cours…":status==="done"?"✅ Terminé":"❌ Erreur"}</div>}
      {log.length>0&&<div className="bg-slate-900 text-slate-300 rounded-lg p-3 font-mono text-xs max-h-40 overflow-y-auto">{log.map((l,i)=><div key={i} style={{color:l.startsWith("✅")?"#4ade80":l.startsWith("❌")?"#f87171":undefined}}>{l}</div>)}</div>}
    </div>
  )
}

// ─── Composant principal ──────────────────────────────────────────────────────

export default function ImportPDF({ profile }: Props) {
  const [onglet, setOnglet] = useState<Onglet>("scan_pdf")
  const tabs = [
    { key: "scan_pdf"     as Onglet, label: "🔍 Scan PDF" },
    { key: "ventes_excel" as Onglet, label: "📋 Ventes Excel" },
    { key: "oci_excel"    as Onglet, label: "📡 Rapport OCI" },
  ]
  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Import de données</h1>
      <p className="text-sm text-slate-500 mb-5">Reçus PDF scannés · Justificatif Excel · Rapport OCI Distri</p>
      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setOnglet(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${onglet===t.key?"bg-white border border-b-white border-slate-200 text-slate-900 -mb-px":"text-slate-500 hover:text-slate-700"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {onglet === "scan_pdf"     && <ImportScanPDF profile={profile} />}
      {onglet === "ventes_excel" && <ImportVentesExcel profile={profile} />}
      {onglet === "oci_excel"    && <ImportOCIExcel profile={profile} />}
    </div>
  )
}
