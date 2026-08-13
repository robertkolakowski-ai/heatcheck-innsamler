/**
 * OBSERVASJONSHENTINGEN — METAR fra oppgjørsstasjonen, i sanntid.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  HVA SOM ER NYTT, OG HVA SOM IKKE ER DET
 *
 *  Repoet har hentet METAR før: `daily_prediction_log.py` spør IEMs arkiv én
 *  gang i døgnet, i etterkant, for å score gårsdagens veddemål.
 *
 *  Det som ikke finnes er observasjonen MENS DAGEN PÅGÅR. For et
 *  *lowest*-marked spiller det liten rolle — minimumet settes 04–06, og en
 *  beslutning kl. 02 har null observasjoner av det vinduet. For *highest* er
 *  det hele forskjellen: maksimum settes midt på dagen, mens vi ser på.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── TO KILDER, ALDRI BLANDET ──────────────────────────────────────────────
 *
 *   · **AWC** (`aviationweather.gov`) — NOAAs egen, JSON, minutters latens.
 *     Primær.
 *   · **IEM** (`mesonet.agron.iastate.edu`) — CSV, større latens, men den
 *     eneste som kan gi et vilkårlig datospenn. Reserve OG etterfylling.
 *
 * Hver observasjon bærer hvilken kilde den kom fra, og `metar.ts:dagsmaks`
 * nekter å regne over flere kilder uten at man ber om det. Grunnen står der:
 * et maksimum over foreningen er høyere enn hver kildes eget svar, og er ingen
 * kildes svar.
 *
 * ── VINDU, IKKE ØYEBLIKK ──────────────────────────────────────────────────
 *
 * Begge kildene spørres om et VINDU bakover, ikke om siste rapport. Det gjør
 * to ting: en tapt kjøring leger seg selv ved neste, og pollefrekvensen blir
 * frikoblet fra radantallet — uniknøkkelen `(icao, kilde, gyldig, rapporttype)`
 * gjør at samme rapport hentet ti ganger blir én rad.
 *
 * Det er dét som gjør tett polling trygt. Stasjonene sender rutine-METAR hver
 * halvtime; å spørre hvert femte minutt kjøper LATENS, ikke oppløsning.
 *
 * ── ⚠ SVARFORMENE ER IKKE VERIFISERT MOT EKTE TJENESTER ───────────────────
 *
 * Utviklingsmiljøet har ingen utgående nettilgang (proxyen svarer 403 på
 * begge vertene). Feltnavnene under er skrevet etter tjenestenes egen
 * dokumentasjon, ikke etter et svar noen har sett.
 *
 * Derfor er tolkningen bygget slik at den tåler å ta feil: RÅTEKSTEN er det
 * eneste som må finnes, og `core/src/metar.ts` henter alt av verdi ut av den.
 * Innpakningens tidsstempel brukes bare som referanse for å løse dag-i-måneden,
 * og faller tilbake på `nåMs` når det mangler. Flere feltnavn prøves for hver
 * ting. Første kjøring med nett avgjør hvilke som faktisk er i bruk, og
 * `tools/observasjon-check.mjs` skriver det ut.
 */

import { lesMetar, type Observasjon } from "../core/src/metar.ts";
import { hentJson, hentTekst, type HentOpsjoner, type Svar } from "./hent.ts";

export type Kilde = "awc" | "iem";
export const KILDER: readonly Kilde[] = ["awc", "iem"];

/** Én observasjon med kilden den kom fra. */
export interface Avlest extends Observasjon {
  readonly kilde: Kilde;
}

export interface Avlesning {
  readonly kilde: Kilde;
  readonly icao: string;
  readonly observasjoner: readonly Avlest[];
  /** Rått utfall fra hentingen. `tomt` og `feil` er ikke det samme. */
  readonly svar: Svar<unknown>;
}

/* ── URL-ene ────────────────────────────────────────────────────────────── */

