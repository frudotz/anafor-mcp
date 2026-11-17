import type { Messages } from './tr.js';

const GUIDE_EN =
  'External skills/MCP servers are installed only through the SkillSpector gate: `anafor ext add <source>` (skill) or `anafor ext add-mcp <name> --source <source> -- <command…>`; to scan an existing one use `anafor ext adopt <name>`.';

/** English message catalog. Must have exactly the same keys as `tr.ts` (type-checked). */
export const en: Messages = {
  help: (v: string) => `anafor ${v}
usage:
  anafor setup [--yes] [--lang tr|en] [--no-plugin] [--no-statusline] [--no-project]
                          first-run wizard (language, workers, persistent plugin, statusline, project)
  anafor init [dir]       connect a project: .anafor/, policy (.mcp.json if no plugin)
  anafor doctor [dir] [--json]
                          environment, project and worker checks (--json: for AI agents)
  anafor update [--check] download the latest release, verify SHA-256, install, refresh plugin
  anafor mcp [dir]        start the MCP server on stdio
  anafor migrate [dir]    copy legacy .orchestrator/ state into .anafor/ (source untouched)
  anafor chat [--new] [--once "message"] [--model m]
                          talk to the brain agent from the terminal; jobs stream live
  anafor run "<goal>" [--accept] [--merge] [--worker w] [--review level]
                          headless: the brain pursues the goal unattended (permission prompts denied)
  anafor jobs [--all]     task and job board
  anafor watch            live job events
  anafor roles [set <role> <worker1,worker2>]
                          brain and worker roles
  anafor limits           session/usage limits of connected AIs
  anafor capacity [--json] capacity (CP), jobs left per role, load hints
  anafor capacity recommend <sub1,sub2> [--apply]
                          recommended role split for your subscriptions (meta profile)
  anafor ext <check|list|add|add-mcp|adopt|remove>
                          SkillSpector gate for external skills/MCP servers
  anafor statusline       Claude Code statusLine command
  anafor hook <event>     Claude Code hook (pre-tool-use | session-start), input on stdin
  anafor version
Language: ANAFOR_LANG=tr|en or anafor setup --lang`,

  ui: { yes: 'Yes', no: 'No', cancelled: 'Cancelled.' },

  setup: {
    title: (v: string) => ` Anafor setup · v${v} `,
    language: 'Dil / Language',
    envCheck: 'Checking environment',
    envTitle: '1 · Environment',
    nodeNeed: '(24+ required)',
    notFound: 'not found',
    envMissing: 'Required components are missing; install them and run `anafor setup` again.',
    workersDetect: 'Detecting workers',
    workersTitle: (ready: number, total: number) =>
      `2 · Workers (${ready}/${total} ready · brain: Claude Code)`,
    unavailable: 'unavailable',
    pluginStep: '3 · Claude Code plugin',
    pluginStepHint: 'manager hooks, Anafor MCP, /anafor:* commands',
    pluginAsk: 'Install the plugin into Claude Code permanently?',
    pluginOk: 'Installed: anafor@anafor-local',
    pluginFail: 'Installation failed',
    pluginSession: 'Not installed permanently; per session:',
    statusStep: '4 · Statusline',
    statusStepHint: 'version, updates, limits and health',
    statusAsk: 'Install the statusline? (an existing one is kept)',
    projectStep: '5 · Project',
    projectAlready: 'This directory is already an Anafor project:',
    projectAsk: 'Connect this git repository to Anafor?',
    projectDone: 'Project connected.',
    projectHint: 'To connect a project:',
    nextTitle: 'Next steps',
    nextClaude: 'inside Claude Code: /anafor:plan <goal>',
    nextChat: 'talk to the brain agent from the terminal',
    nextCapacity: 'limits, jobs left and role recommendation',
    nextDoctor: 'checks when something is wrong',
    guide: 'Guide:',
    ready: 'Ready.',
    restart: 'Restart Claude Code for the changes to take effect.',
  },

  doctor: {
    title: (v: string) => ` anafor doctor · v${v} `,
    sections: { Anafor: 'Anafor', Ortam: 'Environment', Proje: 'Project', İşçiler: 'Workers' },
    workersReady: (ready: number, total: number) => `Workers (${ready}/${total} ready)`,
    workersCheck: 'Checking workers',
    version: 'version',
    updateAvail: (cur: string, next: string) => `v${cur} → v${next} available`,
    setup: 'setup',
    setupMissing: 'setup wizard has not been run',
    plugin: 'plugin',
    pluginPersistent: (v: string) => `installed persistently (v${v})`,
    pluginNotPersistent: 'not installed persistently',
    nodeFix: 'Install Node 24+: https://nodejs.org',
    notFound: 'not found',
    gitRepo: 'git repository',
    yes: 'yes',
    notGitRepo: 'this directory is not a git repository',
    project: 'project',
    notInit: 'this directory is not connected to Anafor',
    store: 'state store',
    storeFix:
      '.anafor/state.db may be locked by another process; close Claude Code sessions and retry',
    last24: 'last 24 h',
    failedJobs: (n: number) => `${n} failed job${n === 1 ? '' : 's'}`,
    jobsFix: 'anafor jobs --all (error reasons)',
    extensions: 'extensions',
    extBlocked: (n: number, list: string) => `${n} blocked: ${list}`,
    extOk: 'all scanned',
    ssMissing: 'missing: external skills/MCP servers cannot be added',
    ssFix:
      'Python 3.13 venv + pip install git+https://github.com/NVIDIA/skillspector.git (docs/agent-install.md)',
    unavailable: 'unavailable',
    worker: 'worker',
    noWorkers: 'no usable worker',
    problems: (n: number, list: string) => `${n} problem${n === 1 ? '' : 's'}: ${list}`,
    warnings: (n: number, list: string) => `Working; ${n} suggestion${n === 1 ? '' : 's'}: ${list}`,
    allGood: 'All good.',
  },

  status: {
    update: (v: string) => `⬆ v${v}: anafor update`,
    pluginOld: (v: string) => `plugin v${v}`,
    problem: 'problem',
    jobsFailed: (n: number) => `${n} jobs failed`,
  },

  update: {
    upToDate: (v: string) => `Anafor is up to date: v${v}`,
    newVersion: (cur: string, next: string) => `New version: v${cur} → v${next}`,
    verified: (h: string) => `✔ SHA-256 verified (${h}…)`,
    installed: '✔ Package installed; refreshing plugin…',
    pluginFail: '▲ Plugin could not be refreshed; run `anafor setup` manually.',
    done: (v: string) => `Updated to v${v}. Restart Claude Code.`,
    failed: (e: string) => `Update failed: ${e}`,
  },

  windows: {
    reset: 'reset',
    fiveHour: '5h',
    sevenDay: '7d',
    locale: 'en-GB',
  },

  cli: {
    notProject:
      'This directory is not an Anafor project. Run `anafor init` (or `anafor setup`) first.',
    pluginMcp:
      'The Anafor plugin is installed persistently: the MCP server comes from the plugin, .mcp.json was not written.',
    mcpCreated: '.mcp.json created (anafor server).',
    mcpExists: '.mcp.json already exists; add the anafor entry manually:',
    ready: (dir: string) => `Anafor ready: ${dir}`,
    migrateFailed: (e: string) => `migration failed: ${e}`,
    runUsage:
      'usage: anafor run "<goal>" [--accept] [--merge] [--worker w] [--review lightweight|standard|deep] [--model m]',
    watching: 'Watching jobs (Ctrl+C to quit)…',
    rolesUsage: (roles: string) => `usage: anafor roles set <${roles}> <worker1,worker2,…>`,
    unknownWorkers: (unknown: string, known: string) =>
      `warning: unregistered worker: ${unknown} (registered: ${known})`,
    brainRow: 'brain       claude (Claude Code + Anafor plugin)',
    balancer: (strategy: string) =>
      `\nload balancer: ${strategy} (balancer.strategy: off | balanced | protect-brain | cheap-first)`,
    workers: (list: string) => `workers: ${list}`,
    rolesHint: 'to change: anafor roles set <role> <worker1,worker2>',
    noLimits: 'No limit data yet (fills in as workers run or via the statusline).',
    ago: (min: number, source: string) => `(${min} min ago, ${source})`,
  },

  capacityCmd: {
    fullInDays: (n: number) => ` full in ~${n}d`,
    fullInHours: (n: number) => ` full in ~${n}h`,
    title: 'Capacity (CP = 1% of a window; free = 100 − used − reserve)',
    noObservation: 'not observed',
    free: 'free',
    pace: 'pace',
    roleRow: (kp: number, left: number, samples: number) =>
      `~${kp} CP per job → ~${left} jobs (${samples} samples)`,
    hints: 'Hints:',
    noSubscriptions:
      'No subscriptions selected: for a recommended role split run `anafor capacity recommend <sub1,sub2>`',
    recTitle: (period: string) => `Recommended role split (meta ${period}):`,
    brain: 'brain',
    subscriptions: 'Subscriptions:',
    tiers: 'Tiers:',
    recUsage: 'usage: anafor capacity recommend <sub1,sub2> [--apply]',
    applied: 'anafor.config.json updated: subscriptions + routing.',
    applyHint: 'To apply: --apply (anafor.config.json → subscriptions + routing)',
  },

  capacity: {
    days: (n: number) => `${n} d`,
    hours: (n: number) => `${n} h`,
    notObserved: (account: string, roles: string) =>
      `${account}: limits not observed yet (used by roles ${roles}); estimates appear after the first jobs.`,
    reserveReached: (
      account: string,
      label: string,
      used: number,
      reserve: number,
      resets: string | null,
    ) =>
      `${account}: ${label} window reached the reserve (${used}%, reserve ${reserve}%)` +
      (resets ? `; resets ${resets}` : '') +
      '. New jobs should go to the next worker.',
    fastDrain: (account: string, label: string, pace: number, dur: string, resets: string) =>
      `${account}: ${label} is draining fast (pace ×${pace}); at this rate it fills in ~${dur}, resets ${resets}.`,
    jobsLeft: (account: string, role: string, left: number, kp: number) =>
      `${account}: ~${left} jobs of capacity left for '${role}' (~${kp} CP per job).`,
    promote: (role: string, first: string, next: string, cmd: string) =>
      `'${role}' role: ${first} is constrained → ${next} can be moved first (${cmd}).`,
    noBackup: (role: string, first: string) =>
      `'${role}' role: ${first} is constrained and the chain has no healthy fallback; consider adding another worker.`,
  },

  balancer: {
    reserve: (name: string, used: number) => `${name} reached the reserve (${used}%)`,
    noFit: (kp: number) => `estimated job cost (~${kp} CP) does not fit the free capacity`,
    fast: (name: string, pace: number) => `${name} is draining fast (pace ×${pace})`,
    protectBrain: 'protecting the brain account',
    cheaper: 'cheaper tier',
    note: (strategy: string, before: string, after: string) =>
      `load balancer (${strategy}): ${after} instead of ${before}`,
  },

  meta: {
    tiers: {
      K1: 'frontier (Opus, Codex high)',
      K2: 'mid-strong (Sonnet, Codex medium, Gemini Flash)',
      K3: 'cheap API / open weights (GLM, DeepSeek, Kimi, Qwen)',
      K4: 'light (Haiku, Codex Luna)',
      K5: 'local (Ollama, LM Studio)',
    },
    labels: {
      claudeUltra: 'Claude Ultra (10x, no 5-hour window)',
      chatgptPro: 'ChatGPT Pro (Codex, weekly only)',
      geminiApi: 'Gemini API key',
      localGpu: 'Local model (24 GB+ GPU)',
    },
    notes: {
      claudeMax: 'The claude-lite worker can use Sonnet (workers.claude-lite.model).',
      geminiApi: 'Personal account sign-in is not supported by Gemini CLI; an API key is required.',
      antigravity: 'Terms are a grey area; off by default, requires acknowledge_terms.',
      opencodeApi: 'Qwen Coding Plan forbids automation; prefer pay-as-you-go API.',
      localGpu: 'Short jobs only: docs, test scaffolding, single files. Never brain/plan/review.',
    },
    headless: { ok: 'ok', gri: 'grey area', yasak: 'forbidden' },
    terms: (label: string, headless: string, note: string) =>
      `${label}: terms ${headless}. ${note}`,
    unknownSub: (unknown: string, known: string) =>
      `Unknown subscription: ${unknown} (known: ${known})`,
    needClaude: 'The brain needs a Claude subscription (the Anafor manager is Claude Code).',
    brainPro: 'Sonnet (Opus only at plan/decision points)',
    brainMax: 'Opus (Sonnet + Opus advisor under limit pressure)',
    brainFrontier:
      'Brain on the frontier tier: workers spend most tokens, and a brain mistake wastes the whole round.',
    crossFamily: (impl: string, reviewer: string) =>
      `Review in a different model family: ${impl} implements, ${reviewer} reviews.`,
    singleFamily:
      'Only one model family: review comes from the implementer’s family (blind-spot risk).',
    localOnly: 'Local model is only a test/analysis fallback; unreliable in long agent loops.',
    noWorker: (role: string) => `No suitable worker for '${role}'.`,
  },

  chat: {
    session: (id: string, model: string) => `[brain session ${id} · ${model}]`,
    brainPrompt: 'brain ›',
    turnDone: 'turn done',
    steps: (n: number) => `${n} step${n === 1 ? '' : 's'}`,
    apiCost: (usd: string) => `API equivalent ~$${usd}`,
    closed: (code: string) => `[brain session closed (${code})]`,
    noTasks: '(no tasks)',
    noLimits: '(no limit data)',
    deniedHeadless: (tool: string) => `! permission denied (non-interactive): ${tool}`,
    askPermission: (tool: string, brief: string) =>
      `? The brain asks for permission: ${tool} ${brief}\n  [y]es / [n]o / [d]on't ask again (this session): `,
    title: 'Anafor chat',
    youPrompt: 'you › ',
    pending: (n: number) => `${n} pending permission request${n === 1 ? '' : 's'}`,
    newSession: 'For a new session, quit and run `anafor chat --new`.',
    sessionClosed: 'The brain session is closed; restart with `anafor chat`.',
  },

  ext: {
    install:
      'SkillSpector not found. Install (Python 3.12/3.13): `py -3.13 -m venv ~/.anafor/tools/skillspector` and `~/.anafor/tools/skillspector/Scripts/python -m pip install git+https://github.com/NVIDIA/skillspector.git` (Linux/macOS: bin/python), or `uv tool install --python 3.13 git+https://github.com/NVIDIA/skillspector.git`. Custom path: anafor.config.json → extensions.skillspector_bin',
    scan: 'scan',
    score: 'score',
    installed: (dest: string) => `installed: ${dest}`,
    blocked: 'BLOCKED',
    needsAck: 'approval required',
    error: 'error',
    help: `usage:
  anafor ext check                        scan and registration status of installed skills/MCP servers
  anafor ext list                         registered extensions
  anafor ext add <dir|git-url> [--path sub/dir] [--name name] [--user] [--accept-risk]
                                          scan a skill with SkillSpector, install it if it passes
  anafor ext add-mcp <name> --source <dir|git-url> [--accept-risk] -- <command> [arg…]
                                          scan an MCP server's source, add it to .mcp.json if it passes
  anafor ext adopt <name> [--user] [--accept-risk]
                                          scan an already installed skill in place and register it
  anafor ext remove <name> [--user] [--mcp] delete the registration (files untouched)
Policy: HIGH/CRITICAL and scan errors are blocked; CAUTION only with --accept-risk (user approval).`,
    noneInstalled: 'No local skills or project MCP servers installed.',
    blockedCount: (n: number) =>
      `${n} extension${n === 1 ? '' : 's'} blocked. Skills: anafor ext adopt <name> [--user]; MCP: re-add with anafor ext add-mcp ….`,
    noneRegistered: 'No registered extensions.',
    riskAccepted: ' (risk accepted)',
    removed: (name: string) => `${name}: registration removed`,
    notFound: (name: string) => `${name}: not registered`,
  },

  gate: {
    scanFailed: (e: string) => `scan failed (fail-closed): ${e}`,
    label: (score: number, severity: string, rec: string) => `score ${score} ${severity} ${rec}`,
    blocked: (label: string) => `${label}: cannot be installed`,
    riskAccepted: (label: string) => `${label}: risk explicitly accepted`,
    needsAck: (label: string) => `${label}: review the findings and approve with --accept-risk`,
    sourceMissing: (source: string) => `source directory not found: ${source}`,
    cloneFailed: (e: string) => `git clone failed: ${e}`,
    noSkillMd: (dir: string) => `no SKILL.md in ${dir}`,
    skillMdMissing: 'SKILL.md not found',
    multipleSkills: (list: string) => `multiple skills found; pick one with --path: ${list}`,
    destExists: (dest: string, cmd: string) =>
      `${dest} already exists and is not registered: scan it first with \`${cmd}\``,
    emptyCommand: 'empty command',
    reservedName: 'the name "anafor" is reserved',
  },

  skillspector: {
    notJson: 'SkillSpector report is not JSON',
    noRisk: 'SkillSpector report has no risk_assessment',
    spawnFailed: (e: string) => `SkillSpector could not be started: ${e}`,
    failed: (code: string, msg: string) => `SkillSpector failed (exit ${code}): ${msg}`,
  },

  guard: {
    skillOk: 'registered skill',
    mcpOk: 'registered MCP',
    changed: 'has CHANGED since it was scanned',
    unscanned: 'has not been scanned by SkillSpector',
    mcpChanged: 'command differs from the registration',
    skillBlocked: (name: string, state: string, cmd: string) =>
      `ANAFOR extension gate: skill '${name}' ${state}. Ask the user to run \`${cmd}\`.`,
    mcpBlocked: (server: string, state: string) =>
      `ANAFOR extension gate: MCP server '${server}' ${state}. ${GUIDE_EN}`,
    directWrite: `ANAFOR extension gate: skill/MCP files cannot be written directly. ${GUIDE_EN}`,
    acceptRisk:
      'ANAFOR extension gate: only the user can accept a CAUTION risk. Show the findings to the user; if they approve, they run the command in their own terminal.',
    installCmd: (what: string) =>
      `ANAFOR extension gate: '${what}' cannot be used directly. ${GUIDE_EN}`,
  },

  director: {
    why: {
      redirect: 'output redirection (>)',
      fsCommand: 'file system command',
      inPlace: 'in-place edit (-i)',
      gitMutation: 'git command that changes the working tree',
      psCmdlet: 'file-modifying PowerShell cmdlet',
      dotnetWrite: '.NET file write',
      scriptWrite: 'file write inside a script',
    },
    deny: (what: string) =>
      `ANAFOR manager mode: ${what}. You are the manager; hand the work to a worker: ` +
      `anafor MCP tool job_dispatch (job_request_changes for fixes). ` +
      `If there is a real snag (a small, clear problem the worker cannot solve), first get a justified, time-limited permission with the anafor MCP tool intervene.`,
    outside: 'outside the project',
    allowedPath: 'allowed path',
    grant: (id: string) => `intervention grant ${id}`,
    editForbidden: (rel: string) => `editing '${rel}' directly is forbidden`,
    activeGrant: 'active intervention grant',
    shellForbidden: (why: string) => `file-modifying shell command (${why})`,
  },

  sessionStart: {
    managed: (mode: string) =>
      `[Anafor] This project is managed by Anafor (director_mode: ${mode}).`,
    role: 'You are the MANAGER: plan, dispatch to workers with the anafor MCP tool job_dispatch, review, accept. Do not edit code files yourself; use intervene for snags.',
    board: (tasks: number, active: number, review: number, grants: number) =>
      `Open tasks: ${tasks} · running jobs: ${active} · awaiting review: ${review} · active interventions: ${grants}`,
    awaitingReview: (id: string, worker: string, role: string) =>
      `- awaiting review: ${id} (${worker}, ${role})`,
    extBlocked: (n: number, list: string) =>
      `⚠ Extension gate: ${n} skill/MCP unscanned or changed (${list}); calls are blocked. User: anafor ext check`,
  },

  setupLib: {
    settingsInvalid: 'could not read settings.json (invalid JSON); add it manually',
    statusAlready: 'Anafor statusLine is already installed',
    statusOther: 'another statusLine exists; keeping it',
    statusUpdated: 'statusLine updated (backup: settings.json.anafor-backup)',
    statusAdded: 'statusLine added (backup: settings.json.anafor-backup)',
    hints: {
      gitleaks:
        'Optional secret scanner: gitleaks v8.30.1 (gh release download + checksum; docs/kurulum.md)',
      codex: 'npm install -g @openai/codex  →  codex login',
      'claude-lite':
        'Claude Code must be installed: https://claude.com/claude-code  →  claude auth login',
      gemini: 'API key only: npm install -g @google/gemini-cli + GEMINI_API_KEY',
      opencode:
        'https://opencode.ai  →  anafor.config.json: workers.opencode.model (API key, local model or ChatGPT plan)',
      local: 'Ollama (https://ollama.com) or LM Studio  →  anafor.config.json: workers.local.model',
      antigravity:
        'Terms are a grey area: only with workers.antigravity.enabled + acknowledge_terms; an API key is recommended',
    },
  },

  adapters: {
    windowsSandbox: (mode: string) =>
      `Windows sandbox "${mode}": the worker may not be able to start subprocesses (spawn EPERM), ` +
      'so tests will not run. Suggestion: anafor.config.json → workers.codex.windows_sandbox = "elevated"',
    sandboxDefault: 'default',
    codexLogin: 'codex is not logged in: `codex login`',
    geminiKey:
      'Gemini CLI works only with an API key (GEMINI_API_KEY); personal account sign-in ended on 2026-06-18',
    geminiMissing: 'gemini CLI is not installed',
    geminiAuth:
      'No auth method selected in Gemini settings: ~/.gemini/settings.json → "security": { "auth": { "selectedType": "gemini-api-key" } }',
    agyTerms:
      'Antigravity terms are a grey area: workers.antigravity.acknowledge_terms=true required (an API key is recommended)',
    agyMissing: 'agy is not installed',
    opencodeModel: 'workers.opencode.model must be set (provider/model)',
    opencodeAnthropic:
      'anthropic/* models via OpenCode only with an API key (allow_anthropic_api); use claude-lite for a Claude subscription',
    opencodeMissing: 'opencode is not installed',
    localNoModel: (model: string, list: string) => `model not found: ${model} (available: ${list})`,
    localUnreachable: (url: string, e: string) => `${url} unreachable: ${e}`,
  },
};
