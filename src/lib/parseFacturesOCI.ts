// Parseur de reçus OCI collés depuis Word.
//
// Le texte collé contient plusieurs dizaines de reçus concaténés avec une
// mise en page dégradée (colonnes mélangées, PDF->texte imparfait). Le seul
// repère fiable est la ligne "N°recu-facture:OCI-XXX.XXX.XXXXXX" (variantes
// OCR : "N recu", "Nrecu", "N⁰recu", "N regu"). Elle tombe AU MILIEU de
// chaque reçu : après l'en-tête (agence/client/date/opérateur), avant le
// corps (articles + montants).
//
// Une même facture peut porter PLUSIEURS ventes (plusieurs lignes d'article,
// codées 0001, 0002...). Le parseur restitue une ligne par article, pas une
// ligne par facture — indispensable pour ne pas fusionner des offres
// différentes vendues sur le même reçu.

export interface LigneExtraiteOCI {
  nFacture: string;
  date: string | null;
  agentNom: string | null;
  agence: string | null;
  offre: string;
  montant: number | null;
  estAvoir: boolean;
  confiance: 'haute' | 'moyenne' | 'faible';
}

const FACTURE_RE = /N[°⁰]?\s*(?:re[cg]u)\s*-?\s*[Ff]acture\s*:\s*(OCI-[A-Z]+\.\d+\.\d+)/g;

const MOIS: Record<string, number> = {
  jan: 1, fev: 2, 'fév': 2, mar: 3, avr: 4, mai: 5, juin: 6,
  juil: 7, aout: 8, 'août': 8, sept: 9, oct: 10, nov: 11, dec: 12, 'déc': 12,
};

// Roster figé au 02/09/2026. À tenir synchronisé avec COMMERCIAUX_ROSTER côté
// CRM historique si de nouveaux commerciaux rejoignent l'équipe.
const ROSTER: { agent: string; agence: string; alias: string[] }[] = [
  { agent: 'AIDARA SYRA',           agence: 'Angré 7ème Tranche',      alias: ['AIDARA', 'SYRA AISSATOU'] },
  { agent: 'BANHORO Habibata',      agence: 'Angré 7ème Tranche',      alias: ['HABIBATA BANHORO', 'BANHORO HABIBATA'] },
  { agent: 'BAKAYOKO MAX',          agence: 'Angré Djibi',             alias: ['MAX LANDRY BAKAYOKO', 'BAKAYOKO'] },
  { agent: 'BANHORO NANTENIN',      agence: 'Angré Djibi',             alias: ['NANTENIN BANHORO'] },
  { agent: 'ANANI LINDA',           agence: 'SmartStore',              alias: ['LINDA ANANI'] },
  { agent: 'BONNY CELESTE',         agence: 'SmartStore',              alias: ['CELESTE BONNY', 'JOSEPHINE CELESTE', 'BONNY'] },
  { agent: 'FATIGA MABOUTE',        agence: 'SmartStore',              alias: ['MABOUTE AISSATA FATIGA', 'AISSATA FATIGA'] },
  { agent: 'DIAKITE Hadja Sayon',   agence: 'SmartStore',              alias: ['SAYON DIAKITE', 'HADJA SAYON'] },
  { agent: "N'DRI JEANNETTE",       agence: 'Plateau Nord / Pyramide', alias: ["N'DRI JEANNETTE", 'NDRI JEANNETTE'] },
  { agent: 'GUIBILIHONON Dorcasse', agence: 'Plateau Nord / Pyramide', alias: ['DORCASSE GUIBILIHONON'] },
  { agent: 'AMOA Hervé',            agence: 'Adjamé Mosquée',          alias: ['HERVE AMOA'] },
  { agent: 'ATTAYE Saul',           agence: 'Adjamé Mosquée',          alias: ['SAUL ATTAYE'] },
  { agent: 'KOUASSI Nadège-Flore',  agence: 'Adjamé 220 Logts',        alias: ['NADEGE KOUASSI', 'NADEGE-FLORE'] },
  { agent: 'KOTIE Diane',           agence: 'Adjamé 220 Logts',        alias: ['DIANE KOTIE'] },
  { agent: 'ATTO Kevin',            agence: 'Bassam',                  alias: ['KEVIN ATTO'] },
  { agent: 'AGBARO Ayeko',          agence: 'Bassam',                  alias: ['AYEKO AGBARO'] },
];

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDate(preText: string): string | null {
  const m = preText.match(/Date\s*:?\.?\s*(\d{1,2})\s*([a-zéû]+)\.?\s*(\d{4})/i);
  if (!m) return null;
  const jour = m[1].padStart(2, '0');
  const moisTxt = m[2].toLowerCase().slice(0, 4).replace('û', 'u');
  const mois = MOIS[moisTxt] || MOIS[moisTxt.slice(0, 3)];
  if (!mois) return null;
  return `${m[3]}-${String(mois).padStart(2, '0')}-${jour}`;
}

