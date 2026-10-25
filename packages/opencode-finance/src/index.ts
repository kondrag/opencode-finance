import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import z from "zod"
import { Plugin } from "@opencode/plugin"
import { Auth } from "./auth"
import { FINANCE_AUTH_PROVIDER, type FinanceAuthProviderID } from "./finance/auth-provider"
import { resolveProviderApiKey } from "./finance/credentials"
import { FINANCE_SLASH_COMMANDS } from "./command/finance"
import { FinancialSearchTool } from "./tool/financial-search"
import { PortfolioTool } from "./tool/portfolio"
import { PortfolioReportTool } from "./tool/portfolio-report"
import { ReportInsidersTool } from "./tool/report-insiders"
import { ReportGovernmentTradingTool } from "./tool/report-government-trading"
import { ReportDarkpoolAnomalyTool } from "./tool/report-darkpool"
import { FinancialPoliticalBacktestTool } from "./tool/financial-political-backtest"
import { ReportPdfTool } from "./tool/pdf"
import { Tool } from "./tool/tool"
import { Env } from "./env"
import { reportExecutionConstraintLines } from "./internal/report-execution-constraints"
import PROMPT_FINANCE from "./prompt/finance.txt"
import { exists, readText, writeText } from "./runtime/fs"

const REQUIRED_PROVIDER = ["alphavantage", "sec-edgar"] as const
const RECOMMENDED_PROVIDER = ["finnhub", "financial-modeling-prep", "polygon", "quartr", "quiver-quant"] as const
const AUTH_LOGIN_PROVIDER = [
  "alphavantage",
  "finnhub",
  "financial-modeling-prep",
  "polygon",
  "quartr",
  "sec-edgar",
  "quiver-quant",
] as const satisfies readonly FinanceAuthProviderID[]
const REPORT_SKILL = "finance-comprehensive-report"
const REPORT_SKILL_GIST_ENV = "FINANCE_REPORT_SKILL_GIST_URL"
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const BUNDLED_SKILL = path.resolve(MODULE_DIR, "./skill/finance-comprehensive-report.SKILL.md")
const login = (id: string) =>
  `\`curl -fsSL https://opencode.finance/install.sh | bash\` (recommended) or run \`opencode auth login\` and select \`${id}\``

const ONBOARD_TEMPLATE = [
  "Run finance plugin onboarding for report workflows.",
  "",
  "Steps:",
  "1) Validate required auth credentials:",
  `- ${login("alphavantage")}`,
  `- ${login("sec-edgar")}`,
  "2) Validate optional providers for stronger coverage:",
  `- ${login("finnhub")}`,
  `- ${login("financial-modeling-prep")}`,
  `- ${login("polygon")}`,
  `- ${login("quartr")}`,
  `- ${login("quiver-quant")}`,
  "3) If required credentials are missing, stop and print exactly which command(s) the user must run.",
  `4) Confirm skill \`${REPORT_SKILL}\` is installed; if missing, instruct the user to run \`/report <ticker>\` again after setup.`,
  "5) End with one concise readiness summary and next actions.",
].join("\n")

const ONBOARD_COMMAND = {
  name: "onboard",
  description: "Run finance plugin setup checks",
  template: ONBOARD_TEMPLATE,
}

