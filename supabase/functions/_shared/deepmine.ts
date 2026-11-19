// _shared/deepmine.ts
// Point-of-contact (POC) lookup for a school / association, by ORG NAME.
//
// Uses the Apify actor deepmine~linkedin-company-employees (the same actor the
// Alternate Lead Finder uses): it searches PUBLIC LinkedIn by company NAME (not a
// domain, no cookies) and returns people with a job title + headline — NO emails.
// We pull a broad list per org and pick ONE person whose job TITLE matches a
// school-tailored target role, in priority order. Coverage is partial (~0-3
// relevant people per org, none for some); when nobody matches we record no POC.

const APIFY_TOKEN =
  Deno.env.get("APIFY_API_TOKEN") ?? Deno.env.get("APIFY_TOKEN") ?? "";
export const DEEPMINE_ACTOR =
  Deno.env.get("DEEPMINE_ACTOR") ?? "deepmine~linkedin-company-employees";
const DEEPMINE_MAX_RESULTS = parseInt(
  Deno.env.get("DEEPMINE_MAX_RESULTS") ?? "100",
  10,
); // people pulled per org
const DEEPMINE_TIMEOUT_S = parseInt(
  Deno.env.get("DEEPMINE_TIMEOUT_S") ?? "90",
  10,
); // per-search Apify timeout

export function hasDeepmineToken(): boolean {
  return APIFY_TOKEN.length > 0;
}

export interface Person {
  first_name: string | null;
  last_name: string | null;
  position: string | null; // job title
  headline: string | null;
}

export interface Poc {
  poc_firstname: string;
  poc_lastname: string;
  poc_role: string; // the person's actual job title (or headline fallback)
}

// Target POC roles for K-12 schools and education associations, in PRIORITY order
// (first group = most relevant to MAG's adventure / experiential travel offer).
// Matched as word-boundary regexes against the person's job TITLE only — headlines
// are free text ("Retired", taglines) and produced false matches in testing. The
// FIRST group with any match wins, so the stored POC is the most relevant person.
const TARGET_ROLE_GROUPS: RegExp[][] = [
  // 1. Outdoor / experiential / adventure education & expeditions — the ideal contact.
  [/\boutdoor\b/, /\bexperiential\b/, /\bexpeditions?\b/, /\badventure\b/, /\bduke of ed\b/],
  // 2. Co-curricular / camps / excursions / trips / tours.
  [/\bco-?curricular\b/, /\bcamps?\b/, /\bexcursions?\b/, /\btrips?\b/, /\btours?\b/],
  // 3. Business / operations / bursar / finance leadership (budget holders).
  [/\bbusiness manager\b/, /\bbursar\b/, /\boperations?\b/, /\bchief operating\b/, /\bcoo\b/, /\bfinance\b/],
  // 4. Principal / deputy / head of school.
  [/\bprincipal\b/, /\bhead of school\b/, /\bheadmaster\b/, /\bheadmistress\b/, /\bhead master\b/, /\bhead mistress\b/],
  // 5. Development / advancement / community / alumni.
  [/\bdevelopment\b/, /\badvancement\b/, /\bcommunity engagement\b/, /\balumni\b/],
  // 6. Events / conference.
  [/\bevents?\b/, /\bconferences?\b/],
  // 7. Marketing / communications / enrolment / admissions.
  [/\bmarketing\b/, /\bcommunications?\b/, /\benrol?ments?\b/, /\badmissions?\b/],
  // 8. Association-specific: membership / professional learning (peak bodies).
  [/\bmembership\b/, /\bprofessional (learning|development)\b/, /\bmember services\b/],
];

// The actor's jobTitle is sometimes a free-text tagline rather than a real role
// ("Green is always the alternate and for sustainable development."), which can match
// a role keyword by accident. Reject anything that reads like a sentence.
function looksLikeJobTitle(t: string): boolean {
  const s = t.trim();
  if (!s) return false;
  if (s.length > 70) return false;             // real titles are short
  if (s.split(/\s+/).length > 8) return false; // ...and not a sentence
  if (/[.!?]$/.test(s)) return false;          // ends like a sentence
  return true;
}

// Lowest group index whose any pattern matches the title, or -1 if none (also -1 when
// the "title" reads like a tagline rather than a real job title).
function roleRank(title: string | null): number {
  const t = (title ?? "").toLowerCase();
  if (!t || !looksLikeJobTitle(t)) return -1;
  for (let i = 0; i < TARGET_ROLE_GROUPS.length; i++) {
    if (TARGET_ROLE_GROUPS[i].some((re) => re.test(t))) return i;
  }
  return -1;
}

export function isTargetRole(p: Person): boolean {
  return roleRank(p.position) >= 0;
}

// Pick the single best POC: the person whose job TITLE matches the highest-priority
// role group. Returns null when nobody matches any target role.
export function pickBestPoc(people: Person[]): Poc | null {
  let best: Person | null = null;
  let bestRank = Infinity;
  for (const p of people) {
    if (!p.first_name || !p.last_name) continue;
    const rank = roleRank(p.position);
    if (rank < 0) continue;
    if (rank < bestRank) {
      bestRank = rank;
      best = p;
    }
  }
  if (!best) return null;
  return {
    poc_firstname: best.first_name!,
    poc_lastname: best.last_name!,
    poc_role: (best.position ?? best.headline ?? "").trim(),
  };
}

function itemsToPeople(items: Record<string, unknown>[]): Person[] {
  const clean = (s: unknown): string | null => {
    const t = typeof s === "string" ? s.trim() : "";
    return t || null;
  };
  const people: Person[] = [];
  for (const it of items) {
    const first = clean(it.firstName);
    const last = clean(it.lastName);
    if (!first || !last) continue; // need a real person name
    people.push({
      first_name: first,
      last_name: last,
      position: clean(it.jobTitle),
      headline: clean(it.headline),
    });
  }
  return people;
}

// Search one org by NAME. Returns the people list, or null on ANY provider failure
// (so the caller can leave the org unstamped and retry it next run rather than
// burning it with a "searched, none found" marker).
export async function deepmineSearch(orgName: string): Promise<Person[] | null> {
  if (!APIFY_TOKEN) {
    console.warn("[deepmine] APIFY_API_TOKEN not set - cannot search.");
    return null;
  }
  const url =
    `https://api.apify.com/v2/acts/${DEEPMINE_ACTOR}/run-sync-get-dataset-items` +
    `?token=${APIFY_TOKEN}&timeout=${DEEPMINE_TIMEOUT_S}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (DEEPMINE_TIMEOUT_S + 10) * 1000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companies: [orgName],
        maxResults: DEEPMINE_MAX_RESULTS,
        enrichProfiles: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(
        `[deepmine] ${res.status} for "${orgName}" - skipping. ${(await res.text()).slice(0, 160)}`,
      );
      return null;
    }
    const items = await res.json();
    if (!Array.isArray(items)) return [];
    return itemsToPeople(items as Record<string, unknown>[]);
  } catch (err) {
    console.warn(`[deepmine] fetch failed for "${orgName}": ${err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