const AWC = "https://aviationweather.gov/api/data/metar";
const IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";

export function urlAwc(icao: string, timer: number): string {
  return `${AWC}?ids=${encodeURIComponent(icao)}&format=json&hours=${timer}`;
}

/**
 * IEM tar et datospenn og ikke et antall timer.
 *
 * `report_type=3` er rutine, `4` er SPECI. Begge tas med, og hvilken hver rad
 * var blir lest ut av råteksten — ikke av parameteren. En parameter sier hva
 * vi ba om; råteksten sier hva vi fikk.
 */
export function urlIem(icao: string, fraMs: number, tilMs: number): string {
  const d = (ms: number) => {
    const t = new Date(ms);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  };
  const a = d(fraMs);
  const b = d(tilMs + 86_400_000);   // IEM er eksklusiv i øvre ende
  return `${IEM}?station=${encodeURIComponent(icao)}&data=metar&tz=UTC` +
    `&format=onlycomma&latlon=no&missing=M&trace=T&direct=no` +
    `&report_type=3&report_type=4` +
    `&year1=${a.y}&month1=${a.m}&day1=${a.d}` +
    `&year2=${b.y}&month2=${b.m}&day2=${b.d}`;
}

/* ── tolkningen ─────────────────────────────────────────────────────────── */

