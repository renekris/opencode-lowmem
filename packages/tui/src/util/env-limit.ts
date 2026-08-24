export type EnvLimitUnit = "bytes" | "count"

export class InvalidEnvLimitError extends Error {
  override readonly name = "InvalidEnvLimitError"

  constructor(readonly value: string, readonly unit: EnvLimitUnit) {
    super(`invalid ${unit} environment limit: ${value}`)
  }
}

export function parseEnvLimit(value: string | undefined, fallback: string, unit: EnvLimitUnit = "bytes") {
  const input = value ?? fallback
  if (input === "0") return 0
  const match = unit === "bytes" ? /^([1-9]\d*)(KB|MB)$/.exec(input) : /^([1-9]\d*)$/.exec(input)
  if (!match) throw new InvalidEnvLimitError(input, unit)
  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount)) throw new InvalidEnvLimitError(input, unit)
  if (unit === "count") return amount
  const multiplier = match[2] === "MB" ? 1024 * 1024 : 1024
  const bytes = amount * multiplier
  if (!Number.isSafeInteger(bytes)) throw new InvalidEnvLimitError(input, unit)
  return bytes
}

export function readEnvLimit(name: string, fallback: string, unit: EnvLimitUnit = "bytes") {
  return parseEnvLimit(process.env[name], fallback, unit)
}