function parseArgs(input: string) {
  const raw = input.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*'|`[^`]*`)/g) ?? []
  return raw.map((arg) => arg.replace(/^['"`]|['"`]$/g, ""))
}

function expandTemplate(template: string, args: string[]) {
  return template
    .replaceAll("$ARGUMENTS", args.join(" "))
    .replaceAll(/\$(\d+)/g, (match, index: string) => args[Number(index) - 1] ?? match)
}

async function missingRequired() {
  const checks = await Promise.all(
    REQUIRED_PROVIDER.map(async (id) => ({ id, ok: Boolean(await resolveProviderApiKey(id, { trim: true })) })),
  )
  return checks.filter((item) => !item.ok).map((item) => item.id)
}

async function missingRecommended() {
  const checks = await Promise.all(
    RECOMMENDED_PROVIDER.map(async (id) => ({ id, ok: Boolean(await resolveProviderApiKey(id, { trim: true })) })),
  )
  return checks.filter((item) => !item.ok).map((item) => item.id)
}

async function ensureSkill(directory: string) {
  const target = path.join(directory, ".opencode", "skills", REPORT_SKILL, "SKILL.md")
  if (await exists(target)) return target

  const gist = (Env.get(REPORT_SKILL_GIST_ENV) ?? "").trim()
  const content = gist
    ? await fetch(gist).then(async (response) => {
      if (!response.ok) throw new Error(`failed to fetch ${REPORT_SKILL_GIST_ENV} (${response.status})`)
      return response.text()
    })
    : await readText(BUNDLED_SKILL)
      .catch(() => {
        throw new Error(`missing bundled skill: ${BUNDLED_SKILL}`)
      })

  if (!content.trim()) throw new Error(`empty skill content for ${REPORT_SKILL}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await writeText(target, content)
  return target
}

function reportRoot(ticker: string, directory: string, date = new Date().toISOString().slice(0, 10)) {
  return path.join(directory, "reports", ticker, date)
}

async function reportCommandText(template: string, args: string[], directory: string) {
  const ticker = (args[0] ?? "").trim().toUpperCase()
  if (!ticker) {
    throw new Error("Missing ticker for `/report`. Usage: `/report <ticker> [focus]`.\nRun `/onboard` first.")
  }

  await ensureSkill(directory)
  const missing = await missingRequired()
  if (missing.length > 0) {
    throw new Error(
      [
        `Missing required dependencies for \`/report\`: ${missing.join(", ")}.`,
        ...missing.map((id) => `- ${login(id)}`),
        "Run `/onboard` to complete setup.",
      ].join("\n"),
    )
  }

  const recommended = await missingRecommended()
  const focus = args.slice(1).join(" ").trim()
  const constraints = reportExecutionConstraintLines({
    outputRoot: reportRoot(ticker, directory),
    focus,
    quiverSetupHint: login("quiver-quant"),
  })

  return [
    expandTemplate(template, args),
    ...(recommended.length > 0
      ? [`Note: optional providers missing: ${recommended.join(", ")}. Coverage may be reduced.`]
      : []),
    ...constraints,
  ].join("\n\n")
}

async function politicalBacktestCommandText(args: string[], directory: string) {
  const first = (args[0] ?? "").trim()
  const firstLower = first.toLowerCase()
  const tickerCandidate =
    first && firstLower !== "portfolio" && /^[a-z0-9.\-]+$/i.test(first) && !first.includes(",") ? first.toUpperCase() : ""
  const mode = tickerCandidate ? "ticker" : "portfolio"
  const date = new Date().toISOString().slice(0, 10)
  const scopeRoot = path.join(
    directory,
    "reports",
    "political-backtest",
    mode === "ticker" ? tickerCandidate : "portfolio",
    date,
  )

  const quiver = await resolveProviderApiKey("quiver-quant", { trim: true })
  if (!quiver) {
    throw new Error(
      [
        "Missing required dependency for `/financial-political-backtest`: quiver-quant.",
        `- ${login("quiver-quant")}`,
        "Run `/onboard` to complete setup.",
      ].join("\n"),
    )
  }

  return [
    "Execution constraints for this `/financial-political-backtest` run:",
    `- Inferred mode: \`${mode}\`.`,
    `- Write artifacts under \`${scopeRoot}\`.`,
    "- Enforce strict failure for missing required datasets, windows, or benchmark series.",
    "- Keep outputs analytic and non-advisory.",
    "- After successful markdown artifacts, ask exactly one PDF question using `question`.",
    '- If user chooses `Yes (Recommended)`, call `report_pdf` with `subcommand: "political-backtest"` and the tool-reported output root.',
    "- If user chooses `No`, skip PDF export.",
    "- If `report_pdf` fails, report the explicit error and treat the run as failed.",
  ].join("\n")
}

async function prepareTools() {
  const list = [
    FinancialSearchTool,
    PortfolioTool,
    PortfolioReportTool,
    ReportInsidersTool,
    ReportGovernmentTradingTool,
    ReportDarkpoolAnomalyTool,
    FinancialPoliticalBacktestTool,
    ReportPdfTool,
  ]
  const out: Array<{
    id: string
    description: string
    parameters: z.ZodObject<any>
    execute: (args: any, ctx: Tool.Context) => Promise<{ title: string; metadata: any; output: string }>
  }> = []
  for (const item of list) {
    const init = await item.init()
    if (!(init.parameters instanceof z.ZodObject)) {
      throw new Error(`finance plugin tool ${item.id} must declare a Zod object schema`)
    }
    out.push({
      id: item.id,
      description: init.description,
      parameters: init.parameters,
      execute: init.execute as any,
    })
  }
  return out
}

const authKeyField = (title: string, placeholder?: string) => ({
  type: "string" as const,
  key: "key",
  title,
  required: true,
  ...(placeholder ? { placeholder } : {}),
})

const authTierField = () => ({
  type: "string" as const,
  key: "tier",
  title: "Select your Quiver Quant plan tier",
  required: true,
  options: [
    { value: "tier_1", label: "Public (Tier 0)" },
    { value: "tier_2", label: "Hobbyist (Tier 0 + Tier 1)" },
    { value: "tier_3", label: "Trader (Tier 0 + Tier 1 + Tier 2)" },
    { value: "enterprise", label: "Enterprise (Tier 0 + Tier 1 + Tier 2)" },
  ],
})

export default Plugin.define({
  id: "opencode-finance",
  async setup(ctx) {
    const tools = await prepareTools()

    // The session's location can change after setup (session moves, worktrees),
    // so resolve the working directory per call instead of pinning it here.
    const resolveDirectory = async (sessionID: string): Promise<string> => {
      const session = await ctx.session.get({ sessionID }).catch(() => undefined)
      return session?.location?.directory ?? ctx.location.directory
    }

    await ctx.tool.transform((editor) => {
      for (const tool of tools) {
        editor.add({
          name: tool.id,
          description: tool.description,
          input: tool.parameters,
          async execute(input, context) {
            const directory = await resolveDirectory(context.sessionID)
            const result = await tool.execute(input as any, {
              directory,
              worktree: "/",
              abort: context.signal,
              async ask(request) {
                await ctx.permission.assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                  action: request.permission,
                  resources: request.patterns,
                  save: request.always,
                  metadata: request.metadata,
                })
              },
              metadata(update) {
                void context.progress({
                  ...(update.title !== undefined ? { title: update.title } : {}),
                  ...update.metadata,
                })
              },
            })
            return {
              content: result.output,
              metadata: { title: result.title, ...result.metadata },
            }
          },
        })
      }
    })

    await ctx.command.transform((editor) => {
      for (const command of [...FINANCE_SLASH_COMMANDS, ONBOARD_COMMAND]) {
        editor.add({
          name: command.name,
          description: command.description,
          async execute({ sessionID, prompt, delivery }) {
            const directory = await resolveDirectory(sessionID)
            const args = parseArgs(prompt.text)
            let text = expandTemplate(command.template, args)

            if (command.name === "report") {
              text = await reportCommandText(command.template, args, directory)
            } else if (command.name === "financial-political-backtest") {
              text = [text, await politicalBacktestCommandText(args, directory)].join("\n\n")
            }

            await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
          },
        })
      }
    })

    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: PROMPT_FINANCE })
    })

    await ctx.integration.transform((editor) => {
      for (const id of AUTH_LOGIN_PROVIDER) {
        editor.update(id, (integration) => {
          integration.name = FINANCE_AUTH_PROVIDER[id].name
        })
        editor.method.update({
          integrationID: id,
          method: {
            type: "key",
            label: FINANCE_AUTH_PROVIDER[id].name,
            form:
              id === "quiver-quant"
                ? [authKeyField("Enter your Quiver Quant API key"), authTierField()]
                : id === "sec-edgar"
                  ? [authKeyField("Enter SEC EDGAR identity", "MyCompany dev@mycompany.com")]
                  : [
                      authKeyField(
                        `Enter your ${FINANCE_AUTH_PROVIDER[id].name} API key`,
                      ),
                    ],
          },
        })
      }
    })

    Auth.use(async (providerID) => {
      const connection = await ctx.integration.connection.active(providerID)
      if (!connection) return
      const credential = await ctx.integration.connection.resolve(connection)
      if (!credential || credential.type !== "key") return
      return Auth.fromKeyCredential(credential)
    })

    return () => Auth.use(undefined)
  },
})
