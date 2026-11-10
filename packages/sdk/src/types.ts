export type Status =
  "pending" | "running" | "paused" | "failed" | "complete" | "cancelled";
export type Metric = {
  raw: string | null;
  value: number | null;
  approximate: boolean;
  status: "pending" | "ready" | "failed";
  at?: string;
};
export type Note = {
  version: 1;
  id: string;
  url: string;
  originalUrl?: string;
  authorId: string;
  author: string;
  title: string;
  cover: string | null;
  type: "text" | "image" | "video" | "unknown";
  publishedAt: string | null;
  likes: Metric;
  collects: Metric;
  status: Status;
  error?: string;
  source: string;
  fetchedAt?: string;
};
export type Media = {
  type: "image" | "video";
  url: string;
  page?: number;
  path?: string;
  sha256?: string;
};
export type RawNote = {
  version: 1;
  note: Note;
  body: string | null;
  bodyStatus: "ready" | "missing";
  tags: string[];
  media: Media[];
  subtitles?: {
    language: string;
    url?: string;
    path?: string;
    sha256?: string;
    cues: { start: number; end: number; text: string }[];
  }[];
  subtitleStatus?: "ready" | "not-exposed" | "not-inspected";
  raw: unknown;
  fetchedAt: string;
};
export type Segment = {
  id: string;
  kind: "body" | "image" | "audio" | "frame" | "subtitle";
  text: string;
  page?: number;
  start?: number;
  end?: number;
  imagePath?: string;
  confidence?: number;
  boxes?: unknown[];
  evidenceText?: string[];
};
export type CleanNote = {
  version: 1;
  id: string;
  title: string;
  segments: Segment[];
  cleanText: string;
  corrections: {
    location: string;
    before: string;
    after: string;
    reason: string;
  }[];
  issues: { location: string; message: string; critical: boolean }[];
  inputHash: string;
  processorVersion: string;
};
export type Evidence = { noteId: string; segmentId: string; quote: string };
export type Method = {
  id: string;
  title: string;
  problem: string;
  conditions: string[];
  questions: string[];
  steps: string[];
  actions: string[];
  exceptions: string[];
  level: "explicit" | "inferred" | "external";
  evidence: Evidence[];
};
export type Project = {
  version: 1;
  id: string;
  name: string;
  skillName: string;
  purpose: string;
  tokenBudget?: number;
  limit: number;
  selected: string[];
  createdAt: string;
  scan: {
    status: Status;
    url?: string;
    complete: boolean;
    count: number;
    error?: string;
  };
  notes: Note[];
};
export type Job = {
  version: 1;
  ownerPid?: number;
  executor?: "desktop";
  id: string;
  projectId: string;
  status: Status;
  stage: string;
  noteStates: Record<
    string,
    {
      fetch: Status;
      clean: Status;
      extract: Status;
      error?: string;
      detail?: string;
    }
  >;
  selected: string[];
  skillName: string;
  purpose: string;
  tokenBudget?: number;
  budgetEstimate?: { additional: number; remainingNotes: string[]; remainingTitles: string[]; estimated: boolean };
  budget?: { used: number; hardLimit: number; remaining: number };
  createdAt: string;
  updatedAt: string;
  error?: string;
  output?: string;
  context?: {
    contextId: string;
    version: string;
    status: "draft" | "complete";
    processedClaims: number;
    totalClaims: number;
    unresolvedClaims: number;
    tokenUsed: number;
    skillName?: string;
    skillPath?: string;
  };
};
export type Config = {
  dataDir: string;
  codexBin: string;
  opencliBin: string;
  ffmpegBin: string;
  whisperBin: string;
  whisperModel: string;
  visionBin: string;
  guaikeiEnabled: boolean;
  requestIntervalMs: number;
  defaultLimit: number;
  maxConcurrentNotes: number;
  contextBuildEnabled: boolean;
};
export interface Provider {
  name: string;
  detail(url: string, signal?: AbortSignal): Promise<RawNote>;
  scan(
    url: string,
    onPage: (notes: Note[], complete: boolean) => void,
    signal?: AbortSignal,
  ): Promise<{ complete: boolean; reason?: string }>;
}
