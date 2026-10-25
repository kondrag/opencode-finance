import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"

const packageDir = path.resolve(import.meta.dir, "../..")
const distEntrypoint = pathToFileURL(path.join(packageDir, "dist/index.js")).href
const openClawEntrypoint = pathToFileURL(path.join(packageDir, "dist/openclaw/index.cjs")).href
const expectedToolNames = [
  "financial_search",
  "portfolio",
  "portfolio_report",
  "report_insiders",
  "report_government_trading",
  "report_darkpool_anomaly",
  "financial_political_backtest",
  "report_pdf",
]
const expectedCommandNames = [
  "quote",
  "metrics",
  "filings",
  "watch",
  "portfolio",
  "report-portfolio",
  "report-insiders",
  "financial-government-trading",
  "financial-political-backtest",
  "market",
  "financial-darkpool-anomaly",
  "report-pdf",
  "report",
  "onboard",
]
const expectedAuthIntegrations = [
  "alphavantage",
  "finnhub",
  "financial-modeling-prep",
  "polygon",
  "quartr",
  "sec-edgar",
  "quiver-quant",
]

async function loadEntrypoint() {
  return import(distEntrypoint)
}

async function loadOpenClawPlugin() {
  const entrypoint = await import(openClawEntrypoint)
  const plugin = (entrypoint.default as { default?: unknown })?.default ?? entrypoint.default
  return plugin as {
    register(api: {
      registerTool(factory: unknown, options?: { names?: string[] }): void
    }): Promise<void> | void
  }
}

function registration() {
  return { dispose: async () => {} }
}

function createStubContext() {
  const tools: Array<{ name: string }> = []
  const commands: Array<{ name: string; execute: (input: any) => Promise<void> }> = []
  const integrations: Array<{ integrationID: string; method: { type: string; form?: unknown[] } }> = []
  const sessionHooks: Record<string, (event: any) => unknown> = {}
  let prompt: ((input: { sessionID: string; text: string }) => Promise<unknown>) | undefined

  const context = {
    app: { version: "0.0.0-test" },
    location: { directory: packageDir, project: { id: "test", directory: packageDir, canonical: packageDir } },
    options: {},
    integration: {
      transform: async (callback: (editor: any) => unknown) => {
        await callback({
          list: () => [],
          get: () => undefined,
          update: () => {},
          method: {
            list: () => [],
            update: (input: { integrationID: string; method: { type: string; form?: unknown[] } }) => {
              integrations.push(input)
            },
            remove: () => {},
          },
        })
        return registration()
      },
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        sessionHooks[name] = callback
        return registration()
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        if (!prompt) throw new Error("unexpected session.prompt call")
        return prompt(input)
      },
    },
    tool: {
      transform: async (callback: (editor: any) => unknown) => {
        await callback({
          list: () => [],
          get: () => undefined,
          namespace: () => {},
          add: (tool: { name: string }) => {
            tools.push(tool)
          },
          update: () => {},
          remove: () => {},
        })
        return registration()
      },
    },
    command: {
      transform: async (callback: (editor: any) => unknown) => {
        await callback({
          add: (command: { name: string; execute: (input: any) => Promise<void> }) => {
            commands.push(command)
          },
        })
        return registration()
      },
    },
  }

  return {
    context,
    tools,
    commands,
    integrations,
    sessionHooks,
    onPrompt(callback: (input: { sessionID: string; text: string }) => Promise<unknown>) {
      prompt = callback
    },
  }
}

function decode(bytes: Uint8Array<ArrayBufferLike>) {
  return new TextDecoder().decode(bytes)
}

function parsePackFiles(raw: string) {
  const match = raw.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/)
  if (!match) {
    throw new Error(`Unable to locate npm pack JSON payload in output:\n${raw}`)
  }
  return JSON.parse(match[1]) as Array<{ files: Array<{ path: string }> }>
}

