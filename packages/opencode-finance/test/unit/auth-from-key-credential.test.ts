import { describe, expect, test } from "bun:test"
import { Auth } from "../../src/auth"

describe("Auth.fromKeyCredential", () => {
  test("maps V2 form metadata.tier to provider_tier and derives provider_tag", () => {
    const info = Auth.fromKeyCredential({
      key: "qk_test",
      metadata: { tier: "tier_3" },
    })
    expect(info).toEqual({
      type: "api",
      key: "qk_test",
      provider_tier: "tier_3",
      provider_tag: "quiver-quant",
    })
  })

  test("passes through V1/auth.json spelling provider_tier + provider_tag", () => {
    const info = Auth.fromKeyCredential({
      key: "qk_test",
      metadata: { provider_tier: "tier_2", provider_tag: "quiver-quant" },
    })
    expect(info).toEqual({
      type: "api",
      key: "qk_test",
      provider_tier: "tier_2",
      provider_tag: "quiver-quant",
    })
  })

  test("prefers explicit provider_tier over form tier", () => {
    const info = Auth.fromKeyCredential({
      key: "qk_test",
      metadata: { provider_tier: "tier_1", tier: "tier_3" },
    })
    expect(info).toEqual({
      type: "api",
      key: "qk_test",
      provider_tier: "tier_1",
      provider_tag: "quiver-quant",
    })
  })

  test("returns key-only credential when metadata is absent", () => {
    const info = Auth.fromKeyCredential({ key: "k_test" })
    expect(info).toEqual({ type: "api", key: "k_test" })
  })

  test("drops unrecognized tier values but keeps the key and derived tag", () => {
    const info = Auth.fromKeyCredential({
      key: "qk_test",
      metadata: { tier: "free" },
    })
    expect(info).toEqual({
      type: "api",
      key: "qk_test",
      provider_tag: "quiver-quant",
    })
  })

  test("drops unrecognized provider_tag values", () => {
    const info = Auth.fromKeyCredential({
      key: "k_test",
      metadata: { provider_tag: "finnhub" },
    })
    expect(info).toEqual({ type: "api", key: "k_test" })
  })

  test("returns undefined for an empty key", () => {
    expect(Auth.fromKeyCredential({ key: "" })).toBeUndefined()
  })

  test("accepts flat V1 credential fields when metadata is absent", () => {
    const info = Auth.fromKeyCredential({
      key: "qk_test",
      provider_tier: "tier_2",
      provider_tag: "quiver-quant",
    })
    expect(info).toEqual({
      type: "api",
      key: "qk_test",
      provider_tier: "tier_2",
      provider_tag: "quiver-quant",
    })
  })

  test("falls back to flat provider_tier when metadata has no tier", () => {
    const info = Auth.fromKeyCredential({ key: "qk_test", provider_tier: "tier_1" })
    expect(info).toEqual({
      type: "api",
      key: "qk_test",
      provider_tier: "tier_1",
      provider_tag: "quiver-quant",
    })
  })

  test("skips invalid metadata spellings and uses the first valid one", () => {
    const info = Auth.fromKeyCredential({
      key: "qk_test",
      metadata: { provider_tier: "bogus", tier: "tier_2" },
    })
    expect(info).toEqual({
      type: "api",
      key: "qk_test",
      provider_tier: "tier_2",
      provider_tag: "quiver-quant",
    })
  })

  test("result validates against Auth.Info", () => {
    const info = Auth.fromKeyCredential({ key: "qk_test", metadata: { tier: "enterprise" } })
    expect(info && Auth.Info.safeParse(info).success).toBe(true)
  })
})

describe("Auth.mergeLegacyCredential", () => {
  test("re-attaches tier from the legacy entry when the V2 credential has none", () => {
    const resolved = Auth.fromKeyCredential({ key: "v2_key" })!
    const legacy = Auth.fromKeyCredential({
      key: "v1_key",
      provider_tier: "tier_3",
      provider_tag: "quiver-quant",
    })!
    expect(Auth.mergeLegacyCredential(resolved, legacy)).toEqual({
      type: "api",
      key: "v2_key",
      provider_tier: "tier_3",
      provider_tag: "quiver-quant",
    })
  })

  test("keeps the V2 credential's own tier when present", () => {
    const resolved = Auth.fromKeyCredential({ key: "v2_key", metadata: { tier: "tier_1" } })!
    const legacy = Auth.fromKeyCredential({ key: "v1_key", provider_tier: "tier_3" })!
    expect(Auth.mergeLegacyCredential(resolved, legacy)).toBe(resolved)
  })

  test("returns resolved unchanged when the legacy entry has no tier", () => {
    const resolved = Auth.fromKeyCredential({ key: "v2_key" })!
    const legacy = Auth.fromKeyCredential({ key: "v1_key" })
    expect(Auth.mergeLegacyCredential(resolved, legacy)).toBe(resolved)
  })

  test("returns resolved unchanged when it is not an api credential", () => {
    const resolved = {
      type: "oauth" as const,
      refresh: "r",
      access: "a",
      expires: 0,
    }
    const legacy = Auth.fromKeyCredential({ key: "v1_key", provider_tier: "tier_3" })!
    expect(Auth.mergeLegacyCredential(resolved, legacy)).toBe(resolved)
  })
})
