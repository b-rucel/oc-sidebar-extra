// Pure reads over the OpenCode session data. No JSX, no timers, no I/O, so the
// numbers shown in the sidebar can be checked without a terminal.
import type {
	SessionInfo,
	SessionMessageAssistant,
	SessionMessageAssistantTool,
	SessionMessageInfo,
	TokenUsageInfo,
} from "@opencode/client"

export type Buckets = {
	readonly input: number
	readonly output: number
	readonly reasoning: number
	readonly cacheRead: number
	readonly cacheWrite: number
}

export type ToolRow = {
	readonly id: string
	readonly name: string
	readonly status: "running" | "completed" | "error"
	/** Milliseconds between the call starting and finishing; undefined while it runs. */
	readonly duration?: number
}

/** The last assistant step. The caller passes messages already cut at any revert boundary. */
export function lastAssistant(messages: readonly SessionMessageInfo[]): SessionMessageAssistant | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message?.type === "assistant") return message
	}
	return undefined
}

export function buckets(tokens: TokenUsageInfo | undefined): Buckets | undefined {
	if (tokens === undefined) return undefined
	return {
		input: tokens.input,
		output: tokens.output,
		reasoning: tokens.reasoning,
		cacheRead: tokens.cache.read,
		cacheWrite: tokens.cache.write,
	}
}

export function totalTokens(tokens: Buckets | undefined): number {
	if (tokens === undefined) return 0
	return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

/** Share of prompt tokens served from cache, using the host's own denominator. */
export function cacheHit(tokens: Buckets | undefined): number | undefined {
	if (tokens === undefined) return undefined
	const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite
	if (prompt <= 0) return undefined
	return tokens.cacheRead / prompt
}

/**
 * Output tokens per second over the provider response body. `now` is only used
 * while the step is still streaming.
 */
export function tps(message: SessionMessageAssistant, now: number): number | undefined {
	const tokens = buckets(message.tokens)
	if (tokens === undefined || tokens.output <= 0) return undefined
	const end = message.time.streamed ?? message.time.completed ?? now
	const elapsed = end - message.time.created
	if (elapsed <= 0) return undefined
	return (tokens.output / elapsed) * 1000
}

/**
 * Time from the assistant message starting to its first timestamped part.
 * Text parts carry no timestamp, so a reply that only streams text has none.
 */
export function ttft(message: SessionMessageAssistant): number | undefined {
	let first: number | undefined
	for (const part of message.content) {
		const created = part.type === "tool" || part.type === "reasoning" ? part.time?.created : undefined
		if (created === undefined) continue
		if (first === undefined || created < first) first = created
	}
	if (first === undefined) return undefined
	const elapsed = first - message.time.created
	return elapsed > 0 ? elapsed : undefined
}

export function toolRows(message: SessionMessageAssistant): ToolRow[] {
	const rows: ToolRow[] = []
	for (const part of message.content) {
		if (part.type !== "tool") continue
		rows.push(toolRow(part))
	}
	return rows
}

function toolRow(part: SessionMessageAssistantTool): ToolRow {
	const started = part.time.ran ?? part.time.created
	const finished = part.time.completed
	const duration = finished !== undefined && finished >= started ? finished - started : undefined
	const status =
		part.state.status === "completed" ? "completed" : part.state.status === "error" ? "error" : "running"
	return { id: part.id, name: part.name, status, duration }
}

/** Run time of a child session: live while it runs, final once it settles. */
export function elapsed(session: SessionInfo, now: number, running: boolean): number | undefined {
	// `time.busy` is the current execution's start on 2.2 servers; 2.1 types omit it.
	const busy = (session.time as { busy?: number }).busy
	if (busy === undefined) return undefined
	const end = running ? now : session.time.idle
	if (end === undefined || end < busy) return undefined
	return end - busy
}

export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0"
	if (value < 1000) return String(Math.round(value))
	if (value < 1_000_000) {
		const thousands = value / 1000
		return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`
	}
	const millions = value / 1_000_000
	return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}M`
}

export function formatCost(value: number): string | undefined {
	if (!Number.isFinite(value) || value <= 0) return undefined
	if (value < 0.01) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`
	return `$${value.toFixed(2)}`
}

export function formatDuration(milliseconds: number): string | undefined {
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined
	if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
	const seconds = Math.round(milliseconds / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const rest = seconds % 60
	if (minutes < 60) return `${minutes}m${String(rest).padStart(2, "0")}s`
	const hours = Math.floor(minutes / 60)
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
}