/** Første ikke-tomme streng blant kandidatfeltene. */
function felt(o: Record<string, unknown>, navn: readonly string[]): string | null {
  for (const n of navn) {
    const v = o[n];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Referansetidspunktet en rad skal løses mot.
 *
 * AWC oppgir `obsTime` som epoke-SEKUNDER. Et sekundtall lest som
 * millisekunder havner i 1970, og da ville dag-i-måneden blitt løst mot feil
 * tiår uten at noe så galt ut. Terskelen skiller de to: alt under ~2001 i
 * millisekunder er åpenbart sekunder.
 */
export function refFra(o: Record<string, unknown>, nåMs: number): number {
  for (const n of ["obsTime", "reportTime", "valid", "receiptTime"]) {
    const v = o[n];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v < 1e11 ? v * 1000 : v;
    }
    if (typeof v === "string") {
      // «2026-08-10 12:20» fra IEM er UTC, men mangler sonen. Uten Z tolker
      // Date.parse den som lokal tid, og det er en times feil om sommeren.
      const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? v.replace(" ", "T") + ":00Z" : v;
      const ms = Date.parse(s);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return nåMs;
}

/** AWCs JSON-liste → observasjoner. Rader uten råtekst hoppes over. */
export function lesAwc(data: unknown, nåMs: number): Avlest[] {
  const liste = Array.isArray(data)
    ? data
    : Array.isArray((data as { data?: unknown })?.data)
      ? (data as { data: unknown[] }).data
      : [];

  const ut: Avlest[] = [];
  for (const rad of liste as Array<Record<string, unknown>>) {
    if (!rad || typeof rad !== "object") continue;
    const rå = felt(rad, ["rawOb", "raw_text", "rawText", "metar"]);
    if (!rå) continue;
    const o = lesMetar(rå, refFra(rad, nåMs));
    if (o) ut.push({ ...o, kilde: "awc" });
  }
  return ut;
}

/**
 * IEMs CSV → observasjoner.
 *
 * Kolonnene slås opp på NAVN og ikke på posisjon: IEM legger til felt over tid,
 * og en posisjonell leser ville stille begynt å lese feil kolonne. Linjer som
 * starter med `#` er kommentarer tjenesten legger på selv.
 */
export function lesIem(csv: string, nåMs: number): Avlest[] {
  const linjer = String(csv || "").split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (linjer.length < 2) return [];

  const hode = linjer[0].split(",").map((h) => h.trim().toLowerCase());
  const iMetar = hode.findIndex((h) => h === "metar");
  const iValid = hode.findIndex((h) => h === "valid");
  if (iMetar < 0) return [];

  const ut: Avlest[] = [];
  for (const linje of linjer.slice(1)) {
    // Råteksten kan inneholde komma i teorien; splitt på de FØRSTE feltene og
    // la resten være METAR-en. I praksis er metar siste kolonne.
    const deler = linje.split(",");
    const rå = (iMetar === deler.length - 1 ? deler[iMetar] : deler.slice(iMetar).join(","))?.trim();
    if (!rå || rå === "M") continue;

    const ref = iValid >= 0
      ? refFra({ valid: deler[iValid]?.trim() }, nåMs)
      : nåMs;
    const o = lesMetar(rå, ref);
    if (o) ut.push({ ...o, kilde: "iem" });
  }
  return ut;
}

/* ── hentingen ──────────────────────────────────────────────────────────── */

/** Hvor mange timer bakover vi ber om. Ett vindu, ikke ett øyeblikk. */
export const VINDU_TIMER = 3;

/**
 * Hent fra én kilde. Kaster aldri — utfallet står i `svar`.
 *
 * En kilde som svarer med null rapporter gir `tomt`, ikke `feil`. Det er en
 * reell tilstand: en stasjon kan være uten rapporter i et vindu, og det er
 * noe annet enn at vi ikke fikk svar.
 */
export async function hentFra(
  kilde: Kilde,
  icao: string,
  opt: HentOpsjoner,
  vinduTimer = VINDU_TIMER,
): Promise<Avlesning> {
  if (kilde === "awc") {
    const r = await hentJson(urlAwc(icao, vinduTimer), opt, (d) => lesAwc(d, opt.nåMs).length === 0);
    return {
      kilde, icao, svar: r,
      observasjoner: r.utfall === "ok" ? lesAwc(r.data, opt.nåMs) : [],
    };
  }

  const fra = opt.nåMs - vinduTimer * 3_600_000;
  const r = await hentTekst(urlIem(icao, fra, opt.nåMs), opt, (t) => lesIem(t, opt.nåMs).length === 0);
  return {
    kilde, icao, svar: r,
    observasjoner: r.utfall === "ok" ? lesIem(r.data, opt.nåMs) : [],
  };
}

/**
 * Hent fra alle kildene, i rekkefølge, og stopp når én har levert.
 *
 * ── Hvorfor «stopp når én har levert» og ikke «hent begge alltid» ─────────
 *
 * Reserven finnes for at innsamlingen ikke skal stoppe når primærkilden er
 * nede. Å spørre begge hver gang ville doblet trafikken mot to gratistjenester
 * for å få det samme svaret to ganger.
 *
 * `alle: true` spør begge likevel, og DET er modusen som svarer på om kildene
 * er enige. Den hører hjemme i en måling, ikke i den løpende innsamlingen —
 * se `tools/observasjon-check.mjs`.
 */
export async function hentObservasjoner(
  icao: string,
  opt: HentOpsjoner,
  valg: { kilder?: readonly Kilde[]; alle?: boolean; vinduTimer?: number } = {},
): Promise<Avlesning[]> {
  const kilder = valg.kilder ?? KILDER;
  const ut: Avlesning[] = [];

  for (const k of kilder) {
    const a = await hentFra(k, icao, opt, valg.vinduTimer);
    ut.push(a);
    if (!valg.alle && a.observasjoner.length) break;
  }
  return ut;
}

/** Én linje som skal kunne leses alene i en Actions-logg. */
export function sammendrag(avlesninger: readonly Avlesning[]): string {
  return avlesninger.map((a) => {
    const n = a.observasjoner.length;
    const u = a.svar.utfall;
    const grunn = u === "feil" ? ` (${a.svar.grunn})` : "";
    return `${a.kilde}: ${u}${n ? ` · ${n} rapport(er)` : ""}${grunn}`;
  }).join(" · ");
}
