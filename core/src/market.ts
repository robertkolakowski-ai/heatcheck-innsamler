/**
 * Markedslaget — rent. Tolker Polymarkets gamma-svar til bøtter og priser.
 * Selve hentingen (og alt som kan feile mot nettet) hører hjemme i fase 3.
 */

import { fingeravtrykk, kanonisk } from "./avtrykk.ts";

export interface Bøtte {
  /** Heltallsgraden bøtta gjelder, tolket fra spørsmålsteksten. */
  readonly grad: number;
  readonly etikett: string;
  /** YES-prisen, 0–1. Polymarket oppgir `outcomes = [Yes, No]`. */
  readonly pris: number;
}

export interface Marked {
  readonly slug: string | null;
  /** Oppslag grad → YES-pris. */
  readonly bøtter: Readonly<Record<number, number>>;
  /** Alle bøtter, sortert stigende på grad. */
  readonly alle: readonly Bøtte[];
}

/** Alle sifferblokker i en streng: "18°C or below" → [18] */
function tall(s: string): number[] {
  return (s.match(/\d+/g) ?? []).map(Number);
}

/**
 * Heltallsgraden en bøtteetikett gjelder — det FØRSTE tallet i etiketten.
 *
 * «17°C» → 17 · «14°C or below» → 14 · «18-19°C» → 18 · «varmt» → null
 *
 * Regelen sto inne i `lesMarked` og trengtes så et sted til: snapshot-filene
 * lagrer etiketten og prisen, ikke graden, så den som leser dem må tolke det
 * samme. To kopier av «hvilken grad er dette» er nøyaktig den feiltypen
 * prosjektet har blitt brent av før — de glir fra hverandre, og ingenting blir
 * rødt av det.
 */
export function gradFor(etikett: string): number | null {
  const n = tall(etikett);
  return n.length ? n[0] : null;
}

/**
 * Tolker ett event fra `gamma-api.polymarket.com/events`.
 *
 * Tomt eller uventet svar gir null i stedet for kast — markedet er rutinemessig
 * ikke åpnet ennå når vi kjører 24 t før natten, og det er ikke en feil.
 */
export function lesMarked(svar: unknown): Marked | null {
  const liste = Array.isArray(svar) ? svar : null;
  if (!liste?.length) return null;
  const event = liste[0] as { slug?: string; markets?: unknown[] };
  const markeder = Array.isArray(event.markets) ? event.markets : [];

  const bøtter: Record<number, number> = {};
  const alle: Bøtte[] = [];

  for (const m of markeder as Array<Record<string, unknown>>) {
    const etikett = String(m.groupItemTitle ?? m.question ?? "");
    const grad = gradFor(etikett);
    if (grad == null) continue;

    let priser: unknown = m.outcomePrices;
    if (typeof priser === "string") {
      try { priser = JSON.parse(priser); } catch { priser = []; }
    }
    const yes = Array.isArray(priser) && priser.length ? Number.parseFloat(String(priser[0])) : 0;
    const pris = Number.isFinite(yes) ? yes : 0;

    bøtter[grad] = pris;
    alle.push({ grad, etikett, pris });
  }

  if (!alle.length) return null;
  alle.sort((a, b) => a.grad - b.grad);
  return { slug: event.slug ?? null, bøtter, alle };
}

// ── hele bøttesettet, med grenser og ordrebok-topp (B04) ───────────────────
//
// `lesMarked` over er Temp-Traders syn på markedet: grad → YES-pris, som er
// alt beslutningen der trenger. Snapshot-loggingen trenger mer — grensene for
// hver bøtte, og både ask og bid — fordi det er dét en historisk pris ER.
// Uten grensene kan en fremtidig analyse ikke vite hva bøtta dekket; uten
// spreaden kan den ikke vite hva en handel faktisk hadde kostet.
//
// Grensene tolkes som halvåpne intervaller [lav, høy), med et halvt grad
// slingringsmonn i hver ende — nøyaktig som `parseBucket` i temp-bets.html,
// og holdt der av en paritetstest.

