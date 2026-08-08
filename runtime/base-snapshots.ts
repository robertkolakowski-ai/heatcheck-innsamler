/**
 * SNAPSHOT-SKRIVING TIL POSTGRES — den delen innsamleren trenger, og bare den.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  HVORFOR DENNE FILEN ER SKILT UT FRA `base.ts`
 *
 *  B04-innsamleren importerte fem symboler fra `base.ts`. Filen har mange
 *  flere, og resten er radskjemaene for de andre delene av systemet.
 *
 *  Innsamleren skal kunne kjøre der koden er lesbar for andre. Da er det ikke
 *  nok at den ikke BRUKER de andre skjemaene — de kan ikke ligge i filen den
 *  drar med seg. Et skjema forteller hva som måles, og hva som måles er en
 *  vesentlig del av hva som er verdt å vite. Se `docs/DELING.md`.
 *
 *  Og av samme grunn står feltnavnene deres ikke her. En kommentar som
 *  forklarer hva den slapp å ta med, ved å liste opp hva den slapp å ta med,
 *  har ikke sluppet noe. Hvilke felter det gjelder står i `docs/DELING.md`, som
 *  ikke følger med hit.
 *
 *  `base.ts` re-eksporterer alt herfra, så skillet er usynlig for eksisterende
 *  importer.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Snakker med PostgREST direkte over HTTP i stedet for å bruke
 *  `@supabase/supabase-js`: null avhengigheter i kjøretid, samme retry- og
 *  timeout-regler som resten av hentelaget, og en `Fetcher` inn — så også
 *  denne delen kan prøves uten nett.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  SIKKERHET — LES DETTE
 *
 *  Skriving krever en nøkkel som kan skrive. I det PRIVATE repoet er det
 *  `service_role`, som går utenom alle RLS-policyer og kan endre alt.
 *
 *  I ET ÅPENT REPO SKAL DEN ALDRI BRUKES. Lag i stedet en Supabase-rolle med
 *  `insert` bare på snapshot-tabellene. Angrepsflaten på et åpent repo er
 *  større, og en service_role-nøkkel på avveie der er hele basen.
 *
 *  Uansett rolle: aldri i git, aldri til nettleseren, bare som hemmelighet i
 *  Actions og i Vercels servermiljø.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { sendJson, type HentOpsjoner, type Svar } from "./hent.ts";

export interface BaseOppsett {
  /** `https://<prosjekt>.supabase.co` — uten skråstrek på slutten. */
  readonly url: string;
  /** service_role-nøkkelen. Se advarselen over. */
  readonly nøkkel: string;
  /** Postgres-skjema. Se `STANDARD_SKJEMA`. */
  readonly skjema: string;
}

/**
 * Vi bor i et EGET skjema, ikke i `public`.
 *
 * Supabases gratisnivå tillater to prosjekter, så denne basen deler prosjekt
 * med noe annet. `predictions` og `outcomes` er generiske navn som godt kan
 * finnes der fra før; i eget skjema kan de ikke kollidere.
 *
 * Får du senere et eget prosjekt og vil bruke `public`, sett
 * `SUPABASE_SCHEMA=public` — og husk å bytte i `db/schema.sql` også.
 */

export const STANDARD_SKJEMA = "temptrader";

/** Navnene vi leter etter i miljøet. */

export const MILJØ = {
  url: "SUPABASE_URL",
  nøkkel: "SUPABASE_SERVICE_ROLE_KEY",
  skjema: "SUPABASE_SCHEMA",
} as const;

export type OppsettResultat =
  | { readonly status: "ok"; readonly oppsett: BaseOppsett }
  | { readonly status: "mangler"; readonly navn: readonly string[] }
  | { readonly status: "ugyldig"; readonly grunn: string };

/**
 * Les oppsettet ut av miljøet.
 *
 * Skiller «ikke satt opp» fra «satt opp feil». Den vanligste feilen er å lime
 * inn Postgres-tilkoblingsstrengen (`postgresql://…`) i stedet for prosjekt-URL-en
 * (`https://….supabase.co`). Uten dette skillet gir det bare «kunne ikke skrive»
 * og du leter på feil sted — samme lærdom som `Weathermarket/api/_store.js`
 * bygger på.
 */

