import path from "path"
import z from "zod"
import { Global } from "../global"
import { readJsonIfExists, writeText } from "../runtime/fs"

export namespace Auth {
  export const Oauth = z.object({
    type: z.literal("oauth"),
    refresh: z.string(),
    access: z.string(),
    expires: z.number(),
    accountId: z.string().optional(),
    enterpriseUrl: z.string().optional(),
  })

  export const Api = z.object({
    type: z.literal("api"),
    key: z.string(),
    provider_tier: z.enum(["tier_1", "tier_2", "tier_3", "enterprise"]).optional(),
    provider_tag: z.literal("quiver-quant").optional(),
  })

  export const WellKnown = z.object({
    type: z.literal("wellknown"),
    key: z.string(),
    token: z.string(),
  })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown])
  export type Info = z.infer<typeof Info>

  /**
   * Map a V2 key-method credential to an `Auth.Api` credential.
   *
   * V2 key-method integrations persist form answers verbatim as credential
   * metadata, so the Quiver tier select is stored under `metadata.tier`,
   * while V1-era credentials may carry `provider_tier`/`provider_tag`
   * either nested under `metadata` (the V1 `authorize()` output shape) or
   * flat on the credential itself (the legacy `auth.json` shape).
   *
   * The first *valid* spelling wins; unrecognized tier/tag values are
   * dropped so the key still works (the tools degrade to the public tier
   * with a warning). A `provider_tag` is derived from the presence of any
   * tier field, matching the V1 auth shape.
   */
  export function fromKeyCredential(credential: {
    key: string
    provider_tier?: unknown
    provider_tag?: unknown
    metadata?: Record<string, unknown> | undefined
  }): Info | undefined {
    if (typeof credential.key !== "string" || credential.key.length === 0) return undefined
    const metadata = credential.metadata ?? {}
    const tierCandidates = [metadata.provider_tier, metadata.tier, credential.provider_tier]
    const tagCandidates = [metadata.provider_tag, credential.provider_tag]
    const parseTier = (value: unknown) => {
      const parsed = Api.shape.provider_tier.safeParse(value)
      return parsed.success ? parsed.data : undefined
    }
    const parseTag = (value: unknown) => {
      const parsed = Api.shape.provider_tag.safeParse(value)
      return parsed.success ? parsed.data : undefined
    }
    let tier: z.infer<typeof Api.shape.provider_tier> | undefined
    for (const candidate of tierCandidates) {
      tier = parseTier(candidate)
      if (tier) break
    }
    const hasTierField = tierCandidates.some((value) => typeof value === "string" && value.length > 0)
    let tag: z.infer<typeof Api.shape.provider_tag> | undefined
    for (const candidate of tagCandidates) {
      tag = parseTag(candidate)
      if (tag) break
    }
    tag ??= hasTierField ? "quiver-quant" : undefined
    const parsed = Api.safeParse({
      type: "api",
      key: credential.key,
      ...(tier ? { provider_tier: tier } : {}),
      ...(tag ? { provider_tag: tag } : {}),
    })
    return parsed.success ? parsed.data : undefined
  }

  /**
   * Re-attach tier metadata from the legacy `auth.json` entry when a V2
   * credential resolved without one. Legacy credential migration keeps only
   * `type` and `key`, so a V1 paid-tier Quiver entry would otherwise
   * silently degrade to the public tier even though `auth.json` still
   * holds the tier. The V2 credential always wins when it carries a tier.
   */
  export function mergeLegacyCredential<T extends Info>(resolved: T, legacy: Info | undefined): T {
    if (resolved.type !== "api" || resolved.provider_tier) return resolved
    if (legacy?.type !== "api" || !legacy.provider_tier) return resolved
    return { ...resolved, provider_tier: legacy.provider_tier, provider_tag: legacy.provider_tag }
  }

  const filepath = path.join(Global.Path.data, "auth.json")

  type Source = (providerID: string) => Promise<Info | undefined>

  let source: Source | undefined

  export async function get(providerID: string) {
    if (source) {
      const resolved = await source(providerID).catch(() => undefined)
      if (resolved) {
        if (resolved.type !== "api" || resolved.provider_tier) return resolved
        // V2 credential lacks tier metadata; consult the legacy file before
        // giving up on it (see mergeLegacyCredential).
        const legacy = (await all())[providerID]
        return mergeLegacyCredential(resolved, legacy)
      }
    }
    const auth = await all()
    return auth[providerID]
  }

  /**
   * Replace the credential source. OpenCode V2 plugins inject an integration
   * connection resolver here during setup; the default reads the legacy
   * `auth.json` file so keys saved before the V2 upgrade keep working.
   */
  export function use(next: Source | undefined) {
    source = next
  }

  export async function all(): Promise<Record<string, Info>> {
    const data = await readJsonIfExists<Record<string, unknown>>(filepath).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT" || error?.code === "ERR_MODULE_NOT_FOUND") return {} as Record<string, unknown>
      throw error
    })

    return Object.entries(data ?? {}).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  export async function set(providerID: string, info: Info) {
    const data = await all()
    await writeText(filepath, JSON.stringify({ ...data, [providerID]: info }, null, 2), { mode: 0o600 })
  }

  export async function remove(providerID: string) {
    const data = await all()
    delete data[providerID]
    await writeText(filepath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }
}