export interface FullBøtte {
  readonly etikett: string;
  /** null = åpen ende («below 18°C» har ingen nedre grense). */
  readonly lav: number | null;
  readonly høy: number | null;
  /** Kjøp Yes. */
  readonly ask: number | null;
  /** Selg Yes — No-siden koster 1 − bid. */
  readonly bid: number | null;
  /** Midtpris fra `outcomePrices`, det gamma oppgir som «prisen». */
  readonly mid: number | null;
  /**
   * CLOB-tokenet for Yes-siden av denne bøtta, null når gamma ikke oppgir det.
   *
   * Uten dette kan en beslutning ikke rutes til et marked: `trader/trader.js`
   * kjøper et *token*, ikke en etikett. Nettleseren har lest feltet siden
   * ordreboken kom inn (`temp-bets.html`, `marketBuckets`); Node-siden har ikke,
   * og det er hele grunnen til at A1 sto igjen.
   */
  readonly yesToken: string | null;
  /** Samme for No-siden. Å kjøpe No er å kjøpe No-tokenet. */
  readonly noToken: string | null;
}

/**
 * HVA MARKEDET SIER AT DET GJØR OPP PÅ.
 *
 * ── Hullet dette lukker ───────────────────────────────────────────────────
 *
 * Hele systemet hviler på at «Highest temperature in London» gjøres opp på
 * London City Airport. `STASJON` i `observasjon.ts` står på EGLC-koordinatene,
 * modellene spørres der, og `daily_prediction_log.py` henter METAR derfra.
 *
 * Ingenting har lest hva markedet SELV oppgir. Byttet Polymarket
 * oppgjørsstasjon i morgen — til Heathrow, til en annen kilde, til en annen
 * enhet — ville ingen linje kode og ingen test merket det. Prognosen ville
 * fortsatt vært for EGLC, og den ville fortsatt sett riktig ut.
 *
 * Dette er den billigste harde porten i hele spesifikasjonen: den koster ett
 * felt i et svar vi allerede henter.
 *
 * ── Hvorfor teksten normaliseres før den avtrykkes ────────────────────────
 *
 * Oppgjørsteksten inneholder måldatoen — «…on August 6, 2026». Et rått avtrykk
 * ville derfor skiftet HVER ENESTE DAG, og et varsel som roper daglig blir
 * slått av innen uka er omme. `normalisertOppgjørstekst` fjerner datoen og
 * slår sammen mellomrom, og gjør ingenting annet: en terskel, et stasjonsnavn
 * eller en enhet som endrer seg skal fortsatt flytte avtrykket.
 */
export interface Oppgjørsregel {
  /**
   * `resolutionSource` — som regel en URL. Det er DENNE som navngir stasjonen,
   * og derfor den viktigste halvdelen. Null når gamma ikke oppgir noe.
   */
  readonly kilde: string | null;
  /** Regelteksten, uendret og udatonormalisert. Null når feltet mangler. */
  readonly tekst: string | null;
  /**
   * Hvilket felt teksten ble funnet i.
   *
   * Står her fordi feltnavnet ikke er verifisert mot et ekte gamma-svar — se
   * `OPPGJØRSFELT`. Flytter Polymarket teksten til et annet felt, skal det
   * være LESBART at den flyttet, ikke se ut som at teksten forsvant.
   */
  readonly felt: string | null;
  /** Avtrykk over kilde + normalisert tekst. Null når begge mangler. */
  readonly avtrykk: string | null;
}

/**
 * «Vi vet ingenting om oppgjørsregelen.»
 *
 * Finnes som en navngitt konstant fordi et `FullMarked` bygges for hånd flere
 * steder — i tester, og i `etterprov.ts` som gjenskaper markeder fra lagrede
 * snapshots der teksten aldri ble lagret. Uten den ville hvert av de stedene
 * skrevet sitt eget objekt med fire nuller, og fire kopier av «ingenting» er
 * fire steder å ta feil.
 */
export const INGEN_OPPGJØRSREGEL: Oppgjørsregel =
  { kilde: null, tekst: null, felt: null, avtrykk: null };

export interface FullMarked {
  readonly slug: string | null;
  readonly enhet: "celsius" | "fahrenheit";
  readonly bøtter: readonly FullBøtte[];
  /** Hva markedet oppgir at det gjør opp på. Aldri null — feltene inni er det. */
  readonly oppgjør: Oppgjørsregel;
}

/**
 * Grensene for én bøtteetikett.
 *
 * «below 18°C» → [null, 18.5)   ·  «22°C or above» → [21.5, null)
 * «18-19°C»    → [17.5, 19.5)   ·  «20°C»          → [19.5, 20.5)
 */
