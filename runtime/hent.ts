/**
 * Hentelaget — det urene skallet rundt den rene kjernen (byggeplanen fase 3).
 *
 * Kjernen i `core/` gjør ingen I/O med vilje. Alt som kan feile mot nettet
 * ligger her: retry med backoff, timeout, hurtigbuffer, respekt for API-grenser,
 * og et «sist oppdatert»-stempel på hvert svar.
 *
 * Alt tar en `Fetcher` inn i stedet for å kalle global `fetch` direkte. Det er
 * grunnen til at fase 3 kan testes fullt ut uten nettilgang: testene sender inn
 * en fetcher som svarer fra faste eksempeldata.
 *
 * SVARFORMEN. Aldri null for «noe gikk galt». Et hentet svar er ett av tre:
 *   ok      — vi har data
 *   tomt    — tjenesten svarte, men hadde ingenting (markedet er ikke åpnet)
 *   feil    — vi fikk ikke svar, og vet dermed ingenting
 * «Tomt» og «feil» ser like ut hvis begge blir null, og da fyller man arkivet
 * med feilslutninger. Det skjedde gjentatte ganger under utviklingen.
 */

export type Fetcher = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(n: string): string | null };
  json(): Promise<unknown>;
  text?(): Promise<string>;
}>;

export type Svar<T> =
  | { readonly utfall: "ok"; readonly data: T; readonly hentetMs: number; readonly fraBuffer: boolean }
  | { readonly utfall: "tomt"; readonly hentetMs: number }
  | { readonly utfall: "feil"; readonly grunn: string; readonly status: number | null };

export interface HentOpsjoner {
  readonly fetcher: Fetcher;
  /** Nåtidspunkt i ms — sendes inn, aldri lest fra klokka. */
  readonly nåMs: number;
  readonly forsøk?: number;
  readonly timeoutMs?: number;
  /** Levetid i hurtigbufferen. 0 slår den av. */
  readonly bufferMs?: number;
  /** Ventefunksjon. Byttes ut i test så ingen venter på ekte millisekunder. */
  readonly sov?: (ms: number) => Promise<void>;
  readonly logg?: (melding: string) => void;
}

/**
 * En ekte nettleser-UA. Polymarkets gamma-API svarer 403 på standard
 * script-agenter — samme grep som `london_low_logger.py` bruker, av samme grunn.
 */
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/525.36";

const STANDARD = { forsøk: 4, timeoutMs: 25_000, bufferMs: 120_000 } as const;

interface Bufret { data: unknown; hentetMs: number }

/**
 * Hurtigbuffer med levetid, nøklet på URL.
 *
 * Poenget er ikke å spare båndbredde, men å tåle å bli kalt flere ganger tett:
 * en serverløs funksjon som svarer på to forespørsler i samme sekund skal ikke
 * spørre Open-Meteo tolv ganger to ganger.
 */
export class Buffer {
  #lager = new Map<string, Bufret>();

