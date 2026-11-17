// discover-educ-orgs
// Daily automation. Finds ~10 NET-NEW schools/associations per run (AU/US/UK)
// via the Apify Google-Maps scraper, deduped against manually_found_educ_leads
// AND auto_found_educ_leads, and UPSERTS them into auto_found_educ_leads.
//
// Rotating cursor: walks educ_discovery_config cells oldest-first, one cell at a
// time, until TARGET_NEW net-new orgs are saved (or cells / safety cap run out),
// stamping last_run_at so the next day continues where this one stopped.
//
// Triggered by pg_cron (net.http_post). Kicks real work into a background task
// and returns 202 so it never hits the request timeout.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APIFY_API_TOKEN, PUSH_SHARED_SECRET.
// Deploy --no-verify-jwt.
// Debug params: ?sync=1 (run inline + return JSON), ?dry=1 (no DB writes),
//               ?target=N (override net-new target), ?region=Sydney (filter cells).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { apifyProbe, apifyScrape, hasApifyToken } from "../_shared/apify.ts";
import { appendRows, hasSheetsSA } from "../_shared/sheets.ts";
import {
  type Candidate,
  normName,
  passesFilter,
  type Settings,
  toCandidate,
} from "../_shared/normalize.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PUSH_SHARED_SECRET = Deno.env.get("PUSH_SHARED_SECRET") ?? "";
const ACTOR = Deno.env.get("APIFY_ACTOR_GOOGLE_MAPS") ?? "compass/crawler-google-places";
// Hard wall so the run always exits cleanly (writes audit + cursor stamps) before
// the edge runtime kills it, even if the target isn't reached.
const MAX_RUN_MS = parseInt(Deno.env.get("MAX_RUN_MS") ?? "120000", 10);

// Mirror unlogged orgs into a Google Sheet tab. Columns A..F, in order:
// org_name | school_or_association | country | region | website | category
// (col G "Liv's Remark" is a human column, left untouched).
const SHEET_ID = Deno.env.get("SHEETS_SPREADSHEET_ID") ?? "1svksxHmNBUx9Z20t2kbtHAT1fThcfdCmz5dEp936L7I";
const SHEET_TAB = Deno.env.get("SHEETS_TAB") ?? "ai_scraped_educ_leads";

const COUNTRY_NAME: Record<string, string> = {
  AU: "Australia",
  US: "USA",
  UK: "United Kingdom",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
    },
  });

type RunOpts = { dry: boolean; target: number | null; region: string | null; trigger: string };

type Summary = {
  fn: string;
  ran_at: string;
  trigger: string;
  dry: boolean;
  target_new: number;
  places_found: number;
  candidates_kept: number;
  inserted: number;
  skipped_existing: number;
  cells_processed: Array<{ country: string; region: string; search_term: string; found: number; kept: number }>;
  apify_runs: Array<{ actor: string; cell: string; items: number; error?: string }>;
  sample: Array<{ org_name: string; country: string | null; school_or_association: string }>;
  sheet_appended: number;
  sheet_error: string | null;
  ok: boolean;
  error: string | null;
  duration_ms: number;
};

// deno-lint-ignore no-explicit-any
async function loadSettings(db: any): Promise<Settings & { target_new: number; max_cells_run: number }> {
  const { data, error } = await db
    .from("educ_discovery_settings")
    .select("target_new, reviews_floor, max_cells_run, include_keywords, exclude_keywords, include_categories, exclude_categories")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`load settings: ${error.message}`);
  return {
    target_new: data?.target_new ?? 10,
    reviews_floor: data?.reviews_floor ?? 15,
    max_cells_run: data?.max_cells_run ?? 40,
    include_keywords: data?.include_keywords ?? [],
    exclude_keywords: data?.exclude_keywords ?? [],
    include_categories: data?.include_categories ?? [],
    exclude_categories: data?.exclude_categories ?? [],
  };
}

// deno-lint-ignore no-explicit-any
async function loadDedupSet(db: any): Promise<Set<string>> {
  const seen = new Set<string>();
  const { data: manual, error: e1 } = await db
    .from("manually_found_educ_leads").select("account").limit(20000);
  if (e1) throw new Error(`load manual leads: ${e1.message}`);
  for (const r of manual ?? []) {
    const n = normName(r.account ?? "");
    if (n) seen.add(n);
  }
  const { data: auto, error: e2 } = await db
    .from("auto_found_educ_leads").select("org_name_norm").limit(100000);
  if (e2) throw new Error(`load auto leads: ${e2.message}`);
  for (const r of auto ?? []) {
    if (r.org_name_norm) seen.add(r.org_name_norm);
  }
  return seen;
}

