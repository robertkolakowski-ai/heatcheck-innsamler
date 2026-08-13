/**
 * Byene og markedstypene — ett sted, delt av nettleseren og serveren.
 *
 * HVORFOR DENNE FILEN FINNES
 * Bytabellen lå bare i `temp-bets.html`. Da snapshot-loggingen (B04) skulle
 * hente for de samme 21 byene fra serversiden, var valget mellom å duplisere
 * tabellen eller å flytte den hit. Duplisert ville de to kunne skli fra
 * hverandre uten at noe sa fra — og en by som stille falt ut av loggingen er
 * nettopp den typen hull man oppdager et halvår for sent.
 *
 * `core/test/byer.test.ts` klipper `CITIES` ut av HTML-filen og sammenlikner
 * felt for felt. Endres den ene, feiler testen — høyt.
 *
 * Koordinatene er oppløsningsflyplassene Polymarket gjør opp på, ikke
 * bysentrum. Det er ikke en detalj: markedet gjøres opp på stasjonens
 * observasjon, så prognosen må hentes for stasjonen.
 */

export interface By {
  /** Slug-en Polymarket bruker i markedsnavnet. */
  readonly slug: string;
  /** Navnet som vises, med stasjonen i parentes. */
  readonly navn: string;
  readonly lat: number;
  readonly lon: number;
  /**
   * ICAO-koden til oppgjørsstasjonen — nøkkelen METAR slås opp på.
   *
   * Koordinatene over og denne koden beskriver SAMME flyplass, og det er
   * meningen: prognosen hentes på koordinatene, observasjonen på koden.
   * Skiller de to lag, modellerer vi ett sted og måler et annet.
   */
  readonly icao: string;
  /**
   * Sonen stasjonens kalenderdøgn regnes i.
   *
   * Markedet gjøres opp på stasjonens LOKALE dag. For London betyr det
   * UTC om vinteren og UTC+1 om sommeren, og grensen flytter seg to ganger i
   * året — se `metar.ts:dagsmaks`.
   */
  readonly sone: string;
}

/**
 * ── HVOR ICAO OG SONE KOM FRA ─────────────────────────────────────────────
 *
 * `Weathermarket/daily_prediction_log.py` har hatt en `STATIONS`-tabell med de
 * samme 21 stasjonene siden den ble skrevet. Den var den eneste kopien, og den
 * lå i Python — utenfor rekkevidde for alt annet i repoet.
 *
 * De er flyttet hit av nøyaktig samme grunn som koordinatene ble det:
 * `core/test/byer.test.ts` klipper nå BEGGE kildene ut — `CITIES` fra
 * `temp-bets.html` og `STATIONS` fra Python-loggeren — og sammenlikner felt
 * for felt. Tre kopier som ikke kan gli fra hverandre slår tre kopier som kan.
 */
