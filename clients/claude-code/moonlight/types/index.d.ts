export type MoonlightcodePhase = 'plan' | 'auto' | 'test' | 'review' | 'commit'

export type MoonlightcodePhaseRequest = { to: MoonlightcodePhase; reason: string }

export type MoonlightcodeReviewView = { kind: 'files' } | { kind: 'file'; path: string }

export type MoonlightcodeChangedFile = {
  path: string
  status: string
  added: number
  removed: number
  repo: string
  repoPath: string
  baseline?: string
  skipped?: string
}

export type MoonlightcodeDiffLine = {
  kind: 'context' | 'added' | 'removed' | 'hunk'
  text: string
  oldLine?: number
  newLine?: number
}

export type MoonlightcodeLineAnchor = {
  path: string
  side: 'before' | 'after'
  start: number
  end: number
  removed?: { start: number; end: number }
}

export type MoonlightcodeReviewComment = MoonlightcodeLineAnchor & { id: string; body: string; excerpt?: string }

export type MoonlightcodeTriagedFinding = {
  id: string
  key: string
  severity: 'high' | 'medium' | 'low'
  route: 'patch' | 'decision' | 'defer'
  owner: string[]
  file: string
  line: number
  summary: string
  detail: string
  fix?: string
  decision: 'keep' | 'dismiss'
  note?: string
}

// One version of the agent's plan, as present_plan gave it. `decided`: the
// operator's verdict on it, once sent.
export type MoonlightcodePlan = {
  version: number
  title: string
  markdown: string
  decided?: 'approve' | 'refine' | 'reject'
}

export type MoonlightcodePlanComment = { id: string; start: number; end: number; body: string; excerpt?: string }

declare module 'claude-code' {
  interface PluginState {
    moonlightcode: {
      phase: MoonlightcodePhase
      // Who governs the session: the daemon (the mod stands by) or the mod;
      // null until session.start decides.
      governor: 'mod' | 'daemon' | null
      pending: MoonlightcodePhaseRequest | null
      reviewView: MoonlightcodeReviewView
      reviewFiles: MoonlightcodeChangedFile[]
      reviewRows: MoonlightcodeDiffLine[]
      reviewSelection: MoonlightcodeLineAnchor | null
      reviewComments: MoonlightcodeReviewComment[]
      reviewProblem: string | null
      reviewLayout: 'auto' | 'unified' | 'split'
      reviewExpanded: boolean
      reviewScope: 'auto' | 'session' | 'head'
      reviewHasBaselines: boolean
      reviewDraft: string[]
      reviewRowSelection: { from: number; to: number } | null
      reviewFindings: MoonlightcodeTriagedFinding[]
      // What the last AI review said of its own coverage, or why it failed.
      reviewFindingsStatus: string | null
      // The finding whose note is being written.
      reviewNoteFor: string | null
      // The one AI review running: its skill, whether its prompt got the
      // contract, and the turn it runs in (its end ends the run).
      reviewRun: { skill: string; isPrompted: boolean; isFromPanel?: boolean; turnId?: string } | null
      // The skill picker of "Run AI review" is open.
      reviewPicking: boolean
      // The plan under review (the latest version), its comments, the lines
      // picked (0-based rows), a comment being written, the overall note, and
      // whether Reject is asking for its reason.
      planDoc: MoonlightcodePlan | null
      planComments: MoonlightcodePlanComment[]
      planRowSelection: { from: number; to: number } | null
      planDraft: string[]
      planNote: string
      planRejecting: boolean
    }
  }
}
