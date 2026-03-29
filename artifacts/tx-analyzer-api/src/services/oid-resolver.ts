import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

const CACHE_FILE = path.resolve(process.env.OID_CACHE_FILE ?? "data/oid-cache.json");

if (!existsSync(path.dirname(CACHE_FILE))) {
  mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
}

type OidCache = Record<string, string>;

const KNOWN_OIDS: OidCache = {
  "2.16.840.1.113883.3.1703": "CVS Health",
  "2.16.840.1.113883.3.1703.1": "CVS Pharmacy",
  "2.16.840.1.113883.3.1703.2": "Aetna",
  "2.16.840.1.113883.3.1703.3": "MinuteClinic",
  "2.16.840.1.113883.3.2054": "CommonWell Health Alliance",
  "1.3.6.1.4.1.12559": "CommonWell Test Organization",
};

function loadCache(): OidCache {
  if (!existsSync(CACHE_FILE)) return { ...KNOWN_OIDS };
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as OidCache;
    return { ...KNOWN_OIDS, ...raw };
  } catch {
    return { ...KNOWN_OIDS };
  }
}

function saveCache(cache: OidCache): void {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

let memCache: OidCache = loadCache();

export function resolveOid(oid: string): string {
  return memCache[oid] ?? oid;
}

export function resolveOids(oids: string[]): Array<{ oid: string; name: string }> {
  return oids.map((oid) => ({ oid, name: resolveOid(oid) }));
}

export function addToCache(oid: string, name: string): void {
  memCache[oid] = name;
  saveCache(memCache);
}

export async function lookupOidFromPortal(oid: string): Promise<string | null> {
  const { loadSession } = await import("./auth.js");
  const session = loadSession();
  if (!session) return null;

  try {
    const PORTAL_URL = process.env.CW_PORTAL_URL ?? "https://integration.commonwellalliance.lkopera.com";
    const cookieHeader = session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const response = await fetch(
      `${PORTAL_URL}/Organizations/GetByOid?oid=${encodeURIComponent(oid)}`,
      {
        headers: {
          Cookie: cookieHeader,
          Accept: "application/json, */*",
          "X-Requested-With": "XMLHttpRequest",
        },
      }
    );

    if (response.ok) {
      const data = await response.json() as { name?: string; organizationName?: string; displayName?: string };
      const name = data.name ?? data.organizationName ?? data.displayName;
      if (name) {
        addToCache(oid, name);
        return name;
      }
    }
  } catch {
  }
  return null;
}

export async function resolveOidsWithLookup(
  oids: string[]
): Promise<Array<{ oid: string; name: string }>> {
  const results: Array<{ oid: string; name: string }> = [];

  for (const oid of oids) {
    const cached = memCache[oid];
    if (cached) {
      results.push({ oid, name: cached });
      continue;
    }
    const live = await lookupOidFromPortal(oid);
    results.push({ oid, name: live ?? oid });
  }

  return results;
}
