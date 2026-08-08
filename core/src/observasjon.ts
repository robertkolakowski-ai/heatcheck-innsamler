/**
 * OBSERVASJONSLAGET — hva vi ser på, og hvor vi henter det fra.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  HVORFOR DENNE FILEN ER SKILT UT FRA `models.ts`
 *
 *  `models.ts` blandet to ting som ikke tåler å reise sammen:
 *
 *    · HVA VI OBSERVERER  — stasjonen, nattevinduet, hvilke værmodeller vi
 *      spør, hvordan Polymarkets slug staves. Dette er fakta om markedet og
 *      om Open-Meteo. Ingen av dem sier noe om når vi handler.
 *
 *    · HVORDAN VI BESLUTTER — terskler og marginer. Endres ett av de tallene,
 *      endres hver eneste handel. De blir liggende i `models.ts`.
 *
 *      De er med vilje IKKE navngitt her. Denne filen er skrevet for å kunne
 *      leses av andre, og en liste over hva man skal lete etter er halve
 *      jobben for den som leter.
 *
 *  Innsamleren (`runtime/snapshots.ts`, B04) trenger BARE den første gruppen.
 *  Den tolker ingenting, og skal aldri gjøre det: den skriver ned hva modellene
 *  sa og hva bøttene kostet, og lar tolkningen skje et annet sted.
 *
 *  Så lenge begge gruppene lå i samme fil, kunne ikke innsamleren kjøre noe
 *  sted uten å ta med seg beslutningsregelen. Det er hele grunnen til skillet
 *  — se `docs/DELING.md`.
 *
 *  REGELEN, når du legger til noe her: spør «endrer dette tallet en handel?»
 *  Er svaret ja, hører det hjemme i `models.ts`, ikke her. Er du i tvil, er
 *  svaret `models.ts` — en konstant på feil side av dette skillet er en
 *  lekkasje som ingen test fanger.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Polymarkets oppgjørsstasjon: London City Airport. */
export const STASJON = { lat: 51.5048, lon: 0.0495 } as const;

/** Nattevinduet der minimumet settes, lokal London-tid. */
export const NATTETIMER = [0, 1, 2, 3, 4, 5, 6] as const;

/** Markedet lukker 22:00 UTC på måldatoen. */
export const MARKED_LUKKER_UTC = 22;

/**
 * De ni modellene som DRIVER beslutningen.
 *
 * LISTEN ER MÅLT SOM HELHET, IKKE SATT SAMMEN AV NI SELVSTENDIGE VALG. Treffet
 * er en egenskap ved settet: minst én av disse ni gjør det klart dårligere enn
 * de andre alene, og bidrar likevel positivt fordi feilene peker motsatt vei av
 * resten. Rangerer du modellene hver for seg og luker ut de svakeste, blir
 * ensemblet målbart dårligere.
 *
 * Derfor: ikke ta ut en modell på grunnlag av hvordan den skårer alene. Legge
 * til er en billigere endring enn å fjerne — en ekstra modell blir bare hentet
 * og logget, mens en fjernet endrer hva ensemblet er.
 *
 * Merk at LISTEN står her mens VEKTINGEN av den står i `models.ts`. Hvilke
 * modeller som hentes er en innsamlingsbeslutning; hva de får bety er ikke.
 */
export const ENSEMBLE = {
  ecmwf_ifs025: "ECMWF (Europa)",
  gfs_seamless: "GFS (USA)",
  icon_seamless: "ICON (Tyskland)",
  ukmo_seamless: "UKMO global (Storbritannia)",
  meteofrance_seamless: "ARPEGE (Frankrike)",
  gem_seamless: "GEM (Canada)",
  jma_seamless: "JMA (Japan)",
  knmi_harmonie_arome_europe: "KNMI HARMONIE (NL)",
  dmi_harmonie_arome_europe: "DMI HARMONIE (DK)",
} as const;

/** Referansemedian som logges ved siden av — styrer ikke valget. */
export const SEKS_KJERNE = [
  "ecmwf_ifs025", "gfs_seamless", "icon_seamless",
  "ukmo_seamless", "meteofrance_seamless", "gem_seamless",
] as const;

/**
 * Fem høyoppløselige modeller. LOGGES for sammenlikning, driver IKKE valget.
 *
 * De har kort rekkevidde (~36–60 t) og en systematisk varm bias, og begge deler
 * er grunner til å se på dem ved siden av, ikke å la dem bestemme. Hvor stort
 * utslaget er, er målt — se `models.ts`.
 */
export const HIRES = {
  ukmo_uk_deterministic_2km: "UKMO 2 km",
  meteofrance_arome_france_hd: "AROME France HD",
  icon_d2: "ICON-D2",
  knmi_harmonie_arome_europe: "KNMI HARMONIE",
  dmi_harmonie_arome_europe: "DMI HARMONIE",
} as const;

export type EnsembleNøkkel = keyof typeof ENSEMBLE;
export type HiresNøkkel = keyof typeof HIRES;

export const ENSEMBLE_NØKLER = Object.keys(ENSEMBLE) as EnsembleNøkkel[];
export const HIRES_NØKLER = Object.keys(HIRES) as HiresNøkkel[];

/** Alle modeller som må hentes, uten dubletter (KNMI og DMI er i begge sett). */
export const ALLE_NØKLER: string[] = [...new Set<string>([...ENSEMBLE_NØKLER, ...HIRES_NØKLER])];

/** Månedsnavn slik Polymarket staver dem i slug-en. */
const MÅNEDER = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Polymarket-slug for en natt. Tar en ISO-dato (`2026-07-29`) i stedet for et
 * Date-objekt, nettopp fordi Date-objekter drar med seg tidssone-feil hit.
 */
export function slugFor(isoDato: string): string {
  const [år, md, dag] = isoDato.split("-").map(Number);
  return `lowest-temperature-in-london-on-${MÅNEDER[md - 1]}-${dag}-${år}`;
}

/**
 * Hvilken natt vi sikter på nå: dagens dato fram til markedet lukker 22:00 UTC,
 * deretter morgendagens. Samme regel som `london_low_logger.py:180`.
 *
 * Ren — tar tiden inn. Returnerer ISO-dato.
 */
export function målnatt(nåMs: number): string {
  const d = new Date(nåMs);
  const skift = d.getUTCHours() < MARKED_LUKKER_UTC ? 0 : 1;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + skift))
    .toISOString().slice(0, 10);
}
