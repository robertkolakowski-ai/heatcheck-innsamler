/**
 * METAR — stasjonsobservasjonen, tolket. Ren, og med NULL IMPORTER.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  HVORFOR FILEN IKKE IMPORTERER NOE SOM HELST
 *
 *  Denne filen hører til innsamlingen, ikke til beslutningen, og skal kunne
 *  følge med til det åpne repoet — se `docs/DELING.md`. Importgrafen derfra
 *  følges transitivt av `runtime/test/deling.test.ts`, og ETT importledd kan
 *  dra hele beslutningslaget med seg.
 *
 *  Det gjelder også filer som ser uskyldige ut fordi de bare inneholder
 *  tallverktøy: det er ikke koden som er problemet, det er hva prosaen rundt
 *  den røper. Trenger denne filen en avrunding, skriver den den selv.
 *
 *  Og derfor ligger IKKE bøttevalget her. «Hvilken bøtte vant» hører til
 *  tolkningen; «hva viste termometeret» er observasjonen. Den som skal gjøre
 *  om et måltall til en bøtte, gjør det på den andre siden av skillet.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── HVA EN METAR ER, OG HVORFOR AKKURAT DEN ───────────────────────────────
 *
 * Markedene gjøres opp mot Wundergrounds dagshistorikk for oppgjørsstasjonen,
 * og Wunderground viser METAR-rapportene fra den stasjonen. Maksimum over
 * rutine- OG hendelsesrapporter er derfor størrelsen som skal regnes ut her.
 * Hvor godt den har truffet, er målt et annet sted — se `models.ts`.
 *
 * Stasjonene sender rutine-METAR hver halvtime, pluss SPECI når noe endrer seg
 * brått. Det er derfor tettere polling kjøper LATENS og ikke oppløsning.
 *
 * ── GRADER, IKKE FAHRENHEIT ───────────────────────────────────────────────
 *
 * Temperaturgruppen i en METAR står i HELE grader Celsius — `24/14` er 24 °C
 * med duggpunkt 14 °C, `M02/M05` er −2 og −5. Markedet gjør også opp i hele
 * grader Celsius.
 *
 * Den eksisterende Python-stien henter `data=tmpf` fra IEM, altså Fahrenheit
 * som IEM selv har regnet om FRA de hele gradene, og regner tilbake med
 * `(mx-32)*5/9`. Turen fram og tilbake er tapsfri i teorien og gir
 * `28.000000000000004` i praksis. Her leses gruppen direkte. °F-stien beholdes
 * som kryssjekk i `tools/observasjon-check.mjs`, ikke som kilde.
 *
 * ── TIDEN KOMMER UTENFRA ──────────────────────────────────────────────────
 *
 * `DDHHMMZ` i rapporten bærer bare dag-i-måneden. Hvilken måned og hvilket år
 * det er, må komme fra et referansetidspunkt — som sendes inn, aldri leses fra
 * klokka. Det er samme regel som resten av kjernen følger, og her er den ekstra
 * viktig: en rapport lest 1. i måneden kan bære dag 31.
 */

/** Én stasjonsobservasjon, tolket ut av én METAR-rapport. */
export interface Observasjon {
  readonly icao: string;
  /** Observasjonstidspunktet, ISO i UTC. Dette er `valid`-tiden, ikke lesetiden. */
  readonly gyldigUtc: string;
  /** Hele grader Celsius. Null når gruppen mangler eller er maskert (`//`). */
  readonly tempC: number | null;
  readonly duggpunktC: number | null;
  readonly vindKt: number | null;
  readonly vindKastKt: number | null;
  /** Grader. Null ved variabel retning (`VRB`) — som ikke er det samme som 0. */
  readonly vindRetning: number | null;
  readonly trykkHpa: number | null;
  /** `SPECI` er en hendelsesrapport, `METAR` er den halvtimede rutinen. */
  readonly rapporttype: "METAR" | "SPECI";
  /** Automatstasjon uten menneskelig kvalitetssikring. */
  readonly auto: boolean;
  /** Korrigert utgave av en tidligere rapport. */
  readonly korrigert: boolean;
  /** Rapporten uendret. Lagres alltid — det er den som kan tolkes på nytt. */
  readonly rå: string;
}

