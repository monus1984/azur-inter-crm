// pdf-ocr.worker.ts
// Tourne dans un thread séparé — ne bloque jamais le thread principal
// PDF.js + Tesseract.js chargés ici uniquement

// ─── Types de messages ─────────────────────────────────────────────────────────

type WorkerInput =
  | { type: "PROCESS_FILES"; files: { name: string; buffer: ArrayBuffer }[] }

type WorkerOutput =
  | { type: "PROGRESS"; label: string; pct: number }
  | { type: "PAGE_DONE"; page: number; total: number; result: ReçuExtrait | null }
  | { type: "ERROR"; message: string }
  | { type: "DONE"; total: number }

// ─── Types résultat ────────────────────────────────────────────────────────────

interface Article {
  libelle: string
  quantite: number
  prix_unitaire: number
  total: number
}

export interface ReçuExtrait {
  n_facture: string
  n_journal: string
  date_vente: string
  operateur: string
  site: string
  agence_site: string
  client: string | null
  n_client: string | null
  articles: Article[]
  montant_total: number
  est_avoir: boolean
  mode_paiement: string | null
  texte_brut: string
  erreurs: string[]
}

// ─── Mappings ──────────────────────────────────────────────────────────────────

const SITE_TO_AGENCE: Record<string, string> = {
  "OCI-SSA": "SmartStore",
  "OCI-ANT": "Angré 7ème Tranche",
  "OCI-AND": "Angré Djibi",
  "OCI-PLN": "Plateau Nord / Pyramide",
  "OCI-ADM": "Adjamé Mosquée",
  "OCI-AD2": "Adjamé 220 Logts",
  "OCI-BSM": "Bassam",
}

// ─── Parser texte OCR → données structurées ────────────────────────────────────

function parseMontant(s: string): number {
  return parseFloat(s.replace(/\s/g, "").replace(/\./g, "").replace(",", ".")) || 0
}

function parseDateFr(raw: string): string | null {
  const MOIS: Record<string, string> = {
    janvier:"01",fevrier:"02","février":"02",mars:"03",avril:"04",
    mai:"05",juin:"06",juillet:"07",aout:"08","août":"08",
    septembre:"09",octobre:"10",novembre:"11",decembre:"12","décembre":"12",
    // Erreurs OCR fréquentes
    aotit:"08",aofit:"08",
  }
  const m = raw.match(/(\d{1,2})[.\s]+(\w+)\s+(\d{4})/i)
  if (!m) return null
  const moisNum = MOIS[m[2].toLowerCase()]
  if (!moisNum) return null
  return `${m[3]}-${moisNum}-${m[1].padStart(2, "0")}`
}

function extraire(texte: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = texte.match(re)
    if (m?.[1]) return m[1].trim()
  }
  return null
}