export function lesOppsett(env: Record<string, string | undefined>): OppsettResultat {
  const url = env[MILJØ.url]?.trim();
  const nøkkel = env[MILJØ.nøkkel]?.trim();

  const mangler = [
    ...(url ? [] : [MILJØ.url]),
    ...(nøkkel ? [] : [MILJØ.nøkkel]),
  ];
  if (mangler.length) return { status: "mangler", navn: mangler };

  if (!/^https:\/\/[^/]+$/.test(url!)) {
    return {
      status: "ugyldig",
      grunn: `${MILJØ.url} skal være «https://<prosjekt>.supabase.co» uten ` +
        `skråstrek på slutten og uten sti. Fikk «${url}». ` +
        `(Limte du inn Postgres-tilkoblingsstrengen i stedet?)`,
    };
  }
  if (nøkkel!.length < 30) {
    return { status: "ugyldig", grunn: `${MILJØ.nøkkel} ser for kort ut til å være en nøkkel.` };
  }

  // Er det LESE-nøkkelen? Den vanligste oppsettsfeilen, og verdt å fange her
  // framfor å la den bli et 401 lenger nede.
  const feilNøkkel = erLesenøkkel(nøkkel!);
  if (feilNøkkel) {
    return {
      status: "ugyldig",
      grunn: `${MILJØ.nøkkel} er ${feilNøkkel} — altså LESE-nøkkelen. Den kan ` +
        `ikke skrive; RLS gir den bare SELECT.\n` +
        `     Du trenger skrivenøkkelen: «sb_secret_…», eller en JWT med ` +
        `role=service_role.\n` +
        `     Supabase → Project Settings → API. Den må avsløres med et klikk — ` +
        `den vises ikke i lista slik den publiserbare gjør.`,
    };
  }

  const skjema = env[MILJØ.skjema]?.trim() || STANDARD_SKJEMA;
  if (!/^[a-z_][a-z0-9_]*$/.test(skjema)) {
    return { status: "ugyldig", grunn: `${MILJØ.skjema} «${skjema}» er ikke et gyldig skjemanavn.` };
  }

  return { status: "ok", oppsett: { url: url!, nøkkel: nøkkel!, skjema } };
}

/**
 * Er dette lese-nøkkelen i stedet for skrivenøkkelen?
 *
 * Returnerer en beskrivelse av hva den er hvis den er feil, ellers null.
 * To navnesett i bruk hos Supabase:
 *
 *   nytt:   sb_publishable_…  (lese)   ·  sb_secret_…  (skrive)
 *   gammelt: JWT med role=anon (lese)  ·  JWT med role=service_role (skrive)
 *
 * JWT-en dekodes uten å verifiseres — vi leser bare `role` fra nyttelasten for
 * å kunne si HVILKEN nøkkel det er. Ingen sikkerhetsbeslutning henger på det;
 * hensikten er en presis feilmelding i stedet for et kryptisk 401.
 */

