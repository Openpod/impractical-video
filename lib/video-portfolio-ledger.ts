import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Batch-level character-name ledger. Ensures every extracted character gets a
 * unique assigned name across an entire batch, so two visually distinct people
 * never collide on the same name. Persisted as JSON so sequential per-video
 * pipeline runs share one ledger.
 */

export type CharacterLedgerEntry = {
  name: string;
  rawName: string;
  sourceEntryId: string;
  entityId: string;
  description: string;
};

export type CharacterLedger = {
  // Lower-cased assigned name -> entry. Map preserves insertion order.
  byName: Record<string, CharacterLedgerEntry>;
};

// Fallback surnames used to disambiguate when a proposed name is already taken
// by a different character. Exhausting these falls back to numeric suffixes.
const DISAMBIGUATION_SURNAMES = [
  "Vale", "Cross", "Hale", "Mercer", "Frost", "Quinn", "Sato", "Okonkwo",
  "Reyes", "Volkov", "Nakamura", "Bianchi", "Adeyemi", "Sterling", "Marsh",
];

export async function loadCharacterLedger(ledgerPath: string): Promise<CharacterLedger> {
  try {
    const raw = await readFile(ledgerPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CharacterLedger>;
    return { byName: parsed.byName ?? {} };
  } catch {
    return { byName: {} };
  }
}

export async function saveCharacterLedger(ledgerPath: string, ledger: CharacterLedger) {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
}

function cleanName(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Assign a unique name for a character, mutating the ledger. If the proposed
 * name is free, it is used as-is. If a DIFFERENT character already holds it,
 * disambiguate with a surname, then a numeric suffix.
 */
export function assignCharacterName(
  ledger: CharacterLedger,
  input: { proposed: string; rawName: string; sourceEntryId: string; entityId: string; description: string },
): string {
  const base = cleanName(input.proposed) || "Unnamed";

  const record = (name: string) => {
    ledger.byName[name.toLowerCase()] = {
      name,
      rawName: input.rawName,
      sourceEntryId: input.sourceEntryId,
      entityId: input.entityId,
      description: input.description,
    };
    return name;
  };

  const existing = ledger.byName[base.toLowerCase()];
  // Free, or already owned by this exact entity (idempotent re-run).
  if (!existing || existing.entityId === input.entityId) return record(base);

  for (const surname of DISAMBIGUATION_SURNAMES) {
    const candidate = `${base} ${surname}`;
    if (!ledger.byName[candidate.toLowerCase()]) return record(candidate);
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!ledger.byName[candidate.toLowerCase()]) return record(candidate);
  }
}