function parseAgentEtAgence(preText: string): { agent: string | null; agence: string | null } {
  const norm = normalize(preText);
  for (const r of ROSTER) {
    const candidates = [r.agent, ...r.alias].map(normalize);
    for (const c of candidates) {
      const words = c.split(' ').filter(Boolean);
      const mainWord = words.sort((a, b) => b.length - a.length)[0];
      if (mainWord.length >= 4 && norm.includes(mainWord)) {
        const otherWords = words.filter(w => w !== mainWord && w.length >= 3);
        const confirmed = otherWords.length === 0 || otherWords.some(w => norm.includes(w));
        if (confirmed) return { agent: r.agent, agence: r.agence };
      }
    }
  }
  return { agent: null, agence: null };
}

const OFFRE_KEYWORDS: { test: RegExp; offre: string }[] = [
  { test: /sms\s*affaires/i,                        offre: 'SMS Affaires' },
  { test: /business\s*mobile\s*mix|mobile\s*mix/i,  offre: 'Business Mobile Mix' },
  { test: /community/i,                             offre: 'B2B Kit Community' },
  { test: /internet\s*top\s*?up/i,                  offre: 'Internet TopUp' },
  { test: /flybox/i,                                offre: 'Pack 4G Flybox' },
  { test: /tozed|easybox/i,                         offre: 'Pack 4G EasyBox' },
  { test: /doro|logicom|post[e]?\s*t[ée]l/i,        offre: 'Terminal (poste téléphonique)' },
  { test: /initial\s*in[vy]oice\s*payment/i,        offre: 'Paiement facture initiale' },
  { test: /paiement\s*de\s*facture/i,               offre: 'Paiement de facture' },
];

// Distingue un VRAI avoir (note de crédit, jamais commissionable) d'un
// "ajout de numéro" / "modification rechargement" Mix : ces derniers portent
// le libellé "Avoir" sur la ligne d'article (code AP) mais sont des ventes
// réelles — recharge ou ajout de ligne Mix — commissionables comme telles.
function classifyChunk(chunk: string): { offre: string; estAvoir: boolean } {
  const hasAvoirLabel = /\bAvoir\b/i.test(chunk);
  const isAjoutNumero = /AJOUT\s*\d*\s*NUMEROS?\s*MIX|MODIFICATION\s*RECHARGEMENT/i.test(chunk);

  if (isAjoutNumero) {
    return { offre: 'Ajout numéro Mobile Mix', estAvoir: false };
  }
  if (hasAvoirLabel) {
    return { offre: 'Avoir / Régularisation', estAvoir: true };
  }
  for (const k of OFFRE_KEYWORDS) {
    if (k.test.test(chunk)) return { offre: k.offre, estAvoir: false };
  }
  return { offre: 'À préciser', estAvoir: false };
}

// Le nombre et son "xOF" sont toujours sur la même ligne source. Interdire
// le saut de ligne évite de fusionner des chiffres de champs différents.
// Un point OU une virgule peut servir de séparateur décimal selon la source
// (Word normalise parfois différemment) : on ne traite comme décimale que
// la dernière occurrence, à 2-3 chiffres.
function toNombre(brut: string): number | null {
  const m = brut.match(/^(\d+)[.,](\d{2,3})$/);
  const num = m ? parseFloat(`${m[1]}.${m[2]}`) : parseFloat(brut.replace(/[.,]/g, ''));
  return isNaN(num) ? null : num;
}