function erLesenøkkel(nøkkel: string): string | null {
  if (nøkkel.startsWith("sb_publishable_")) return "en «sb_publishable_»-nøkkel";

  const deler = nøkkel.split(".");
  if (deler.length === 3) {
    try {
      const nyttelast = JSON.parse(
        Buffer.from(deler[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
      ) as { role?: unknown };
      if (nyttelast.role === "anon") return "en JWT med role=anon";
    } catch {
      // Ikke dekodbar — da uttaler vi oss ikke. sjekkTilkobling() fanger et
      // eventuelt 401 med sitt eget hint.
    }
  }
  return null;
}

/**
 * Headere for skriving.
 *
 * `Content-Profile` velger Postgres-skjema for skrivinger; `Accept-Profile`
 * gjør det for lesinger. Uten dem går PostgREST mot `public`, finner ingenting,
 * og svarer 404 — selv om tabellene ligger der de skal.
 *
 * Skjemaet må i tillegg være eksponert i Supabase (Project Settings → API →
 * Exposed schemas). Det er et manuelt steg, og det er den vanligste grunnen
 * til 404 her.
 */

export function skriveHeadere(o: BaseOppsett): Record<string, string> {
  return {
    apikey: o.nøkkel,
    Authorization: `Bearer ${o.nøkkel}`,
    "Content-Profile": o.skjema,
    "Accept-Profile": o.skjema,
    // merge-duplicates = upsert. Sammen med on_conflict gjør det skrivingen
    // idempotent, slik at retry er trygt og en gjenkjøring ikke dobler rader.
    Prefer: "resolution=merge-duplicates,return=minimal",
  };
}

/**
 * Skriv (eller oppdater) prediksjonsrader.
 *
 * Konflikt på `(night, logged_at)` — samme lesning to ganger gir én rad.
 * Radformen er akkurat `RikRad`, som en test holder i sync med `db/schema.sql`,
 * så det er ingen kartlegging her å holde à jour.
 */

export interface PrognoseSnapshot {
  source: string;
  city: string;
  market_type: "highest" | "lowest";
  target_date: string;
  fetched_at: string;
  value: number | null;
  unit?: "celsius" | "fahrenheit";
}

/** Én rad i `<skjema>.price_snapshots`. Enheten er markedets egen. */
export interface PrisSnapshot {
  city: string;
  market_type: "highest" | "lowest";
  target_date: string;
  fetched_at: string;
  bucket_label: string;
  bucket_low: number | null;
  bucket_high: number | null;
  unit: "celsius" | "fahrenheit";
  yes_ask: number | null;
  yes_bid: number | null;
  yes_mid: number | null;
  market_status: "ok" | "tomt" | "feil" | null;
}

/**
 * PostgREST tar imot store bulk-innlegg, men et kall som feiler halvveis
 * tvinger hele runden om igjen. Delt i porsjoner blir en time med data mange
 * små skrivinger som hver er idempotent — og et hull blir én porsjon, ikke
 * hele timen.
 */
const PORSJON = 500;

export async function skrivIPorsjoner<T>(
  rader: readonly T[],
  url: string,
  oppsett: BaseOppsett,
  opt: HentOpsjoner,
): Promise<Svar<unknown>> {
  if (!rader.length) return { utfall: "ok", data: null, hentetMs: opt.nåMs, fraBuffer: false };
  let siste: Svar<unknown> = { utfall: "ok", data: null, hentetMs: opt.nåMs, fraBuffer: false };
  for (let i = 0; i < rader.length; i += PORSJON) {
    siste = await sendJson(url, rader.slice(i, i + PORSJON), { ...opt, headere: skriveHeadere(oppsett) });
    if (siste.utfall !== "ok") return siste;   // stopp på første feil, ikke skriv videre i blinde
  }
  return siste;
}

export function skrivPrognoseSnapshots(
  rader: readonly PrognoseSnapshot[],
  oppsett: BaseOppsett,
  opt: HentOpsjoner,
): Promise<Svar<unknown>> {
  return skrivIPorsjoner(
    rader,
    `${oppsett.url}/rest/v1/forecast_snapshots`
      + `?on_conflict=source,city,market_type,target_date,fetched_at`,
    oppsett, opt,
  );
}

export function skrivPrisSnapshots(
  rader: readonly PrisSnapshot[],
  oppsett: BaseOppsett,
  opt: HentOpsjoner,
): Promise<Svar<unknown>> {
  return skrivIPorsjoner(
    rader,
    `${oppsett.url}/rest/v1/price_snapshots`
      + `?on_conflict=city,market_type,target_date,fetched_at,bucket_label`,
    oppsett, opt,
  );
}

/**
 * Én rad i `<skjema>.shadow_orders` — speilet av `data/skygge/`.
 *
 * Fila er primærkilden. Denne finnes for at de to skal kunne AVSTEMMES: port
 * G3 krever ikke bare at kjøreren har gått i to uker, men at loggen er
 * avstemt, og en kjøring som skrev det ene lageret og ikke det andre er
 * nettopp feilen som ellers ikke blir rød.
 */
