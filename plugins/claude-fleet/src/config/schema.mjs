// The configuration schema — the ONE source of truth for every key claude-fleet understands.
//
// Everything else derives from this array: built-in defaults (defaults.mjs), layer resolution and
// scope enforcement (resolve.mjs), env-var coercion (env.mjs), validation (validate.mjs), the
// generated JSON schema (schema/fleet.config.schema.json via scripts/build-schema.mjs) and the
// first-run wizard's proposal table. Adding a key here is the whole job of adding a key.
//
// Entry shape:
//   key       dotted path, e.g. "devServer.urlTemplate"
//   type      "string" | "int" | "number" | "bool" | "path" | "enum" | "string[]" | "array" | "object"
//   default   the built-in default, or null when the value is derived / required
//   scope     "project" (committed .fleet/config.json) | "user" (per machine) | "either"
//   required  true → an error when absent after every layer
//   derived   a sentence saying how derive.mjs computes it when absent (never asked by the wizard)
//   secret    true → an ERROR when it appears in a project-scope file (never committed)
//   enum      allowed values (type "enum")
//   items     JSON-schema for array elements (type "array")
//   env       explicit env-var name overriding the FLEET_<UPPER_SNAKE> derivation
//   describe  one line for the wizard and the generated schema
//
// Scope is what keeps the public tool person- and company-independent: a machine path or a fleet
// size can never take effect from a committed file, so it can never leak into one by accident.

const k = (key, type, dflt, scope, extra = {}) => ({ key, type, default: dflt, scope, ...extra })

export const CANONICAL_STATES = ['in-progress', 'in-review', 'cancelled']
export const GATE_STATUSES = ['pending', 'passed', 'failed', 'uncertain', 'disputed', 'waived']