function parseMontantDansChunk(chunk: string): number | null {
  const re = /(\d[\d]{0,9}(?:[.,]\d{2,3})?)[ \t]*[x×][oO0Ff][Ff]?\b/i;
  const m = chunk.match(re);
  return m ? toNombre(m[1]) : null;
}

function parseMontantTotalFooter(footerSegment: string): number | null {
  const re = /Montant\s+total(?!\s*net)[^\n]{0,80}?(\d[\d]{0,9}(?:[.,]\d{2,3})?)[ \t]*[x×][oO0Ff][Ff]?\b/i;
  const m = footerSegment.match(re);
  return m ? toNombre(m[1]) : null;
}

// Découpe le corps d'une facture (après le marqueur) en items individuels,
// un par code article ("0001", "0002"... ou "AP" pour un avoir/ajustement).
// S'arrête à "Montant total net", qui ouvre la section des totaux agrégés —
// laquelle ne doit jamais être comptée comme une ligne de vente à part.
function splitItems(postText: string): { chunks: string[]; footerSegment: string } {
  const finItems = postText.search(/Montant\s+total\s+net/i);
  const itemsSegment = finItems >= 0 ? postText.slice(0, finItems) : postText;
  const footerSegment = finItems >= 0 ? postText.slice(finItems) : '';

  const CODE_RE = /(?:^|\n)\s*(000[1-9]|AP)\b/g;
  const positions = [...itemsSegment.matchAll(CODE_RE)].map(m => m.index!);

  const chunks = positions.length === 0
    ? [itemsSegment]
    : positions.map((pos, i) => {
        const end = i < positions.length - 1 ? positions[i + 1] : itemsSegment.length;
        return itemsSegment.slice(pos, end);
      });

  return { chunks, footerSegment };
}

export function parseTexteFactures(texte: string): LigneExtraiteOCI[] {
  const matches = [...texte.matchAll(FACTURE_RE)];
  const brut: LigneExtraiteOCI[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const prevEnd = i > 0 ? matches[i - 1].index! + matches[i - 1][0].length : 0;
    const nextStart = i < matches.length - 1 ? matches[i + 1].index! : texte.length;
    const preText = texte.slice(prevEnd, m.index);
    const postText = texte.slice(m.index! + m[0].length, nextStart);

    const date = parseDate(preText);
    const { agent, agence } = parseAgentEtAgence(preText);
    const { chunks, footerSegment } = splitItems(postText);
    const montantFooter = parseMontantTotalFooter(footerSegment);

    const items = chunks
      .map(chunk => ({ ...classifyChunk(chunk), montant: parseMontantDansChunk(chunk) }))
      .filter(it => it.montant !== null) as { offre: string; estAvoir: boolean; montant: number }[];

    if (items.length === 0) {
      // Rien d'exploitable dans le détail des articles : repli sur le total
      // de la facture, offre générique à préciser en relecture.
      brut.push({
        nFacture: m[1], date, agentNom: agent, agence,
        offre: 'À préciser', montant: montantFooter, estAvoir: false,
        confiance: [date, agent, montantFooter].filter(v => v !== null).length === 3 ? 'haute' : 'faible',
      });
    } else {
      items.forEach(item => {
        brut.push({
          nFacture: m[1], date, agentNom: agent, agence,
          offre: item.offre, montant: item.montant, estAvoir: item.estAvoir,
          confiance: [date, agent].filter(v => v !== null).length === 2 ? 'haute' : 'moyenne',
        });
      });
    }
  }

  // Déduplication : une même facture peut apparaître plusieurs fois dans le
  // texte collé (réimpressions), donnant lieu à des lignes strictement
  // identiques (même facture + même offre + même montant). On ne garde
  // qu'une occurrence par triplet (facture, offre, montant) — ce qui
  // préserve les vraies lignes multiples d'une même facture (offres ou
  // montants différents) tout en éliminant les répétitions exactes.
  const vus = new Set<string>();
  const dedup: LigneExtraiteOCI[] = [];
  for (const l of brut) {
    const cle = `${l.nFacture}|${l.offre}|${l.montant}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    dedup.push(l);
  }

  return dedup;
}