/**
 * Der rapporten slutter å beskrive NÅ.
 *
 * `RMK` er nasjonale tillegg, `TEMPO`/`BECMG` er varsel om endring, og begge
 * kan inneholde grupper som ser ut som de gjelder observasjonen. `NOSIG` er
 * ufarlig men markerer samme grense. Kuttes de ikke bort, kan en trendgruppe
 * levere en vind eller et trykk som aldri er målt.
 */
const SLUTT = /\b(RMK|TEMPO|BECMG|NOSIG)\b/;

/** Tallet i en METAR-gruppe: `M02` er −2, `//` er ukjent. */
function grad(s: string | undefined): number | null {
  if (!s || s.includes("/")) return null;
  const negativ = s.startsWith("M");
  const n = Number(negativ ? s.slice(1) : s);
  return Number.isFinite(n) ? (negativ ? -n : n) : null;
}

/**
 * `DDHHMMZ` løst mot et referansetidspunkt.
 *
 * Kandidatene er samme måned som referansen, måneden før og måneden etter.
 * Den som ligger nærmest referansen vinner. Det håndterer månedsskiftet i
 * begge retninger — en rapport fra 31. lest 1. i neste måned, og en rapport
 * fra 1. lest 31. i forrige — uten å anta hvilken vei skjevheten går.
 */