function parserTexte(texte: string): ReçuExtrait {
  // Normalisation des erreurs OCR communes
  const t = texte
    .replace(/aotit|aofit/gi, "août")
    .replace(/Re[çc]u\s*[—-]\s*Facture/gi, "Reçu — Facture")
    .replace(/\bxor\b/gi, "XOF")

  const lignes = t.split("\n").map(l => l.trim()).filter(Boolean)

  // ── N° facture ──────────────────────────────────────────────────────────────
  const n_facture =
    extraire(t, [
      /N[°o]\s*re[çc]u\s*-\s*facture\s*:\s*(OCI-[A-Z0-9.]+)/i,
      /(OCI-[A-Z]{2,5}\.\d{3}\.\d+)/,
    ]) ||
    extraire(t, [/Re[çc]u\s*[—-]\s*Facture[:\s]+(\d+)/i]) ||
    ""

  // ── N° journal ──────────────────────────────────────────────────────────────
  const n_journal = extraire(t, [/N[°o]\s*journal[:\s]+(\d+)/i]) || ""

  // ── Date ────────────────────────────────────────────────────────────────────
  const dateRaw = extraire(t, [/Date[:\s]+(\d{1,2}[.\s]\w+\s+\d{4}[^\\n]*)/i]) || ""
  const date_vente = parseDateFr(dateRaw) || ""

  // ── Opérateur ───────────────────────────────────────────────────────────────
  const operateur = (
    extraire(t, [/Op[ée]rateur[:\s]+([A-ZÁÀÂÉÈÊÎÏÔÙÛÜ '\-]+?)(?:\n|Printing|$)/i]) || ""
  ).trim().toUpperCase()

  // ── Site / agence ───────────────────────────────────────────────────────────
  const site = extraire(t, [/Site[:\s]+(OCI-[A-Z0-9]+)/i]) || ""
  const agence_site = SITE_TO_AGENCE[site] || site

  // ── Client / N° client ──────────────────────────────────────────────────────
  const n_client = extraire(t, [/N[°o]\s*client[:\s]+([\d.]+)/i])
  // Le client est typiquement dans les 5 premières lignes avant "Date:"
  const zoneClient = t.split(/Date[:\s]/i)[0]
  const candidatsClient = zoneClient.split("\n")
    .map(l => l.trim())
    .filter(l =>
      l.length > 3 &&
      !l.startsWith("Agence") &&
      !l.startsWith("OCI") &&
      !l.includes("orange") &&
      !/^(Ms\.|Mr\.|Mme\.?)$/i.test(l)
    )
  // Prendre la dernière ligne non vide avant Date comme nom client
  const clientLines = candidatsClient.filter(l =>
    !/^(Ms\.|Mr\.|Mme\.?)$/i.test(l) && l.length > 3
  )
  const client = clientLines[clientLines.length - 1] || null

  // ── Avoir ? ─────────────────────────────────────────────────────────────────
  const est_avoir = /\bAvoir\b/i.test(t)

  // ── Articles ─────────────────────────────────────────────────────────────────
  const articles: Article[] = []

  // Zone tableau : entre "Pos." et "Montant total net"
  const idxDebut = t.indexOf("Pos.")
  const idxFin   = t.search(/Montant total net/i)

  if (idxDebut !== -1 && idxFin !== -1) {
    const tableau = t.substring(idxDebut, idxFin)

    // Chercher les lignes de position (0001, 0002…)
    // Format : "0001  SERV00093  Business Mobile Mix 5  22 PCE  4237,29  93 220,34 XOF"
    const rePos = /(\d{4})\s+\S+\s+(.+?)\s+(\d+)\s+PC[E.]+\s+([\d\s,]+)\s+([\d\s,.]+)\s*(?:XOF|xor)/gi
    let m: RegExpExecArray | null
    while ((m = rePos.exec(tableau)) !== null) {
      const libelle = m[2].trim().replace(/\s*18%\s*TVA\s*/gi, "").trim()
      if (libelle.length < 2) continue
      articles.push({
        libelle,
        quantite:      parseInt(m[3]) || 1,
        prix_unitaire: parseMontant(m[4]),
        total:         parseMontant(m[5]),
      })
    }

    // Fallback ligne par ligne si regex globale n'a rien trouvé
    if (articles.length === 0) {
      const lignesTableau = tableau.split("\n").map(l => l.trim())
      for (const l of lignesTableau) {
        const mL = l.match(/\d{4}\s+\S+\s+(.+?)\s+(\d+)\s+PC[E.]+\s+([\d,]+)\s+([\d\s,]+)/i)
        if (mL) {
          articles.push({
            libelle:       mL[1].trim(),
            quantite:      parseInt(mL[2]) || 1,
            prix_unitaire: parseMontant(mL[3]),
            total:         parseMontant(mL[4]),
          })
        }
        // Avoir spécifique
        if (/\bAP\b/.test(l) && /\bAvoir\b/i.test(l)) {
          const mAv = l.match(/([\d\s,]+)\s*(?:XOF|xor)?$/i)
          if (mAv) {
            const montantAvoir = parseMontant(mAv[1])
            const descAvoir = extraire(t, [/AJOUT\s+(.+?)(?:\n|$)/i]) || "Avoir"
            articles.push({ libelle: descAvoir, quantite: 1, prix_unitaire: montantAvoir, total: montantAvoir })
          }
        }
      }
    }
  }

  // ── Montant total ────────────────────────────────────────────────────────────
  const montantRaw = extraire(t, [
    /Montant total\b[^\n]*([\d]{2,}[\s,][\d]{3}[,\s]\d{2})/i,
    /Montant total\s+([\d\s,]+)\s*(?:XOF|xor)/i,
  ]) || ""
  const montant_total =
    parseMontant(montantRaw) ||
    articles.reduce((s, a) => s + a.total, 0)

  // ── Mode paiement ────────────────────────────────────────────────────────────
  const mode_paiement = extraire(t, [/(Orange Money\d*|Espèces|Especes|Chèque|Cheque|Virement)/i])

  // ── Erreurs ──────────────────────────────────────────────────────────────────
  const erreurs: string[] = []
  if (!n_facture)   erreurs.push("N° facture non trouvé")
  if (!date_vente)  erreurs.push("Date non trouvée")
  if (!operateur)   erreurs.push("Opérateur non trouvé")
  if (!n_journal)   erreurs.push("N° journal non trouvé")
  if (articles.length === 0) erreurs.push("Articles non extraits")

  return {
    n_facture,
    n_journal,
    date_vente,
    operateur,
    site,
    agence_site,
    client,
    n_client,
    articles,
    montant_total,
    est_avoir,
    mode_paiement,
    texte_brut: t,
    erreurs,
  }
}

// ─── Chargement PDF.js dans le worker ─────────────────────────────────────────

let pdfjsLoaded = false

async function chargerPdfJs(): Promise<void> {
  if (pdfjsLoaded) return
  // Dans un Worker, on utilise importScripts pour charger des scripts synchrone
  self.importScripts(
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
  )
  ;(self as any).pdfjsLib.GlobalWorkerOptions.workerSrc = ""
  pdfjsLoaded = true
}

// ─── Chargement Tesseract dans le worker ──────────────────────────────────────

let tesseractWorker: any = null

async function chargerTesseract(): Promise<void> {
  if (tesseractWorker) return
  // Tesseract.js v5 — importer depuis le bundle UMD
  self.importScripts(
    "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.3/tesseract.min.js"
  )
  const { createWorker } = (self as any).Tesseract
  tesseractWorker = await createWorker("eng", 1, {
    logger: () => {},
    workerPath: "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.3/worker.min.js",
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
    corePath: "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js-core/5.0.0/tesseract-core-simd-lstm.wasm.js",
  })
}

// ─── Rasterisation d'une page PDF → ImageData ─────────────────────────────────

async function rasteriserPage(pdfDoc: any, pageNum: number): Promise<ImageData> {
  const page     = await pdfDoc.getPage(pageNum)
  const viewport = page.getViewport({ scale: 2.0 })

  // OffscreenCanvas disponible dans les workers modernes
  const canvas = new OffscreenCanvas(Math.round(viewport.width), Math.round(viewport.height))
  const ctx    = canvas.getContext("2d")!

  await page.render({ canvasContext: ctx, viewport }).promise

  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

// ─── Point d'entrée du Worker ─────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<WorkerInput>) => {
  if (e.data.type !== "PROCESS_FILES") return

  const { files } = e.data
  const send = (msg: WorkerOutput) => self.postMessage(msg)

  try {
    send({ type: "PROGRESS", label: "Chargement PDF.js...", pct: 2 })
    await chargerPdfJs()

    send({ type: "PROGRESS", label: "Chargement moteur OCR...", pct: 5 })
    await chargerTesseract()

    const pdfjsLib = (self as any).pdfjsLib

    // Compter les pages total
    let totalPages = 0
    const pdfs: Array<{ doc: any; nbPages: number; name: string }> = []
    for (const f of files) {
      const doc     = await pdfjsLib.getDocument({ data: f.buffer }).promise
      const nbPages = doc.numPages
      totalPages += nbPages
      pdfs.push({ doc, nbPages, name: f.name })
    }

    send({ type: "PROGRESS", label: `${totalPages} page(s) à traiter`, pct: 8 })

    let pageTraitee = 0

    for (const { doc, nbPages, name } of pdfs) {
      for (let p = 1; p <= nbPages; p++) {
        pageTraitee++
        const pct = 8 + Math.round((pageTraitee / totalPages) * 88)

        send({
          type: "PROGRESS",
          label: `${name} — page ${p}/${nbPages}`,
          pct,
        })

        try {
          // 1. Rasteriser
          const imageData = await rasteriserPage(doc, p)

          // 2. OCR
          const { data: { text } } = await tesseractWorker.recognize(imageData)

          // 3. Parser
          const reçu = parserTexte(text)

          send({ type: "PAGE_DONE", page: pageTraitee, total: totalPages, result: reçu })
        } catch (err: any) {
          send({ type: "PAGE_DONE", page: pageTraitee, total: totalPages, result: null })
        }
      }
    }

    await tesseractWorker.terminate()
    tesseractWorker = null

    send({ type: "DONE", total: totalPages })

  } catch (err: any) {
    send({ type: "ERROR", message: err?.message || String(err) })
  }
}
