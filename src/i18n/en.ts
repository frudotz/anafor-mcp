import type { Messages } from './tr.js';

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
};