export function løsTid(dd: number, hh: number, mm: number, referanseMs: number): string | null {
  if (!(dd >= 1 && dd <= 31 && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;

  const r = new Date(referanseMs);
  let beste: number | null = null;
  for (const skift of [-1, 0, 1]) {
    const t = Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + skift, dd, hh, mm, 0);
    // Date.UTC ruller over ved ugyldig dag (31. februar → 3. mars). En slik
    // kandidat er ikke datoen rapporten oppga, og skal ikke kunne vinne.
    if (new Date(t).getUTCDate() !== dd) continue;
    if (beste === null || Math.abs(t - referanseMs) < Math.abs(beste - referanseMs)) beste = t;
  }
  return beste === null ? null : new Date(beste).toISOString();
}

/**
 * Tolk én METAR-rapport. Null når den ikke er en.
 *
 * `referanseMs` brukes bare til å løse dag-i-måneden. Kommer tiden fra
 * innpakningen (AWC oppgir `obsTime`, IEM oppgir `valid`), send den inn her —
 * da er dagvalget aldri tvetydig, og en rapport som er uenig med sin egen
 * innpakning blir synlig som en avstand i stedet for å bli tolket bort.
 */
export function lesMetar(rå: string, referanseMs: number): Observasjon | null {
  const hel = String(rå || "").trim();
  if (!hel) return null;

  const kuttet = hel.split(SLUTT)[0];
  const ord = kuttet.toUpperCase().split(/\s+/).filter(Boolean);
  if (!ord.length) return null;

  // Typen står som første ord når den står i det hele tatt. AWC og IEM er
  // uenige om de tar den med, så fraværet betyr rutine og ikke ukjent.
  const rapporttype: "METAR" | "SPECI" = ord[0] === "SPECI" ? "SPECI" : "METAR";

  const icao = ord.find((o) => /^[A-Z]{4}$/.test(o) && o !== "METAR" && o !== "SPECI" && o !== "AUTO");
  if (!icao) return null;

  const tid = ord.find((o) => /^\d{6}Z$/.test(o));
  if (!tid) return null;
  const gyldigUtc = løsTid(Number(tid.slice(0, 2)), Number(tid.slice(2, 4)), Number(tid.slice(4, 6)), referanseMs);
  if (!gyldigUtc) return null;

  // Temperaturgruppen er `TT/DD`, begge tosifret, begge kan ha M foran og
  // duggpunktet kan være maskert. Mønsteret er forankret i begge ender nettopp
  // for å ikke spise banesikt (`R09/0800`) eller sikt (`9999`).
  const temp = ord.find((o) => /^(M?\d{2})\/(M?\d{2}|\/\/)?$/.test(o));
  const tempDeler = temp ? /^(M?\d{2})\/(M?\d{2}|\/\/)?$/.exec(temp) : null;

  const vind = ord.find((o) => /^(\d{3}|VRB)\d{2,3}(G\d{2,3})?(KT|MPS|KMH)$/.test(o));
  const vindDeler = vind ? /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/.exec(vind) : null;

  // Bare knop leses. MPS og KMH finnes, men ikke på EGLC, og en omregning
  // ingen har sett et ekte svar fra er en gjetning som ser ut som en verdi.
  const iKnop = vindDeler?.[4] === "KT";

  const trykk = ord.find((o) => /^Q\d{4}$/.test(o));

  return {
    icao,
    gyldigUtc,
    tempC: grad(tempDeler?.[1]),
    duggpunktC: grad(tempDeler?.[2]),
    vindKt: iKnop && vindDeler ? Number(vindDeler[2]) : null,
    vindKastKt: iKnop && vindDeler?.[3] ? Number(vindDeler[3]) : null,
    vindRetning: vindDeler && vindDeler[1] !== "VRB" ? Number(vindDeler[1]) : null,
    trykkHpa: trykk ? Number(trykk.slice(1)) : null,
    rapporttype,
    auto: ord.includes("AUTO"),
    korrigert: ord.includes("COR"),
    rå: hel,
  };
}

/* ── lokal dato ─────────────────────────────────────────────────────────── */

const FORMATER = new Map<string, Intl.DateTimeFormat>();

/**
 * Datoen veggklokka i `sone` viser på et øyeblikk, som `YYYY-MM-DD`.
 *
 * `Intl` og ikke en egen tidssonetabell: tabellen finnes allerede i både Node
 * og nettleseren, og en kopi i dette repoet ville blitt gammel uten at noe sa
 * fra. Samme begrunnelse som `inngang.ts` gir — men IKKE samme funksjon:
 * den regner ut forskyvning i minutter, denne svarer på hvilken dato det er.
 * To spørsmål, to funksjoner, ingen kopi.
 */
export function lokalDato(ms: number, sone: string): string {
  let f = FORMATER.get(sone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: sone, year: "numeric", month: "2-digit", day: "2-digit",
    });
    FORMATER.set(sone, f);
  }
  // `en-CA` gir ISO-rekkefølge. Delene settes sammen eksplisitt likevel, fordi
  // noen ICU-versjoner skyter inn usynlige tegn i den ferdige strengen.
  const felt: Record<string, string> = {};
  for (const d of f.formatToParts(new Date(ms))) {
    if (d.type !== "literal") felt[d.type] = d.value;
  }
  return `${felt.year}-${felt.month}-${felt.day}`;
}

/* ── dagsmaksimum ───────────────────────────────────────────────────────── */

/** Det `dagsmaks` trenger å vite om en observasjon. */
export interface Målepunkt {
  readonly gyldigUtc: string;
  readonly tempC: number | null;
  readonly rapporttype?: "METAR" | "SPECI";
  /** Hvem den kom fra. Aldri slått sammen — se `dagsmaks`. */
  readonly kilde?: string;
}

export interface Dagsmaks {
  /** Høyeste målte temperatur i døgnet, °C. Null når ingen målinger finnes. */
  readonly maksC: number | null;
  /** Når maksimum ble satt. Ved likhet vinner det FØRSTE tidspunktet. */
  readonly tidspunkt: string | null;
  /** Hvor mange målinger som lå innenfor døgnet i det hele tatt. */
  readonly antall: number;
  /** Hvor mange av dem som manglet temperatur — et hull er ikke en null. */
  readonly utenTemp: number;
  readonly rapporttyper: { readonly METAR: number; readonly SPECI: number };
}