  hent(url: string, nåMs: number, levetidMs: number): Bufret | null {
    const b = this.#lager.get(url);
    if (!b) return null;
    if (nåMs - b.hentetMs > levetidMs) { this.#lager.delete(url); return null; }
    return b;
  }

  sett(url: string, data: unknown, hentetMs: number): void {
    this.#lager.set(url, { data, hentetMs });
  }

  tøm(): void { this.#lager.clear(); }
  get størrelse(): number { return this.#lager.size; }
}

const sovStandard = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Er statuskoden verdt et nytt forsøk? 4xx utenom 429 blir ikke bedre. */
function kanPrøvesIgjen(status: number): boolean {
  if (status === 429) return true;
  return !(status >= 400 && status < 500);
}

/**
 * Hvor lenge vi venter før forsøk nummer `i` (0-indeksert).
 * Eksponentiell backoff, men `Retry-After` fra tjenesten vinner alltid —
 * det er den som vet når grensen løsner.
 */
export function ventetid(i: number, retryAfter: string | null): number {
  if (retryAfter) {
    const sek = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(sek) && sek >= 0) return Math.min(sek, 60) * 1000;
  }
  return 500 * 2 ** i;
}

/**
 * Hent JSON med retry. Kaster aldri — svarer med `Svar<unknown>`.
 *
 * `erTomt` avgjør hva som teller som «tjenesten svarte, men hadde ingenting».
 * Uten den ville et tomt marked blitt lest som en feil, og en feil som et tomt
 * marked.
 */
export async function hentJson(
  url: string,
  opt: HentOpsjoner,
  erTomt: (data: unknown) => boolean = () => false,
  buffer?: Buffer,
): Promise<Svar<unknown>> {
  const forsøk = opt.forsøk ?? STANDARD.forsøk;
  const timeoutMs = opt.timeoutMs ?? STANDARD.timeoutMs;
  const bufferMs = opt.bufferMs ?? STANDARD.bufferMs;
  const sov = opt.sov ?? sovStandard;

  if (buffer && bufferMs > 0) {
    const b = buffer.hent(url, opt.nåMs, bufferMs);
    if (b) {
      return erTomt(b.data)
        ? { utfall: "tomt", hentetMs: b.hentetMs }
        : { utfall: "ok", data: b.data, hentetMs: b.hentetMs, fraBuffer: true };
    }
  }

  let grunn = "ukjent feil";
  let status: number | null = null;

  for (let i = 0; i < forsøk; i++) {
    let retryAfter: string | null = null;
    try {
      const r = await opt.fetcher(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = r.status;

      if (r.ok) {
        let data: unknown;
        try {
          data = await r.json();
        } catch (e) {
          grunn = `ugyldig JSON: ${(e as Error).message}`;
          break;   // et ødelagt svar blir ikke helt av å spørre igjen
        }
        if (buffer && bufferMs > 0) buffer.sett(url, data, opt.nåMs);
        return erTomt(data)
          ? { utfall: "tomt", hentetMs: opt.nåMs }
          : { utfall: "ok", data, hentetMs: opt.nåMs, fraBuffer: false };
      }

      grunn = `HTTP ${r.status}`;
      retryAfter = r.headers.get("Retry-After");
      if (!kanPrøvesIgjen(r.status)) break;
    } catch (e) {
      grunn = (e as Error).name === "TimeoutError"
        ? `tidsavbrudd etter ${timeoutMs} ms`
        : (e as Error).message;
    }

    if (i < forsøk - 1) {
      const ms = ventetid(i, retryAfter);
      opt.logg?.(`  nytt forsøk om ${ms} ms (${grunn}) — ${url}`);
      await sov(ms);
    }
  }

  return { utfall: "feil", grunn, status };
}

/**
 * Kjør oppgaver med tak på hvor mange som går samtidig.
 *
 * Tolv modellspørringer på én gang har truffet Open-Meteos grense før. Fire om
 * gangen er raskt nok og høflig nok.
 */
export async function medTak<T, R>(
  ting: readonly T[],
  tak: number,
  gjør: (t: T, i: number) => Promise<R>,
): Promise<R[]> {
  const ut: R[] = new Array(ting.length);
  let neste = 0;
  const arbeider = async () => {
    while (true) {
      const i = neste++;
      if (i >= ting.length) return;
      ut[i] = await gjør(ting[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(tak, ting.length)) }, arbeider));
  return ut;
}

/**
 * Send JSON (POST/PATCH) med samme retry-regler som `hentJson`.
 *
 * Egen funksjon framfor et flagg på `hentJson`, fordi semantikken er en annen:
 * en skriving har ingen hurtigbuffer og ingen «tomt»-tilstand. Den lykkes eller
 * den gjør det ikke.
 *
 * ADVARSEL OM GJENTAKELSE. Retry på en skriving er bare trygt når endepunktet
 * er idempotent. Det er derfor `base.ts` skriver med `on_conflict` og
 * `resolution=merge-duplicates`: samme rad sendt to ganger gir én rad, ikke to.
 * Skal denne brukes mot noe som ikke er idempotent, sett `forsøk: 1`.
 */
export async function sendJson(
  url: string,
  kropp: unknown,
  opt: HentOpsjoner & { metode?: string; headere?: Record<string, string> },
): Promise<Svar<unknown>> {
  const forsøk = opt.forsøk ?? STANDARD.forsøk;
  const timeoutMs = opt.timeoutMs ?? STANDARD.timeoutMs;
  const sov = opt.sov ?? sovStandard;

  let grunn = "ukjent feil";
  let status: number | null = null;

  for (let i = 0; i < forsøk; i++) {
    let retryAfter: string | null = null;
    try {
      const r = await opt.fetcher(url, {
        method: opt.metode ?? "POST",
        headers: { "Content-Type": "application/json", ...opt.headere },
        body: JSON.stringify(kropp),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = r.status;

      if (r.ok) {
        // 204 og `return=minimal` har ingen kropp. Tom kropp er en suksess.
        let data: unknown = null;
        try { data = await r.json(); } catch { data = null; }
        return { utfall: "ok", data, hentetMs: opt.nåMs, fraBuffer: false };
      }

      // Feilkroppen fra PostgREST forklarer NØYAKTIG hva som er galt
      // (manglende kolonne, brutt constraint, feil nøkkel). Uten den famler man.
      let detalj = "";
      try { detalj = r.text ? (await r.text()).slice(0, 300) : ""; } catch { /* ikke viktig */ }
      grunn = `HTTP ${r.status}${detalj ? ` — ${detalj}` : ""}`;
      retryAfter = r.headers.get("Retry-After");
      if (!kanPrøvesIgjen(r.status)) break;
    } catch (e) {
      grunn = (e as Error).name === "TimeoutError"
        ? `tidsavbrudd etter ${timeoutMs} ms`
        : (e as Error).message;
    }

    if (i < forsøk - 1) {
      const ms = ventetid(i, retryAfter);
      opt.logg?.(`  nytt skriveforsøk om ${ms} ms (${grunn})`);
      await sov(ms);
    }
  }

  return { utfall: "feil", grunn, status };
}