export const BYER: readonly By[] = [
  { slug: "nyc",          navn: "New York (LaGuardia)", lat: 40.7769,  lon: -73.8740,  icao: "LGA",  sone: "America/New_York" },
  { slug: "chicago",      navn: "Chicago (O'Hare)",     lat: 41.9742,  lon: -87.9073,  icao: "ORD",  sone: "America/Chicago" },
  { slug: "los-angeles",  navn: "Los Angeles (LAX)",    lat: 33.9416,  lon: -118.4085, icao: "LAX",  sone: "America/Los_Angeles" },
  { slug: "dallas",       navn: "Dallas (Love Field)",  lat: 32.8471,  lon: -96.8518,  icao: "DAL",  sone: "America/Chicago" },
  { slug: "seattle",      navn: "Seattle (Sea-Tac)",    lat: 47.4502,  lon: -122.3088, icao: "SEA",  sone: "America/Los_Angeles" },
  { slug: "toronto",      navn: "Toronto (Pearson)",    lat: 43.6777,  lon: -79.6248,  icao: "CYYZ", sone: "America/Toronto" },
  { slug: "london",       navn: "London (City)",        lat: 51.5048,  lon: 0.0495,    icao: "EGLC", sone: "Europe/London" },
  { slug: "paris",        navn: "Paris (Le Bourget)",   lat: 48.9694,  lon: 2.4414,    icao: "LFPB", sone: "Europe/Paris" },
  { slug: "amsterdam",    navn: "Amsterdam (Schiphol)", lat: 52.3105,  lon: 4.7683,    icao: "EHAM", sone: "Europe/Amsterdam" },
  { slug: "madrid",       navn: "Madrid (Barajas)",     lat: 40.4936,  lon: -3.5668,   icao: "LEMD", sone: "Europe/Madrid" },
  { slug: "munich",       navn: "Munich",               lat: 48.3538,  lon: 11.7861,   icao: "EDDM", sone: "Europe/Berlin" },
  { slug: "tokyo",        navn: "Tokyo (Haneda)",       lat: 35.5494,  lon: 139.7798,  icao: "RJTT", sone: "Asia/Tokyo" },
  { slug: "seoul",        navn: "Seoul (Incheon)",      lat: 37.4602,  lon: 126.4407,  icao: "RKSI", sone: "Asia/Seoul" },
  { slug: "beijing",      navn: "Beijing (Capital)",    lat: 40.0801,  lon: 116.5846,  icao: "ZBAA", sone: "Asia/Shanghai" },
  { slug: "shanghai",     navn: "Shanghai (Pudong)",    lat: 31.1443,  lon: 121.8083,  icao: "ZSPD", sone: "Asia/Shanghai" },
  { slug: "guangzhou",    navn: "Guangzhou (Baiyun)",   lat: 23.3924,  lon: 113.2988,  icao: "ZGGG", sone: "Asia/Shanghai" },
  { slug: "shenzhen",     navn: "Shenzhen (Bao'an)",    lat: 22.6393,  lon: 113.8107,  icao: "ZGSZ", sone: "Asia/Shanghai" },
  { slug: "chengdu",      navn: "Chengdu (Shuangliu)",  lat: 30.5785,  lon: 103.9471,  icao: "ZUUU", sone: "Asia/Shanghai" },
  { slug: "singapore",    navn: "Singapore (Changi)",   lat: 1.3644,   lon: 103.9915,  icao: "WSSS", sone: "Asia/Singapore" },
  { slug: "taipei",       navn: "Taipei (Songshan)",    lat: 25.0694,  lon: 121.5525,  icao: "RCSS", sone: "Asia/Taipei" },
  { slug: "kuala-lumpur", navn: "Kuala Lumpur (KLIA)",  lat: 2.7456,   lon: 101.7099,  icao: "WMKK", sone: "Asia/Kuala_Lumpur" },
];

/**
 * De to markedstypene.
 *
 * `highest` finnes for alle 21 byene. `lowest` finnes i dag bare for London —
 * det er markedet Temp-Trader handler. Loggingen spør likevel etter begge for
 * alle byer: finnes ikke markedet, svarer Gamma tomt, og det registreres som
 * «ikke notert» i stedet for som en feil. Dukker et lowest-marked opp for en
 * ny by, blir det logget fra første time uten at noe må endres.
 */
export type Markedstype = "highest" | "lowest";
export const MARKEDSTYPER: readonly Markedstype[] = ["highest", "lowest"];

const MÅNEDER = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Polymarket-slug for en by, markedstype og dato.
 *
 * Tar ISO-dato som streng og ikke et Date-objekt — av samme grunn som
 * `models.ts:slugFor`: Date-objekter drar tidssonefeil med seg hit.
 *
 *   byslug("nyc", "highest", "2026-07-31")
 *     → "highest-temperature-in-nyc-on-july-31-2026"
 */
export function byslug(by: string, type: Markedstype, isoDato: string): string {
  const [år, md, dag] = isoDato.split("-").map(Number);
  return `${type}-temperature-in-${by}-on-${MÅNEDER[md - 1]}-${dag}-${år}`;
}

/** Oppslag på slug. Returnerer undefined for en by vi ikke kjenner. */
export function finnBy(slug: string): By | undefined {
  return BYER.find((b) => b.slug === slug);
}