export interface DagsmaksOpsjoner {
  /** Ta bare med disse rapporttypene. Utelatt = begge. */
  readonly rapporttyper?: ReadonlyArray<"METAR" | "SPECI">;
  /** Ta bare med denne kilden. Utelatt = alle — se advarselen i `dagsmaks`. */
  readonly kilde?: string;
}

/**
 * Høyeste temperatur innenfor ett LOKALT døgn.
 *
 * ── Døgnet er lokalt, og det er ikke en detalj ────────────────────────────
 *
 * Markedet gjøres opp på stasjonens egen kalenderdag. I `Europe/London` betyr
 * det UTC om vinteren og UTC+1 om sommeren, og grensen flytter seg to ganger i
 * året. Regnes døgnet i UTC hele året, er svaret feil hver eneste sommerdag
 * mellom 23:00 og 24:00 UTC — en feil som er usynlig i elleve av tolv måneder
 * og som ville flyttet et maksimum til feil dag akkurat når det er varmest.
 *
 * ── ⚠ BLAND ALDRI KILDER ──────────────────────────────────────────────────
 *
 * Uten `opt.kilde` regnes maksimum over ALT som sendes inn. Kommer det fra to
 * kilder, er svaret et maksimum over foreningen — som er høyere enn hver av
 * dem, og som ikke er noen kildes svar. Det er nyttig for å oppdage at to
 * kilder er uenige, og ubrukelig som fasit. Skal tallet brukes til noe, send
 * inn én kilde.
 */
export function dagsmaks(
  målepunkter: readonly Målepunkt[],
  isoDato: string,
  sone: string,
  opt: DagsmaksOpsjoner = {},
): Dagsmaks {
  let maksC: number | null = null;
  let tidspunkt: string | null = null;
  let antall = 0;
  let utenTemp = 0;
  const rapporttyper = { METAR: 0, SPECI: 0 };

  for (const m of målepunkter) {
    if (opt.kilde !== undefined && m.kilde !== opt.kilde) continue;
    const type = m.rapporttype ?? "METAR";
    if (opt.rapporttyper && !opt.rapporttyper.includes(type)) continue;

    const ms = Date.parse(m.gyldigUtc);
    if (!Number.isFinite(ms)) continue;
    if (lokalDato(ms, sone) !== isoDato) continue;

    antall++;
    rapporttyper[type]++;
    if (m.tempC === null || m.tempC === undefined) { utenTemp++; continue; }

    // Streng ulikhet: ved likhet beholdes det FØRSTE tidspunktet. Uten det
    // ville «når ble maksimum satt» avhengt av rekkefølgen listen kom i.
    if (maksC === null || m.tempC > maksC) { maksC = m.tempC; tidspunkt = m.gyldigUtc; }
    else if (m.tempC === maksC && tidspunkt !== null && ms < Date.parse(tidspunkt)) tidspunkt = m.gyldigUtc;
  }

  return { maksC, tidspunkt, antall, utenTemp, rapporttyper };
}

/**
 * Alderen på den ferskeste observasjonen, i sekunder. Null når det ikke finnes
 * noen.
 *
 * Spesifikasjonens `age_seconds`. Den hører hjemme her og ikke i hentelaget,
 * fordi «hvor gammelt er det ferskeste vi VET» er et spørsmål om dataene og
 * ikke om nettverket: en henting som lyktes uten å gi noe nytt, gjør ikke
 * observasjonen ferskere.
 */
export function alderSek(målepunkter: readonly Målepunkt[], nåMs: number): number | null {
  let nyeste: number | null = null;
  for (const m of målepunkter) {
    const ms = Date.parse(m.gyldigUtc);
    if (!Number.isFinite(ms)) continue;
    if (nyeste === null || ms > nyeste) nyeste = ms;
  }
  return nyeste === null ? null : Math.round((nåMs - nyeste) / 1000);
}