export const SCHEMA = [
  k('version', 'int', 1, 'project', { describe: 'Config file format version.' }),
  k('$pinned', 'string[]', [], 'project', {
    describe: 'Project keys the user layer may not override (env and CLI still win, with a warning).',
  }),

  // --- repo -------------------------------------------------------------------------------------
  k('repo.name', 'string', null, 'project', { derived: 'basename of the primary checkout', describe: 'Repo name used in worktree folder names.' }),
  k('repo.worktreeParent', 'path', null, 'user', { derived: 'dirname of the primary checkout', describe: 'Directory that receives the session worktrees.' }),
  k('repo.sessionDirTemplate', 'string', '{repo}-session-{n}', 'project', { describe: 'Folder name of working session n.' }),
  k('repo.slotDirTemplate', 'string', '{repo}-{branch}', 'project', { describe: "Folder name of a testing slot's worktree; {branch} is its slot branch." }),
  k('repo.checkerDirTemplate', 'string', '{repo}-check-{slice}', 'project', { describe: "Folder name of a checker session's worktree." }),
  k('repo.remote', 'string', 'origin', 'project', { describe: 'Git remote worktrees branch from.' }),
  k('repo.baseBranch', 'string', 'main', 'project', { describe: 'Branch new work starts from and PRs target.' }),

  // --- commands ---------------------------------------------------------------------------------
  k('commands.bootstrap', 'string', null, 'project', { required: true, describe: 'Command that installs a freshly created worktree (dependencies, generated files).' }),
  k('commands.devServer', 'string', null, 'project', { describe: 'Command a testing session runs to serve the app. Required when testing.count > 0.' }),
  k('commands.test', 'string', null, 'project', { describe: 'Test command a session runs before Push-PR (optional).' }),
  k('commands.build', 'string', null, 'project', { describe: 'Build command (optional).' }),
  k('commands.lint', 'string', null, 'project', { describe: 'Lint command (optional).' }),
  k('commands.typecheck', 'string', null, 'project', { describe: 'Typecheck command (optional).' }),
  k('commands.migrate', 'string', null, 'project', { describe: 'Database migration command (optional).' }),
  k('commands.stopAll', 'string', null, 'project', { describe: 'The repo-wide "stop every server" command. Named so sessions can be told never to run it.' }),

  // --- devServer --------------------------------------------------------------------------------
  k('devServer.urlTemplate', 'string', 'http://localhost:{port}', 'project', { describe: 'URL of a dev-server slot. Placeholders: {branch} {slot} {port} {repo}.' }),
  k('devServer.portBase', 'int', 3000, 'project', { describe: 'Port of slot 1 when urlTemplate uses {port}.' }),
  k('devServer.portStride', 'int', 1, 'project', { describe: 'Port increment per slot.' }),
  k('devServer.probes', 'array', [{ path: '/', expectStatus: '2xx,3xx', timeoutSec: 45 }], 'project', {
    items: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        expectStatus: { type: 'string' },
        expectNotStatus: { type: 'array', items: { type: 'integer' } },
        timeoutSec: { type: 'integer' },
        dependsOnPrevious: { type: 'boolean' },
      },
      required: ['path'],
    },
    describe: 'HTTP probes that decide a slot is up. Only 2xx/3xx counts; a dead slot behind a per-branch-host proxy answers 404.',
  }),
  k('devServer.processes', 'array', [], 'project', {
    items: { type: 'object', properties: { name: { type: 'string' }, match: { type: 'string' }, notMatch: { type: 'string' }, min: { type: 'integer' } }, required: ['name', 'match'] },
    describe: 'Process shapes a healthy slot must show. Empty = judge by probes only.',
  }),
  k('devServer.serverProcessPattern', 'string', null, 'project', { derived: 'the entry file of commands.devServer resolved through package.json scripts', describe: 'Regex identifying a dev-server process. A rogue server inside a working worktree is tree-killed by the supervisor, so this must be precise.' }),
  k('devServer.routeListCommand', 'string', null, 'project', { describe: 'Command listing registered per-branch hosts (optional).' }),
  k('devServer.softFaultStrikes', 'int', 4, 'project', { describe: 'Consecutive soft-fault scans before a slot is restarted. Two killed a healthy server that was still compiling.' }),

  // --- testing ----------------------------------------------------------------------------------
  k('testing.enabled', 'bool', true, 'project', { describe: 'Whether a local dev-server pool exists at all.' }),
  k('testing.base', 'string', 'testing', 'project', { describe: 'Slot 1 branch name; slot n is "<base>-<n>".' }),
  k('testing.maxSlots', 'int', 4, 'project', { describe: 'Largest pool the slot table can serve.' }),
  k('testing.count', 'int', 1, 'either', { min: 0, describe: 'Slots to run (0 = no local pool; captures go to cloud or none).' }),
  k('testing.branches', 'string[]', null, 'project', { derived: 'from testing.base and testing.maxSlots', describe: 'Slot branch names.' }),
  k('testing.lock.staleMinutes', 'int', 12, 'project', { describe: 'A slot lock older than this may be stolen. Staleness is decided by timestamp only.' }),
  k('testing.lock.probeTimeoutSec', 'int', 45, 'project', { describe: 'Probe timeout before handing out a slot. A recompile after a merge takes this long.' }),

  // --- install ----------------------------------------------------------------------------------
  k('install.concurrencyCap', 'int', 4, 'either', { min: 1, describe: 'Wave size for parallel installs. Env may only lower it.' }),
  k('install.perInstallGb', 'number', 4, 'project', { describe: 'Measured peak RAM of one install of this repo.' }),
  k('install.reservePhysicalGb', 'number', 8, 'user', { describe: 'Physical RAM kept free while pacing installs.' }),
  k('install.settleSec', 'int', 30, 'user', { describe: 'Quiet gap between install waves so writeback and file cache drain.' }),
  k('install.spawnStaggerSec', 'int', 3, 'user', { describe: 'Delay between window spawns / worktree adds.' }),
  k('install.holdPollSec', 'int', 20, 'user', { describe: 'Poll interval while waiting for RAM headroom.' }),
  k('install.maxHoldSec', 'int', 600, 'user', { describe: 'Run-wide budget for holding installs; then proceed with a warning.' }),
  k('install.readyFlag', 'string', '.fleet-ready', 'project', { describe: 'Sentinel file written in a worktree after a verified install.' }),
  k('install.proof.mode', 'enum', 'compare-primary', 'project', { enum: ['compare-primary', 'exists', 'explicit'], describe: 'How an install is proven complete. compare-primary snapshots the primary checkout per lockfile hash.' }),
  k('install.proof.tolerance', 'number', 0.98, 'project', { describe: 'Fraction of the reference counts a worktree must reach.' }),
  k('install.proof.probeFiles', 'string[]', [], 'project', { describe: 'Files that must exist (proof.mode explicit).' }),
  k('install.donor.enabled', 'bool', false, 'either', { describe: 'Clone node_modules from a warm donor instead of installing.' }),
  k('install.donor.path', 'path', null, 'user', { derived: '<stateDir>/nm-donor', describe: 'Donor location.' }),
  k('install.junctions.mode', 'enum', 'auto', 'project', { enum: ['auto', 'none', 'explicit'], describe: 'Workspace links recreated after a donor clone. auto derives them from package.json workspaces.' }),
  k('install.junctions.extra', 'array', [], 'project', { items: { type: 'object', properties: { link: { type: 'string' }, target: { type: 'string' } }, required: ['link', 'target'] }, describe: 'Additional links.' }),

  // --- services ---------------------------------------------------------------------------------
  k('services.docker.required', 'bool', false, 'project', { describe: 'Whether the supervisor should start Docker when it is down.' }),
  k('services.docker.startCommand', 'string', null, 'user', { derived: 'platform default', describe: 'How to start Docker on this machine.' }),
  k('services.containers', 'array', [], 'project', {
    items: { type: 'object', properties: { name: { type: 'string' }, startCommand: { type: 'string' }, healthHost: { type: 'string' }, healthPort: { type: 'integer' } }, required: ['name'] },
    describe: 'Containers the fleet needs; the supervisor repairs them.',
  }),

  // --- emulator ---------------------------------------------------------------------------------
  k('emulator.enabled', 'bool', false, 'project', { describe: 'Whether a shared Android emulator pool exists.' }),
  k('emulator.slots', 'array', [], 'project', { items: { type: 'object', properties: { avd: { type: 'string' }, port: { type: 'integer' } }, required: ['avd', 'port'] }, describe: 'AVDs in the pool; serial is emulator-<port>.' }),
  k('emulator.idleSeconds', 'int', 300, 'project', { describe: 'Idle time before the reaper shuts an emulator down.' }),
  k('emulator.lockStaleMinutes', 'int', 45, 'project', { describe: 'Emulator lock staleness (timestamp only).' }),
  k('emulator.sdkRoot', 'path', null, 'user', { derived: 'ANDROID_HOME, ANDROID_SDK_ROOT, then the platform default', describe: 'Android SDK root.' }),

  // --- tracker ----------------------------------------------------------------------------------
  k('tracker.id', 'string', null, 'project', { describe: 'Adapter id (linear, jira, github, asana, trello, or a project-supplied adapter).' }),
  k('tracker.mode', 'enum', 'mcp', 'either', { enum: ['mcp', 'manual', 'none'], describe: 'mcp = sessions call the tracker; manual = every op is queued to the outbox; none = tracker-less.' }),
  k('tracker.scope', 'string', null, 'project', { describe: 'The tracker\'s container: team / project / repo / workspace / board (the adapter says which).' }),
  k('tracker.settings', 'object', {}, 'project', { describe: 'Adapter-declared extra settings (see the adapter\'s config[] list).' }),
  k('tracker.states.in-progress', 'string', null, 'project', { derived: 'the adapter\'s promptDefault', describe: 'Name of the in-progress state.' }),
  k('tracker.states.in-review', 'string', null, 'project', { derived: 'the adapter\'s promptDefault', describe: 'Name of the in-review state.' }),
  k('tracker.states.cancelled', 'string', null, 'project', { derived: 'the adapter\'s promptDefault', describe: 'Name of the cancelled state.' }),
  k('tracker.defaultAssignee', 'string', 'me', 'user', { describe: '"me" = the authenticated tracker user; otherwise a name or email the adapter resolves.' }),
  k('tracker.queue.scope', 'string', null, 'project', { describe: 'Container the auto-refill queue is read from.' }),
  k('tracker.queue.assignee', 'string', null, 'project', { describe: 'Assignee filter of the auto-refill queue.' }),
  k('tracker.queue.state', 'string', null, 'project', { describe: 'State filter of the auto-refill queue.' }),
  k('tracker.byKeyPattern', 'array', [], 'project', { items: { type: 'object', properties: { pattern: { type: 'string' }, id: { type: 'string' } }, required: ['pattern', 'id'] }, describe: 'Reserved for multi-tracker repos; single-tracker only in v1.' }),
  k('tracker.rest.baseUrl', 'string', null, 'project', { describe: 'REST base URL for adapters whose ops need REST (self-hosted trackers).' }),
  k('tracker.rest.tokenEnv', 'string', null, 'user', { secret: true, describe: 'NAME of the env var holding the REST token. Never committed.' }),

  // --- vcs --------------------------------------------------------------------------------------
  k('vcs.branchPrefix', 'string', null, 'user', { derived: 'slug of git config user.name', describe: 'Prefix of session branches.' }),
  k('vcs.branchTemplate', 'string', '{prefix}/{key-lower}-{slug}', 'project', { describe: 'Session branch name.' }),
  k('vcs.assetsBranchTemplate', 'string', 'assets-{key}', 'project', { describe: 'Orphan branch holding PR screenshots.' }),
  k('vcs.captureRefTemplate', 'string', 'capture/{key}', 'project', { describe: 'Throwaway ref a cloud capture worker checks out.' }),
  k('vcs.captureDirTemplate', 'string', '.fleet-capture/{key}', 'project', { describe: 'In-worktree capture spec directory.' }),
  k('vcs.checkerBranchTemplate', 'string', 'check/{sweepId}/{slice}', 'project', { describe: 'Branch of a checker session.' }),
  k('vcs.pr.draft', 'bool', true, 'project', { describe: 'Open PRs as drafts.' }),
  k('vcs.pr.createCommand', 'string', 'gh pr create', 'project', { describe: 'Command that opens a PR (--draft appended from vcs.pr.draft).' }),
  k('vcs.sensitivePaths', 'string[]', [], 'project', { describe: 'Globs workers must never read (a permission prompt parks a worker forever).' }),
  k('vcs.host', 'enum', null, 'project', { enum: ['github', 'gitlab', 'other'], derived: 'from the origin URL', describe: 'Forge kind.' }),

  // --- capture ----------------------------------------------------------------------------------
  k('capture.mode', 'enum', 'local', 'either', { enum: ['local', 'cloud', 'none'], describe: 'Where before/after screenshots are taken.' }),
  k('capture.loginUrlTemplate', 'string', null, 'project', { describe: 'URL that logs a capture browser in. Placeholders: {base} {account}.' }),
  k('capture.accounts', 'string[]', [], 'project', { describe: 'Isolated capture identities (screenshots on a shared stack collide otherwise).' }),
  k('capture.runner', 'string', null, 'project', { describe: 'Command that runs a capture spec against {url}. Unset uses the bundled runner (capture/screenshot.mjs), which needs only a Chromium the repo or the machine already has.' }),
  k('capture.engine', 'enum', 'auto', 'either', { enum: ['auto', 'chromium', 'webkit'], describe: 'Browser engine captures run in. webkit is Safari\'s engine — the right answer on a Mac that will not install Chromium, at the cost of an image-based review PDF (see capture.reviewPdf).' }),
  k('capture.reviewPdf', 'bool', true, 'project', { describe: 'Render the session\'s scratch review page to a one-page PDF and attach it to the PR on the assets branch.' }),
  k('capture.bootstrapScript', 'path', null, 'project', { describe: 'Project-supplied script that brings the app up inside a cloud sandbox.' }),
  k('capture.requiredEnv', 'string[]', [], 'project', { describe: 'Env var NAMES a cloud worker asserts non-empty before installing (values never printed).' }),
  k('capture.allowlistHosts', 'string[]', [], 'project', { describe: 'Hosts a cloud sandbox must reach.' }),

  // --- fleet ------------------------------------------------------------------------------------
  k('fleet.size', 'int', null, 'user', { derived: 'clamp(1, floor((totalRam - install.reservePhysicalGb) / install.perInstallGb), cpus)', describe: 'Default number of working sessions.' }),
  k('fleet.hardCeiling', 'int', null, 'user', { derived: 'fleet.size + 2', describe: 'Never exceeded by auto-refill.' }),
  k('fleet.agent', 'enum', 'claude', 'either', { enum: ['claude', 'codex'], describe: 'Agent CLI a session runs.' }),
  k('fleet.permissionMode', 'enum', 'bypass', 'either', { enum: ['bypass', 'inherit'], describe: 'bypass = spawn sessions in the agent\'s bypass-permissions mode (the default: nobody is in the window to answer a permission prompt); inherit = leave the host default, and accept that a session can stop on one.' }),
  k('fleet.model', 'string', 'opus', 'either', { describe: 'Model passed explicitly to every session (an inherited default once put a whole fleet on the wrong model).' }),
  k('fleet.queue.selector.state', 'string', null, 'project', { derived: 'checker.ready.state, else the adapter\'s unstarted state', describe: 'State a ticket must be in to be picked up.' }),
  k('fleet.queue.selector.labels', 'string[]', [], 'project', { describe: 'Labels a ticket must carry to be picked up.' }),
  k('fleet.queue.selector.excludeLabels', 'string[]', null, 'project', { derived: '[checker.triage.label]', describe: 'Labels that hide a ticket from the queue.' }),
  k('fleet.queue.selector.group', 'string', null, 'project', { describe: 'Container filter.' }),
  k('fleet.queue.selector.assignee', 'string', null, 'project', { describe: 'Assignee filter.' }),
  k('fleet.queue.source', 'enum', 'both', 'either', { enum: ['tracker', 'findings', 'both'], describe: 'Where auto-refill reads tickets from.' }),
  k('fleet.queue.requireGate', 'bool', true, 'project', { describe: 'Refuse checker-filed tickets without a passed/waived gate verdict.' }),

  // --- paths ------------------------------------------------------------------------------------
  k('paths.stateDir', 'path', null, 'user', { derived: '%LOCALAPPDATA% or $XDG_STATE_HOME / claude-fleet / <repoSlug>', describe: 'Per-repo, per-machine state (registry, locks, flags, sweeps). Never the temp dir.' }),
  k('paths.artifactsDir', 'path', null, 'user', { derived: '<stateDir>/dev-pages', describe: 'Scratch review pages. Must not be inside any worktree.' }),
  k('paths.transcriptsDir', 'path', null, 'user', { derived: '~/.claude/projects (honours CLAUDE_CONFIG_DIR)', describe: 'Where Claude Code writes transcripts.' }),
  k('paths.nodeBinDirs', 'string[]', [], 'user', { describe: 'Extra directories holding a Node that satisfies the repo\'s engines.' }),
  k('paths.pathPrepend', 'string[]', [], 'user', { describe: 'Directories prepended to PATH in every session.' }),

  // --- terminal ---------------------------------------------------------------------------------
  k('terminal.backend', 'enum', 'auto', 'user', { enum: ['auto', 'windows-terminal', 'powershell', 'tmux', 'none'], describe: 'Terminal backend.' }),
  k('terminal.layout', 'enum', 'windows', 'user', { enum: ['windows', 'tiled-panes', 'pixel-grid'], describe: 'windows = one tab/window per session; tiled-panes = tmux tiled layout; pixel-grid = Windows-only multi-monitor tiling (opt-in).' }),
  k('terminal.tmux.session', 'string', 'fleet', 'user', { describe: 'tmux session name.' }),
  k('terminal.tmux.socket', 'string', 'fleet', 'user', { describe: 'tmux socket name (-L), so the fleet never shares the user\'s server.' }),
  k('terminal.tmux.viewer', 'enum', 'auto', 'user', { enum: ['auto', 'terminal-app', 'iterm2', 'none'], describe: 'GUI terminal opened per session so the fleet is VISIBLE (tmux creates windows detached). auto = Terminal.app or iTerm2 on a macOS desktop, none under CI/SSH and on other platforms.' }),

  // --- notifications ----------------------------------------------------------------------------
  k('notifications.command', 'string', null, 'user', { describe: 'Command run on fleet events with $FLEET_EVENT and $FLEET_MESSAGE set.' }),

  // --- playbooks --------------------------------------------------------------------------------
  k('playbooks.launcher', 'path', null, 'project', { describe: 'Override of the launcher playbook (default: bundled, then .fleet/playbooks/launcher.md).' }),
  k('playbooks.session', 'path', null, 'project', { describe: 'Override of the session playbook.' }),
  k('playbooks.testing', 'path', null, 'project', { describe: 'Override of the testing playbook.' }),
  k('playbooks.cloudCapture', 'path', null, 'project', { describe: 'Override of the cloud-capture runbook.' }),
  k('playbooks.check', 'path', null, 'project', { describe: 'Override of the checker playbook.' }),
  k('playbooks.checkAudit', 'path', null, 'project', { describe: 'Override of the audit playbook.' }),

  // --- checker ----------------------------------------------------------------------------------
  k('checker.triage.label', 'string', 'triage', 'project', { describe: 'Label a freshly filed ticket carries until promoted.' }),
  k('checker.triage.state', 'string', null, 'project', { describe: 'Optional triage state (when the tracker has one).' }),
  k('checker.ready.state', 'string', null, 'project', { derived: 'the adapter\'s unstarted state', describe: 'State a promoted ticket is moved to.' }),
  k('checker.ready.label', 'string', null, 'project', { describe: 'Optional label a promoted ticket gains.' }),
  k('checker.provenanceLabel', 'string', 'filed-by:fleet-check', 'project', { describe: 'Label marking checker-filed tickets.' }),
  k('checker.gate.labels.pending', 'string', 'gate:pending', 'project', { describe: 'Gate label: not yet audited.' }),
  k('checker.gate.labels.passed', 'string', 'gate:passed', 'project', { describe: 'Gate label: real, fix verified or absent.' }),
  k('checker.gate.labels.failed', 'string', 'gate:failed', 'project', { describe: 'Gate label: false positive or already fixed.' }),
  k('checker.gate.labels.uncertain', 'string', 'gate:uncertain', 'project', { describe: 'Gate label: could not decide.' }),
  k('checker.gate.labels.disputed', 'string', 'gate:disputed', 'project', { describe: 'Gate label: a fleet session refuted the diagnosis.' }),
  k('checker.gate.labels.waived', 'string', 'gate:waived', 'project', { describe: 'Gate label: a human admitted the ticket without an audit. Human-only.' }),
  k('checker.project', 'string', null, 'project', { describe: 'Container checker tickets are filed into (id, name or URL).' }),
  k('checker.projectPerSweep', 'bool', false, 'project', { describe: 'Create a fresh container per sweep.' }),
  k('checker.projectNameTemplate', 'string', 'Edge-case sweep {date}', 'project', { describe: 'Name of a per-sweep container.' }),
  k('checker.autoPromote', 'enum', 'never', 'either', { enum: ['never', 'after-audit'], describe: 'never = a human promotes gate:passed tickets; after-audit = --auto promotes them.' }),
  k('checker.defaultMode', 'enum', 'local', 'either', { enum: ['local', 'sessions', 'cloud'], describe: 'Where checker workers run.' }),
  k('checker.waveWidth', 'string', 'auto', 'user', { describe: 'Concurrent per-PR workers ("auto" or an integer).' }),
  k('checker.assignee', 'string', 'me', 'either', { describe: 'Default assignee of filed tickets.' }),
  k('checker.routing', 'array', [], 'either', { items: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, assignee: { type: 'string' } }, required: ['paths', 'assignee'] }, describe: 'Route tickets by the defect\'s path. Emails here in a committed file are an org chart — prefer config.local.json.' }),
  k('checker.a11y.umbrella', 'bool', true, 'project', { describe: 'File a11y findings as sub-issues of one umbrella.' }),
  k('checker.a11y.umbrellaTitle', 'string', 'a11y', 'project', { describe: 'Umbrella title.' }),
  k('checker.a11y.forcedPriority', 'int', 4, 'project', { min: 1, max: 4, describe: 'Priority every a11y-labelled ticket is forced to (null = none).' }),
  k('checker.a11y.labels.keyboard', 'string', 'a11y: keyboard', 'project', { describe: 'Keyboard-only findings.' }),
  k('checker.a11y.labels.screenReader', 'string', 'a11y: screen reader', 'project', { describe: 'Screen-reader findings.' }),
  k('checker.screenshots', 'enum', 'always', 'either', { enum: ['always', 'when-ui', 'never'], describe: 'Screenshot policy.' }),
  k('checker.attachStrategy', 'enum', 'auto', 'either', { enum: ['auto', 'native', 'assets-branch', 'attachment', 'none'], describe: 'How screenshots reach the tracker.' }),
  k('checker.securityLabel', 'string', null, 'project', { describe: 'Label marking security findings (the audit gates every High carrying it).' }),

  // --- review -----------------------------------------------------------------------------------
  k('review.riskProfile', 'enum', 'default', 'project', { enum: ['default', 'security-critical', 'data-critical', 'consumer-ui'], describe: 'Weights the edge-case lens table.' }),
  k('review.emphasis', 'string[]', [], 'project', { describe: 'Lens ids that must be explicitly reported per PR even when nothing is found.' }),
  k('review.lensOverlay', 'path', '.fleet/lenses.md', 'project', { describe: 'Optional project-specific lens additions.' }),
  k('review.securitySkill', 'string', null, 'project', { describe: 'Name of a project skill applied for the security lens.' }),
  k('review.testingSkill', 'string', null, 'project', { describe: 'Name of a project skill for reasoning about untested behaviour.' }),
]

export const SCHEMA_BY_KEY = new Map(SCHEMA.map(e => [e.key, e]))

export const LEAF_TYPES = new Set(['string', 'int', 'number', 'bool', 'path', 'enum', 'string[]'])

/** Container-typed keys (object / array) take whole values and accept nested unknown paths. */
export function isContainerType(type) {
  return type === 'object' || type === 'array'
}

/** `devServer.urlTemplate` → `FLEET_DEV_SERVER_URL_TEMPLATE`; explicit `env` wins; containers have none. */
export function envNameFor(entry) {
  if (entry.env) return entry.env
  if (!LEAF_TYPES.has(entry.type)) return null
  if (entry.key.startsWith('$')) return null
  const upper = entry.key
    .split('.')
    .map(seg => seg.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toUpperCase())
    .join('_')
  return 'FLEET_' + upper
}

export const ENV_TO_KEY = new Map(
  SCHEMA.map(e => [envNameFor(e), e.key]).filter(([name]) => name),
)
