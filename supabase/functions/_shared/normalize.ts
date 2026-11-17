// _shared/normalize.ts
// Turn a raw Apify Google-Maps place into a normalized candidate, classify it as
// school vs association, and decide whether it passes the include/exclude filter.

export type Candidate = {
  org_name: string;
  org_name_norm: string;
  school_or_association: "school" | "association";
  country: string | null;
  region: string | null;
  website: string | null;
  domain: string | null;
  address: string | null;
  phone: string | null;
  category: string | null;
  rating: number | null;
  reviews_count: number | null;
  place_id: string | null;
  source_query: string | null;
  // deno-lint-ignore no-explicit-any
  raw: any;
};

export type Settings = {
  reviews_floor: number;
  include_keywords: string[];
  exclude_keywords: string[];
  include_categories: string[];
  exclude_categories: string[];
};

// Lowercase, strip accents/punctuation, drop a leading "the", collapse spaces.
export function normName(name: string): string {
  return (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|pty|ltd|inc|llc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function domainFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

const ASSOCIATION_HINTS = [
  "association", "council", "institute", "society", "federation",
  "alliance", "network", "conference", "union", "coalition",
];

function classify(name: string, category: string): "school" | "association" {
  const hay = `${name} ${category}`.toLowerCase();
  return ASSOCIATION_HINTS.some((h) => hay.includes(h)) ? "association" : "school";
}

// deno-lint-ignore no-explicit-any
function num(v: any): number | null {
  const n = typeof v === "string" ? Number(v.replace(/[, ]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : null;
}

// deno-lint-ignore no-explicit-any
export function toCandidate(
  // deno-lint-ignore no-explicit-any
  place: any,
  country: string,
  region: string,
  searchTerm: string,
): Candidate | null {
  const name: string = place?.title ?? place?.name ?? "";
  if (!name.trim()) return null;
  const category: string = place?.categoryName ??
    (Array.isArray(place?.categories) ? place.categories.join(", ") : "") ?? "";
  // This actor's `url` is the Google Maps listing, not the org's own site; keep
  // website only when a real website field is present (the Maps url stays in raw).
  const website: string | null = place?.website ?? null;
  return {
    org_name: name.trim(),
    org_name_norm: normName(name),
    school_or_association: classify(name, category),
    country,
    region,
    website,
    domain: domainFromUrl(website),
    address: place?.address ?? place?.street ?? null,
    phone: place?.phone ?? place?.phoneUnformatted ?? null,
    category: category || null,
    rating: num(place?.totalScore ?? place?.rating),
    reviews_count: num(place?.reviewsCount ?? place?.reviews),
    place_id: place?.placeId ?? place?.place_id ?? null,
    source_query: `${searchTerm} @ ${region}, ${country}`,
    raw: place,
  };
}

// Keep only independent/private-signal orgs with enough prominence; drop the
// childcare/tutoring/etc. noise. Associations bypass the reviews floor.
export function passesFilter(c: Candidate, s: Settings): boolean {
  if (!c.org_name_norm) return false;
  const name = c.org_name.toLowerCase();
  const cat = (c.category ?? "").toLowerCase();
  const hay = `${name} ${cat}`;

  // Hard excludes (name/keyword then category) remove tertiary/VET/ELICOS noise.
  if (s.exclude_keywords.some((k) => hay.includes(k.toLowerCase()))) return false;
  if ((s.exclude_categories ?? []).some((k) => cat.includes(k.toLowerCase()))) return false;

  // Associations (peak bodies) bypass the K-12 category + prominence checks.
  if (c.school_or_association === "association") {
    return s.include_keywords.some((k) => name.includes(k.toLowerCase()));
  }

  // Require a positive K-12 signal: a school-type Google category, or a strong
  // name token. (Excludes already ran, so a bare "school" category is genuine.)
  const catOk = (s.include_categories ?? []).some((k) => cat.includes(k.toLowerCase()));
  const nameOk = s.include_keywords.some((k) => name.includes(k.toLowerCase()));
  if (!catOk && !nameOk) return false;

  const reviews = c.reviews_count ?? 0;
  return reviews >= s.reviews_floor;
}