export function tolkGrenser(etikett: string): { lav: number | null; høy: number | null } {
  const n = tall(etikett);
  const l = etikett.toLowerCase();
  if (l.includes("below") && n.length) return { lav: null, høy: n[0] + 0.5 };
  if ((l.includes("higher") || l.includes("above")) && n.length) return { lav: n[0] - 0.5, høy: null };
  if (n.length >= 2) return { lav: n[0] - 0.5, høy: n[1] + 0.5 };
  if (n.length === 1) return { lav: n[0] - 0.5, høy: n[0] + 0.5 };
  return { lav: null, høy: null };
}

function tallEller(v: unknown): number | null {
  if (v == null) return null;
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** gamma sender lister som JSON-strenger like ofte som som lister. */
function liste(v: unknown): unknown[] {
  if (typeof v === "string") {
    try { return JSON.parse(v) as unknown[]; } catch { return []; }
  }
  return Array.isArray(v) ? v : [];
}

/**
 * Tokenene for én bøtte, tolket som nettleseren gjør det.
 *
 * Oppslaget er på navn og ikke på posisjon, fordi rekkefølgen i `outcomes`
 * ikke er lovet noe sted. Den posisjonelle reserven `[Yes, No]` brukes bare når
 * navnet ikke finnes, og bare for et par — den er en gjetning, og en gjetning
 * over to elementer er den eneste som er trygg.
 *
 * Ulik lengde på `outcomes` og `clobTokenIds` gir null for begge. Et token
 * plukket fra en liste som ikke stemmer overens ville pekt på feil marked, og
 * en ordre mot feil token er verre enn ingen ordre.
 */
function tokener(m: Record<string, unknown>): { yesToken: string | null; noToken: string | null } {
  const utfall = liste(m.outcomes);
  const toks = liste(m.clobTokenIds);
  if (!utfall.length || utfall.length !== toks.length) return { yesToken: null, noToken: null };

  const finn = (navn: string, reserve: number): string | null => {
    const i = utfall.findIndex((o) => String(o).toLowerCase() === navn);
    const t = i >= 0 ? toks[i] : (toks.length === 2 ? toks[reserve] : null);
    return t == null || t === "" ? null : String(t);
  };
  return { yesToken: finn("yes", 0), noToken: finn("no", 1) };
}

/**
 * Feltene oppgjørsteksten kan ligge i, i den rekkefølgen de prøves.
 *
 * ⚠ IKKE VERIFISERT MOT ET EKTE GAMMA-SVAR. Utviklingsmiljøet har ingen
 * utgående nettilgang, så listen er skrevet etter hva Polymarkets API
 * dokumenterer og ikke etter hva det svarte. Derfor prøves FLERE navn, og
 * derfor bæres `felt` videre på resultatet: står det et annet navn enn
 * forventet i en lagret rad, er det en opplysning og ikke en feil.
 *
 * Første kjøring med nett avgjør hvilket som faktisk er i bruk.
 * `tools/oppgjorskilde-check.mjs` skriver det ut.
 */
const OPPGJØRSFELT = ["resolutionSource", "description", "resolutionCriteria"] as const;

/** Første ikke-tomme streng blant kandidatfeltene, med navnet den kom fra. */
function førsteTekst(
  kilder: ReadonlyArray<Record<string, unknown> | null | undefined>,
  felt: readonly string[],
): { verdi: string; felt: string } | null {
  for (const f of felt) {
    for (const k of kilder) {
      const v = k?.[f];
      if (typeof v === "string" && v.trim()) return { verdi: v.trim(), felt: f };
    }
  }
  return null;
}

/**
 * Teksten uten det som endrer seg av seg selv hver dag.
 *
 * Fjerner måldatoen i begge formene Polymarket bruker — «August 6, 2026» og
 * «2026-08-06» — og slår sammen mellomrom. Ellers ville avtrykket skiftet
 * daglig, og et endringsvarsel som roper daglig er et varsel ingen leser.
 *
 * Den fjerner IKKE frittstående tall. En terskel som går fra 30 til 31 °C er
 * nøyaktig den endringen porten finnes for å fange, og en normalisering som
 * er glad i å fjerne tall ville spist den.
 *
 * Små bokstaver: en kilde som skrives «Wunderground» i dag og «wunderground» i
 * morgen er ikke en regelendring.
 */
export function normalisertOppgjørstekst(tekst: string): string {
  const MÅNED = "(?:january|february|march|april|may|june|july|august|september|october|november|december)";
  return tekst
    .toLowerCase()
    .replace(new RegExp(`${MÅNED}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}`, "g"), "<dato>")
    .replace(new RegExp(`\\d{1,2}\\s+${MÅNED},?\\s+\\d{4}`, "g"), "<dato>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<dato>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Les oppgjørsregelen ut av eventet og dets markeder.
 *
 * Både eventnivået og markedsnivået prøves, i den rekkefølgen: teksten står
 * normalt per marked, men gamma legger den av og til bare på eventet. Er
 * markedene uenige med hverandre, vinner det første — og det er en tilstand
 * `oppgjorskilde-check` skriver ut framfor å skjule, fordi to bøtter i samme
 * marked med hver sin oppgjørsregel er noe helt annet enn et tynt marked.
 */
export function lesOppgjørsregel(
  event: Record<string, unknown> | null | undefined,
  markeder: ReadonlyArray<Record<string, unknown>>,
): Oppgjørsregel {
  const kilder = [event, ...markeder];
  const kildeTreff = førsteTekst(kilder, ["resolutionSource"]);
  const tekstTreff = førsteTekst(kilder, OPPGJØRSFELT.filter((f) => f !== "resolutionSource"));

  const kilde = kildeTreff?.verdi ?? null;
  const tekst = tekstTreff?.verdi ?? null;
  if (kilde === null && tekst === null) return INGEN_OPPGJØRSREGEL;

  return {
    kilde,
    tekst,
    felt: tekstTreff?.felt ?? kildeTreff?.felt ?? null,
    avtrykk: fingeravtrykk(kanonisk({
      kilde: kilde === null ? null : kilde.toLowerCase(),
      tekst: tekst === null ? null : normalisertOppgjørstekst(tekst),
    })),
  };
}

/** Hele bøttesettet med grenser, ask og bid. Null når eventet er tomt. */
export function lesFulltMarked(svar: unknown): FullMarked | null {
  const liste = Array.isArray(svar) ? svar : null;
  if (!liste?.length) return null;
  const event = liste[0] as { slug?: string; markets?: unknown[] };
  const markeder = Array.isArray(event.markets) ? event.markets : [];

  let enhet: "celsius" | "fahrenheit" = "fahrenheit";
  const bøtter: FullBøtte[] = [];

  for (const m of markeder as Array<Record<string, unknown>>) {
    const etikett = String(m.groupItemTitle ?? m.question ?? "");
    if (etikett.includes("°C")) enhet = "celsius";

    let priser: unknown = m.outcomePrices;
    if (typeof priser === "string") {
      try { priser = JSON.parse(priser); } catch { priser = []; }
    }
    const mid = Array.isArray(priser) && priser.length ? tallEller(priser[0]) : null;

    const { lav, høy } = tolkGrenser(etikett);
    const { yesToken, noToken } = tokener(m);
    bøtter.push({
      etikett, lav, høy,
      ask: tallEller(m.bestAsk), bid: tallEller(m.bestBid), mid,
      yesToken, noToken,
    });
  }

  if (!bøtter.length) return null;
  // Samme sortering som nettleseren: stigende på nedre grense, med den åpne
  // nedre enden først.
  bøtter.sort((a, b) => (a.lav ?? -Infinity) - (b.lav ?? -Infinity));
  return {
    slug: event.slug ?? null,
    enhet,
    bøtter,
    oppgjør: lesOppgjørsregel(
      event as Record<string, unknown>,
      markeder as Array<Record<string, unknown>>,
    ),
  };
}

/**
 * Samlet kjøpspris for anbefalingen — én eller to bøtter. Null hvis én av dem
 * ikke er priset: da har vi ingen handel, bare et flagg.
 *
 * Tom liste gir også null. En sum over ingenting er 0, og en pris på 0 ville
 * blitt lest som «gratis handel» i stedet for «ingen handel».
 */
export function kombinertPris(marked: Marked, bøtter: readonly number[]): number | null {
  if (!bøtter.length) return null;
  let sum = 0;
  for (const b of bøtter) {
    const pris = marked.bøtter[b];
    if (pris == null) return null;
    sum += pris;
  }
  return sum;
}

/**
 * Markedets to dyreste bøtter — altså hva markedet selv tror på.
 * Grunnlaget for «enig/uenig med marked» (byggeplanens punkt 8).
 */
export function markedetsFavoritter(marked: Marked): number[] {
  return [...marked.alle]
    .sort((a, b) => (b.pris - a.pris) || (a.grad - b.grad))
    .slice(0, 2)
    .map((b) => b.grad)
    .sort((a, b) => a - b);
}