async function run(opts: RunOpts): Promise<Summary> {
  const started = Date.now();
  const s: Summary = {
    fn: "discover-educ-orgs",
    ran_at: new Date().toISOString(),
    trigger: opts.trigger,
    dry: opts.dry,
    target_new: 0,
    places_found: 0,
    candidates_kept: 0,
    inserted: 0,
    skipped_existing: 0,
    cells_processed: [],
    apify_runs: [],
    sample: [],
    sheet_appended: 0,
    sheet_error: null,
    ok: false,
    error: null,
    duration_ms: 0,
  };

  try {
    if (!hasApifyToken()) throw new Error("Missing APIFY_API_TOKEN");
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    }
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const settings = await loadSettings(db);
    const target = opts.target ?? settings.target_new;
    s.target_new = target;

    const seen = await loadDedupSet(db);

    // Rotating cursor: oldest-first, limited by the safety cap.
    let q = db
      .from("educ_discovery_config")
      .select("id, country, region, search_term, max_results")
      .eq("enabled", true)
      .order("last_run_at", { ascending: true, nullsFirst: true })
      .limit(settings.max_cells_run);
    if (opts.region) q = q.ilike("region", `%${opts.region}%`);
    const { data: cells, error: cellErr } = await q;
    if (cellErr) throw new Error(`load cells: ${cellErr.message}`);
    if (!cells || cells.length === 0) throw new Error("No enabled config cells to scan");

    for (const cell of cells) {
      if (s.inserted >= target) break;
      if (Date.now() - started > MAX_RUN_MS) break; // time-box; save what we have

      const locationQuery = `${cell.region}, ${COUNTRY_NAME[cell.country] ?? cell.country}`;
      // This actor needs the location inside the search string (a separate
      // locationQuery / city+country returns nothing or fails).
      const searchString = `${cell.search_term} in ${locationQuery}`;
      let items: unknown[] = [];
      try {
        items = await apifyScrape(ACTOR, {
          searchStringsArray: [searchString],
          maxCrawledPlacesPerSearch: cell.max_results ?? 40,
          language: "en",
        });
        s.apify_runs.push({ actor: ACTOR, cell: `${cell.search_term} @ ${locationQuery}`, items: items.length });
      } catch (err) {
        s.apify_runs.push({
          actor: ACTOR,
          cell: `${cell.search_term} @ ${locationQuery}`,
          items: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      s.places_found += items.length;

      // Map -> filter -> dedup within budget.
      const survivors: Candidate[] = [];
      let keptThisCell = 0;
      for (const place of items) {
        const c = toCandidate(place, cell.country, cell.region, cell.search_term);
        if (!c) continue;
        if (!passesFilter(c, settings)) continue;
        keptThisCell += 1;
        if (seen.has(c.org_name_norm)) {
          s.skipped_existing += 1;
          continue;
        }
        seen.add(c.org_name_norm); // guard against dupes later in the same run
        survivors.push(c);
        if (s.inserted + survivors.length >= target) break;
      }
      s.candidates_kept += keptThisCell;

      s.cells_processed.push({
        country: cell.country,
        region: cell.region,
        search_term: cell.search_term,
        found: items.length,
        kept: survivors.length,
      });

      if (!opts.dry) {
        if (survivors.length > 0) {
          const rows = survivors.map((c) => ({ ...c }));
          const { error: upErr } = await db
            .from("auto_found_educ_leads")
            .upsert(rows, { onConflict: "org_name_norm,country" });
          if (upErr) throw new Error(`upsert: ${upErr.message}`);
        }
        // Stamp the cursor whether or not this cell yielded survivors.
        await db
          .from("educ_discovery_config")
          .update({ last_run_at: new Date().toISOString() })
          .eq("id", cell.id);
      }

      s.inserted += survivors.length;
      for (const c of survivors) {
        if (s.sample.length < 15) {
          s.sample.push({
            org_name: c.org_name,
            country: c.country,
            school_or_association: c.school_or_association,
          });
        }
      }
    }

    // Mirror unlogged orgs into the Google Sheet. Driven by logged_to_sheet_at so
    // this run's new rows AND any prior rows whose append failed get picked up;
    // non-fatal (the DB is the source of truth). Sheet columns, in order:
    // org_name | school_or_association | country | region | website | category
    // (col G "Liv's Remark" is a human column and is left untouched).
    if (!opts.dry) {
      try {
        const { data: pending, error: pendErr } = await db
          .from("auto_found_educ_leads")
          .select("id, org_name, school_or_association, country, region, website, category")
          .is("logged_to_sheet_at", null)
          .order("id", { ascending: true })
          .limit(500);
        if (pendErr) throw new Error(`load unlogged: ${pendErr.message}`);
        if (pending && pending.length > 0) {
          if (!hasSheetsSA()) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
          // deno-lint-ignore no-explicit-any
          const rows = pending.map((r: any) => [
            r.org_name,
            r.school_or_association,
            r.country ?? "",
            r.region ?? "",
            r.website ?? "",
            r.category ?? "",
          ]);
          s.sheet_appended = await appendRows(SHEET_ID, `${SHEET_TAB}!A:F`, rows);
          // deno-lint-ignore no-explicit-any
          const ids = pending.map((r: any) => r.id);
          const { error: markErr } = await db
            .from("auto_found_educ_leads")
            .update({ logged_to_sheet_at: new Date().toISOString() })
            .in("id", ids);
          if (markErr) throw new Error(`mark logged: ${markErr.message}`);
        }
      } catch (sheetErr) {
        s.sheet_error = sheetErr instanceof Error ? sheetErr.message : String(sheetErr);
        console.error("[discover-educ-orgs] sheet sync failed:", s.sheet_error);
      }
    }

    s.ok = true;
    s.duration_ms = Date.now() - started;

    if (!opts.dry) {
      await db.from("educ_discovery_runs").insert({
        trigger: opts.trigger,
        target_new: target,
        cells_processed: s.cells_processed,
        places_found: s.places_found,
        candidates_kept: s.candidates_kept,
        inserted: s.inserted,
        updated: 0,
        skipped_existing: s.skipped_existing,
        apify_runs: s.apify_runs,
        sheet_appended: s.sheet_appended,
        sheet_error: s.sheet_error,
        ok: true,
        error: null,
        duration_ms: s.duration_ms,
      });
    }

    console.log("[discover-educ-orgs] done:", JSON.stringify({ ...s, sample: undefined }));
    return s;
  } catch (err) {
    s.ok = false;
    s.error = err instanceof Error ? err.message : String(err);
    s.duration_ms = Date.now() - started;
    console.error("[discover-educ-orgs] FAILED:", s.error);
    if (!opts.dry) {
      try {
        const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
          auth: { persistSession: false },
        });
        await db.from("educ_discovery_runs").insert({
          trigger: opts.trigger,
          target_new: s.target_new,
          cells_processed: s.cells_processed,
          places_found: s.places_found,
          candidates_kept: s.candidates_kept,
          inserted: s.inserted,
          updated: 0,
          skipped_existing: s.skipped_existing,
          apify_runs: s.apify_runs,
          sheet_appended: s.sheet_appended,
          sheet_error: s.sheet_error,
          ok: false,
          error: s.error,
          duration_ms: s.duration_ms,
        });
      } catch (_logErr) { /* swallow */ }
    }
    return s;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  const url = new URL(req.url);

  // Token guard (house convention). Allow when no secret is configured yet.
  if (PUSH_SHARED_SECRET && url.searchParams.get("token") !== PUSH_SHARED_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  // Diagnostic: one raw Apify call, variant chosen by ?probe=1..3.
  if (url.searchParams.get("probe")) {
    const term = url.searchParams.get("term") ?? "independent school";
    const region = url.searchParams.get("region") ?? "Sydney NSW";
    const country = url.searchParams.get("country") ?? "Australia";
    const variant = url.searchParams.get("probe");
    let input: unknown;
    if (variant === "2") {
      input = { searchStringsArray: [`${term} in ${region}, ${country}`], maxCrawledPlacesPerSearch: 5, language: "en" };
    } else if (variant === "3") {
      input = { searchStringsArray: [term], city: region, country, maxCrawledPlacesPerSearch: 5, language: "en" };
    } else {
      input = { searchStringsArray: [term], locationQuery: `${region}, ${country}`, maxCrawledPlacesPerSearch: 5, language: "en" };
    }
    try {
      const res = await apifyProbe(ACTOR, input);
      return json({ actor: ACTOR, variant, input, ...res });
    } catch (err) {
      return json({ actor: ACTOR, variant, input, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  const dry = url.searchParams.get("dry") === "1";
  const sync = url.searchParams.get("sync") === "1";
  const targetParam = url.searchParams.get("target");
  const target = targetParam ? parseInt(targetParam, 10) : null;
  const region = url.searchParams.get("region");

  if (dry || sync) {
    const res = await run({ dry, target, region, trigger: dry ? "dry" : "manual" });
    return json(res, res.ok ? 200 : 500);
  }

  // Default (cron): background + 202.
  const opts: RunOpts = { dry: false, target, region, trigger: "cron" };
  if (EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(run(opts));
    return json(
      { message: "discover-educ-orgs started in background", timestamp: new Date().toISOString() },
      202,
    );
  }
  const res = await run(opts);
  return json(res, res.ok ? 200 : 500);
});
