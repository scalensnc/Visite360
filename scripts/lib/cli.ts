export type CliArguments = Record<string, string | boolean>;

export function parseArguments(values = process.argv.slice(2)): CliArguments {
  const parsed: CliArguments = {};

  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`Argument inattendu : ${token}`);
    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    if (!rawName) throw new Error("Un nom d’argument est requis après --.");

    if (inlineValue !== undefined) {
      parsed[rawName] = inlineValue;
      continue;
    }

    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[rawName] = next;
      index += 1;
    } else {
      parsed[rawName] = true;
    }
  }

  return parsed;
}

export function stringArgument(
  parsed: CliArguments,
  name: string,
  options: { required?: boolean; fallback?: string } = {},
) {
  const value = parsed[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (options.fallback !== undefined) return options.fallback;
  if (options.required) throw new Error(`L’argument --${name} est obligatoire.`);
  return undefined;
}

export function numberArgument(
  parsed: CliArguments,
  name: string,
  fallback: number,
) {
  const raw = stringArgument(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} doit être un nombre.`);
  return value;
}
