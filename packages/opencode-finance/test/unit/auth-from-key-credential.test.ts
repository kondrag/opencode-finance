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

  test("result validates against Auth.Info", () => {
    const info = Auth.fromKeyCredential({ key: "qk_test", metadata: { tier: "enterprise" } })
    expect(info && Auth.Info.safeParse(info).success).toBe(true)
  })
})