describe("plugin package entrypoint contract", () => {
  test("default-exports a V2 plugin definition", async () => {
    const entrypoint = await loadEntrypoint()
    const names = Object.keys(entrypoint).toSorted()

    expect(names).toEqual(["default"])

    const plugin = entrypoint.default as { id?: string; setup?: unknown }
    expect(plugin.id).toBe("opencode-finance")
    expect(typeof plugin.setup).toBe("function")
  })

  test("setup registers tools, commands, session hook, and auth integrations", async () => {
    const entrypoint = await loadEntrypoint()
    const plugin = entrypoint.default as { id: string; setup: (context: unknown) => Promise<unknown> }
    const { context, tools, commands, integrations, sessionHooks } = createStubContext()

    const cleanup = await plugin.setup(context)
    expect(typeof cleanup).toBe("function")

    expect(tools.map((tool) => tool.name).toSorted()).toEqual(expectedToolNames.toSorted())
    expect(commands.map((command) => command.name).toSorted()).toEqual(expectedCommandNames.toSorted())
    expect(integrations.map((entry) => entry.integrationID).toSorted()).toEqual(expectedAuthIntegrations.toSorted())

    for (const entry of integrations) {
      expect(entry.method.type).toBe("key")
      expect(Array.isArray(entry.method.form)).toBe(true)
    }

    expect(typeof sessionHooks.context).toBe("function")

    const event = { system: [] as Array<{ type: string; text?: string }> }
    await sessionHooks.context(event)
    expect(event.system.length).toBeGreaterThan(0)
    expect(event.system[0]?.type).toBe("text")
    expect(event.system[0]?.text?.length).toBeGreaterThan(0)
  })

  test("report command rejects missing ticker before submitting a prompt", async () => {
    const entrypoint = await loadEntrypoint()
    const plugin = entrypoint.default as { id: string; setup: (context: unknown) => Promise<unknown> }
    let submitted: string | undefined
    const { context, commands, onPrompt } = createStubContext()
    onPrompt(async (input) => {
      submitted = input.text
    })

    await plugin.setup(context)

    const report = commands.find((command) => command.name === "report")
    expect(report).toBeTruthy()

    await expect(
      report!.execute({ sessionID: "ses_test", prompt: { text: "" }, delivery: "steer" }),
    ).rejects.toThrow(/Missing ticker for `\/report`/)
    expect(submitted).toBeUndefined()
  })

  test("built OpenClaw entrypoint imports under Node without Bun globals", () => {
    const script = `import(${JSON.stringify(openClawEntrypoint)}).then(() => {}).catch((error) => { console.error(error); process.exit(1); })`
    const proc = Bun.spawnSync(["node", "--input-type=module", "--eval", script], {
      cwd: packageDir,
      stderr: "pipe",
      stdout: "pipe",
    })

    expect(proc.exitCode).toBe(0)
  })

  test("OpenClaw plugin registers only the v1 report tools", async () => {
    const plugin = await loadOpenClawPlugin()
    const registrations: Array<{ options?: { names?: string[] } }> = []

    await plugin.register({
      registerTool(factory, options) {
        expect(typeof factory).toBe("function")
        registrations.push({ options })
      },
    })

    expect(registrations).toHaveLength(2)
    expect(registrations.map((entry) => entry.options?.names?.[0]).toSorted()).toEqual(["financial_search", "report_pdf"])
  })

  test("npm pack only publishes built runtime assets", () => {
    const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-finance-npm-cache-"))
    const pack = Bun.spawnSync(["npm", "pack", "--dry-run", "--json", "."], {
      cwd: packageDir,
      env: {
        ...process.env,
        npm_config_cache: npmCache,
      },
      stderr: "pipe",
      stdout: "pipe",
    })

    expect(pack.exitCode).toBe(0)

    const raw = decode(pack.stdout).trim()
    expect(raw).toBeTruthy()

    const [{ files }] = parsePackFiles(raw)
    const paths = files.map((file) => file.path)

    expect(paths).toContain("package.json")
    expect(paths).toContain("README.md")
    expect(paths).toContain("openclaw.plugin.json")
    expect(paths).toContain("skills/report/SKILL.md")
    expect(paths.some((file) => file.startsWith("dist/"))).toBe(true)
    expect(paths).toContain("dist/openclaw/index.cjs")

    for (const prefix of ["src/", "test/", ".desloppify/", ".claude/"]) {
      expect(paths.some((file) => file.startsWith(prefix))).toBe(false)
    }

    expect(paths).not.toContain("scorecard.png")
  })
})
