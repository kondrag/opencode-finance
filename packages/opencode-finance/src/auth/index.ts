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
   * while credentials saved since V1 use `provider_tier`/`provider_tag`.
   * This helper accepts both spellings and derives `provider_tag` from the
   * presence of a tier field. Unrecognized tier/tag values are dropped so the
   * key still works (the tools degrade to the public tier with a warning).
   */
  export function fromKeyCredential(credential: {
    key: string
    metadata?: Record<string, unknown> | undefined
  }): Info | undefined {
    if (typeof credential.key !== "string" || credential.key.length === 0) return undefined
    const metadata = credential.metadata ?? {}
    const rawTier = metadata.provider_tier ?? metadata.tier
    const hasTierField = typeof rawTier === "string" && rawTier.length > 0
    const rawTag = metadata.provider_tag ?? (hasTierField ? "quiver-quant" : undefined)
    const tier = Api.shape.provider_tier.safeParse(rawTier)
    const tag = Api.shape.provider_tag.safeParse(rawTag)
    const parsed = Api.safeParse({
      type: "api",
      key: credential.key,
      ...(tier.success ? { provider_tier: tier.data } : {}),
      ...(tag.success ? { provider_tag: tag.data } : {}),
    })
    return parsed.success ? parsed.data : undefined
  }

  const filepath = path.join(Global.Path.data, "auth.json")

  type Source = (providerID: string) => Promise<Info | undefined>

  let source: Source | undefined

  export async function get(providerID: string) {
    if (source) {
      const resolved = await source(providerID).catch(() => undefined)
      if (resolved) return resolved
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
