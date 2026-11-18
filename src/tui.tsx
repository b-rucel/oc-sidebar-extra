// oc-sidebar-extra — three sidebar blocks the host does not ship:
// subagents, usage detail (tokens, cache, tps, ttft) and tool activity.
//
// One `append` claim on `sidebar.content`, so it renders under every built-in
// block (Context, Limit, MCP, Todo). Rows are event-driven off the reactive
// data store; the only timer runs while a child session is actually working.
import { Plugin } from "@opencode/plugin/tui"
import type { BoxRenderable, RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import type { UsageLimitsGo, UsageLimitsMeter } from "@opencode/client"
import { execFile } from "node:child_process"
import { basename } from "node:path"
import { promisify } from "node:util"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import {
	buckets,
	elapsed,
	formatCost,
	formatDuration,
	formatTokens,
	lastAssistant,
	toolRows,
	tps,
	type Buckets,
	type ToolRow,
} from "./lib"

const exec = promisify(execFile)

const SUBAGENT_LIMIT = 5
const TOOL_LIMIT = 4

type Colors = {
	readonly base: RGBA
	readonly dim: RGBA
	readonly faint: RGBA
	readonly border: RGBA
	readonly success: RGBA
	readonly warning: RGBA
	readonly error: RGBA
	readonly syntax: {
		readonly keyword: RGBA
		readonly string: RGBA
		readonly number: RGBA
		readonly function: RGBA
		readonly type: RGBA
		readonly operator: RGBA
		readonly variable: RGBA
	}
}

function colorsOf(theme: Plugin.Context["theme"]): Colors {
	const pick = (...paths: readonly (readonly string[])[]): RGBA | undefined => {
		for (const path of paths) {
			let node: unknown = theme
			for (const key of path) {
				if (typeof node !== "object" || node === null) {
					node = undefined
					break
				}
				node = (node as Record<string, unknown>)[key]
			}
			if (node !== undefined && node !== null) return node as RGBA
		}
		return undefined
	}
	const base = pick(["text", "base"])
	if (base === undefined) throw new Error("theme has no text colour")
	const dim = pick(["text", "muted"], ["text", "faint"]) ?? base
	return {
		base,
		dim,
		faint: pick(["text", "faint"], ["text", "muted"]) ?? dim,
		border: pick(["border", "base"], ["border", "muted"], ["text", "faint"]) ?? dim,
		success: pick(["text", "feedback", "success", "base"], ["syntax", "string"]) ?? base,
		warning: pick(["text", "feedback", "warning", "base"], ["syntax", "number"]) ?? base,
		error: pick(["text", "feedback", "error", "base"]) ?? base,
		syntax: {
			keyword: pick(["syntax", "keyword"]) ?? base,
			string: pick(["syntax", "string"]) ?? base,
			number: pick(["syntax", "number"]) ?? base,
			function: pick(["syntax", "function"]) ?? base,
			type: pick(["syntax", "type"]) ?? base,
			operator: pick(["syntax", "operator"]) ?? base,
			variable: pick(["syntax", "variable"]) ?? base,
		},
	}
}

/** One theme colour per metric, so the list reads as categories rather than one grey column. */
function labelTone(label: string, colors: Colors): RGBA {
	switch (label) {
		case "input":
			return colors.syntax.variable
		case "output":
			return colors.syntax.string
		case "thinking":
			return colors.syntax.keyword
		case "cache r":
			return colors.syntax.type
		case "cache w":
			return colors.syntax.operator
		case "speed":
			return colors.syntax.function
		case "cost":
			return colors.syntax.number
		case "git":
			return colors.syntax.keyword
		case "changed":
			return colors.syntax.string
		case "untracked":
			return colors.syntax.operator
		case "binary":
			return colors.syntax.type
		case "submodules":
			return colors.syntax.type
		case "history":
			return colors.syntax.function
		case "storage":
			return colors.syntax.number
		case "conflicts":
			return colors.error
		default:
			return colors.dim
	}
}

function Panel(props: {
	title: string
	count?: number
	colors: Colors
	onWidth?: (width: number) => void
	children: JSX.Element
}) {
	let inner: BoxRenderable | undefined
	const measure = () => props.onWidth?.(inner?.width ?? 0)
	return (
		<box
			border
			borderStyle="rounded"
			borderColor={props.colors.border}
			paddingLeft={1}
			paddingRight={1}
			flexDirection="column"
			flexShrink={0}
			minWidth={0}
		>
			<box
				ref={(el) => {
					inner = el as BoxRenderable
					inner.onSizeChange = measure
				}}
				flexDirection="column"
				minWidth={0}
			>
			<box flexDirection="row" gap={1}>
				<text fg={props.colors.base}>
					<b>{`\u2726 ${props.title}`}</b>
				</text>
				<Show when={props.count !== undefined}>
					<text fg={props.colors.dim}>{props.count}</text>
				</Show>
			</box>
			{props.children}
			</box>
		</box>
	)
}

type CellData = { readonly label: string; readonly value: string; readonly tone?: RGBA }

type Step = { readonly used: Buckets; readonly speed: number | undefined }

function Cell(props: { label: string; value: string; colors: Colors; tone?: RGBA }) {
	return (
		<box flexDirection="row" flexGrow={1} flexBasis={0} minWidth={0} justifyContent="space-between" gap={1}>
			<text fg={props.colors.dim} wrapMode="none">
				{props.label}
			</text>
			<text fg={props.tone ?? props.colors.base} wrapMode="none" truncate>
				{props.value}
			</text>
		</box>
	)
}

/** Label left, arbitrary JSX on the right edge. */
function Pair(props: { label: string; colors: Colors; children: JSX.Element }) {
	return (
		<box flexDirection="row" minWidth={0} justifyContent="space-between" gap={1}>
			<text fg={labelTone(props.label.toLowerCase(), props.colors)} wrapMode="none">
				{props.label}
			</text>
			<box flexDirection="row" gap={1} flexShrink={0}>
				{props.children}
			</box>
		</box>
	)
}

/** One metric per row: label left, value on the right edge. */
function Cells(props: { cells: ReadonlyArray<CellData>; colors: Colors }) {
	return (
		<For each={props.cells}>
			{(cell) => (
				<box flexDirection="row" minWidth={0} justifyContent="space-between" gap={1}>
					<text fg={labelTone(cell.label, props.colors)} wrapMode="none">
						{cell.label}
					</text>
					<text fg={props.colors.base} wrapMode="none" truncate>
						{cell.value}
					</text>
				</box>
			)}
		</For>
	)
}

function Subagents(props: { context: Plugin.Context; sessionID: string; colors: Colors }) {
	const data = props.context.data
	const [now, setNow] = createSignal(Date.now())

	const children = createMemo(() =>
		data.session
			.family(props.sessionID)
			.filter((id) => id !== props.sessionID && data.session.get(id)?.parentID === props.sessionID)
			.sort((left, right) => {
				const leftRunning = data.session.status(left) === "running" ? 0 : 1
				const rightRunning = data.session.status(right) === "running" ? 0 : 1
				if (leftRunning !== rightRunning) return leftRunning - rightRunning
				return (data.session.get(right)?.time.updated ?? 0) - (data.session.get(left)?.time.updated ?? 0)
			}),
	)

	createEffect(() => {
		const running = children().some((id) => data.session.status(id) === "running")
		if (!running) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		onCleanup(() => clearInterval(timer))
	})

	const open = (id: string) => {
		if (props.context.ui.tabs.enabled() && props.context.ui.tabs.focus(id)) return
		props.context.ui.router.navigate({ type: "session", sessionID: id })
	}

	return (
		<Panel title="SUBAGENTS" count={children().length || undefined} colors={props.colors}>
			<Show when={children().length === 0}>
				<text fg={props.colors.dim}>none</text>
			</Show>
				<For each={children().slice(0, SUBAGENT_LIMIT)}>
					{(id) => {
						const session = createMemo(() => data.session.get(id))
						const running = createMemo(() => data.session.status(id) === "running")
						const taken = createMemo(() => {
							const current = session()
							if (current === undefined) return undefined
							return elapsed(current, now(), running())
						})
						const cost = createMemo(() => formatCost(data.session.cost(id)))
						return (
							<box flexDirection="row" gap={1} minWidth={0} onMouseUp={() => open(id)}>
								<text flexShrink={0} fg={running() ? props.colors.success : props.colors.faint}>
									{running() ? "\u25cf" : "\u25cb"}
								</text>
								<text flexShrink={1} minWidth={0} wrapMode="none" truncate fg={props.colors.base}>
									{session()?.title ?? id}
								</text>
								<Show when={formatDuration(taken() ?? 0)}>
									{(text: () => string) => (
										<text flexShrink={0} wrapMode="none" fg={props.colors.dim}>
											{text()}
										</text>
									)}
								</Show>
								<Show when={cost()}>
									{(text: () => string) => (
										<text flexShrink={0} wrapMode="none" fg={props.colors.dim}>
											{text()}
										</text>
									)}
								</Show>
							</box>
						)
					}}
				</For>
			<Show when={children().length > SUBAGENT_LIMIT}>
				<text fg={props.colors.dim}>{`+${children().length - SUBAGENT_LIMIT} more`}</text>
			</Show>
		</Panel>
	)
}

function Meter(props: { percent: number; limited: boolean; colors: Colors; width: number }) {
	const tone = createMemo(() =>
		props.limited || props.percent >= 90
			? props.colors.error
			: props.percent >= 70
				? props.colors.warning
				: props.colors.success,
	)
	const cells = createMemo(() => Math.max(6, props.width))
	const filled = createMemo(() =>
		Math.max(0, Math.min(cells(), Math.round((props.percent / 100) * cells()))),
	)
	return (
		<box flexDirection="row">
			<text wrapMode="none" fg={tone()}>
				{"\u2588".repeat(filled())}
			</text>
			<text wrapMode="none" fg={props.colors.faint}>
				{"\u2591".repeat(cells() - filled())}
			</text>
			<text wrapMode="none" fg={props.colors.dim}>
				{`${Math.round(props.percent)}% used`.padStart(10)}
			</text>
		</box>
	)
}

/** OpenCode Go allowance windows: rolling 5 hours, weekly, monthly. */
function MeterPlaceholder(props: { colors: Colors; width: number }) {
	return (
		<box flexDirection="row">
			<text wrapMode="none" fg={props.colors.faint}>
				{"\u2591".repeat(Math.max(6, props.width))}
			</text>
			<text wrapMode="none" fg={props.colors.dim}>
				{"\u2014".padStart(10)}
			</text>
		</box>
	)
}

function LimitMeters(props: { context: Plugin.Context; sessionID: string; colors: Colors; barWidth: number }) {
	const [go, setGo] = createSignal<UsageLimitsGo | undefined>(undefined)
	const [loaded, setLoaded] = createSignal(false)

	const load = async () => {
		try {
			const result = await props.context.client.experimental.usage.limits({
				location: { directory: props.context.data.session.get(props.sessionID)?.location?.directory },
			})
			setGo(result.data?.go)
		} catch {
			// Limits are optional: a non-Go workspace or an older server simply has none.
		} finally {
			setLoaded(true)
		}
	}

	createEffect(() => {
		void load()
		const timer = setInterval(() => void load(), 5 * 60_000)
		const stops = [
			props.context.data.on("session.execution.succeeded", () => void load()),
			props.context.data.on("session.execution.failed", () => void load()),
		]
		onCleanup(() => {
			clearInterval(timer)
			for (const stop of stops) stop()
		})
	})

	return (
		<>
			<Show when={!loaded()}>
				<MeterPlaceholder colors={props.colors} width={props.barWidth} />
				<MeterPlaceholder colors={props.colors} width={props.barWidth} />
				<MeterPlaceholder colors={props.colors} width={props.barWidth} />
			</Show>
			<Show when={go()?.rolling}>
				{(meter: () => UsageLimitsMeter) => (
					<Meter percent={meter().percent} limited={meter().limited} colors={props.colors} width={props.barWidth} />
				)}
			</Show>
			<Show when={go()?.weekly}>
				{(meter: () => UsageLimitsMeter) => (
					<Meter percent={meter().percent} limited={meter().limited} colors={props.colors} width={props.barWidth} />
				)}
			</Show>
			<Show when={go()?.monthly}>
				{(meter: () => UsageLimitsMeter) => (
					<Meter percent={meter().percent} limited={meter().limited} colors={props.colors} width={props.barWidth} />
				)}
			</Show>
		</>
	)
}

function Spacer() {
	return <box height={1} />
}

function Usage(props: { context: Plugin.Context; sessionID: string; colors: Colors }) {
	const data = props.context.data
	const [now, setNow] = createSignal(Date.now())

	const session = createMemo(() => data.session.get(props.sessionID))
	const messages = createMemo(() => {
		const list = data.session.message.list(props.sessionID)
		const boundary = session()?.revert?.messageID
		if (boundary === undefined) return list
		const index = list.findIndex((message) => message.id === boundary)
		return index === -1 ? list : list.slice(0, index)
	})
	const assistant = createMemo(() => lastAssistant(messages()))

	createEffect(() => {
		if (data.session.status(props.sessionID) !== "running") return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		onCleanup(() => clearInterval(timer))
	})

	const step = createMemo<Step | undefined>(() => {
		const value = assistant()
		if (value === undefined) return undefined
		const used = buckets(value.tokens)
		if (used === undefined) return undefined
		return { used, speed: tps(value, now()) }
	})

	// A new step exists before its usage does. Hold the previous numbers rather
	// than blanking the panel, and reset only when the pane switches session.
	const [lastStep, setLastStep] = createSignal<Step | undefined>(undefined)
	let lastSession = ""
	createEffect(() => {
		if (lastSession !== props.sessionID) {
			lastSession = props.sessionID
			setLastStep(undefined)
		}
		const value = step()
		if (value !== undefined) setLastStep(value)
	})
	const shown = createMemo(() => step() ?? lastStep())
	const totalCost = createMemo(() => formatCost(session()?.cost ?? 0))
	const [innerWidth, setInnerWidth] = createSignal(0)
	const barWidth = createMemo(() => Math.max(6, innerWidth() - 10))

	const tokenCells = createMemo<ReadonlyArray<CellData>>(() => {
		const value = shown()
		return [
			{ label: "input", value: value === undefined ? "\u2014" : formatTokens(value.used.input) },
			{ label: "output", value: value === undefined ? "\u2014" : formatTokens(value.used.output) },
		]
	})
	const detailCells = createMemo<ReadonlyArray<CellData>>(() => {
		const value = shown()
		return [
			{ label: "thinking", value: value === undefined ? "\u2014" : formatTokens(value.used.reasoning) },
			{ label: "cache r", value: value === undefined ? "\u2014" : formatTokens(value.used.cacheRead) },
			{ label: "cache w", value: value === undefined ? "\u2014" : formatTokens(value.used.cacheWrite) },
			{
				label: "speed",
				value: value?.speed === undefined || value?.speed === null ? "\u2014" : `${Math.round(value.speed)} t/s`,
			},
		]
	})
	const costCells = createMemo<ReadonlyArray<CellData>>(() => [
		{ label: "cost", value: totalCost() ?? "\u2014" },
	])

	return (
		<Panel title="USAGE" colors={props.colors} onWidth={setInnerWidth}>
				<LimitMeters
					context={props.context}
					sessionID={props.sessionID}
					colors={props.colors}
					barWidth={barWidth()}
				/>
				<Spacer />
				<Cells cells={tokenCells()} colors={props.colors} />
				<Spacer />
				<Cells cells={detailCells()} colors={props.colors} />
				<Spacer />
			<Cells cells={costCells()} colors={props.colors} />
		</Panel>
	)
}

function Tools(props: { context: Plugin.Context; sessionID: string; colors: Colors }) {
	const data = props.context.data
	const messages = createMemo(() => {
		const list = data.session.message.list(props.sessionID)
		const boundary = data.session.get(props.sessionID)?.revert?.messageID
		if (boundary === undefined) return list
		const index = list.findIndex((message) => message.id === boundary)
		return index === -1 ? list : list.slice(0, index)
	})
	const rows = createMemo(() => {
		const assistant = lastAssistant(messages())
		return assistant === undefined ? [] : toolRows(assistant)
	})
	const running = createMemo(() => data.session.status(props.sessionID) === "running")
	const [lastRows, setLastRows] = createSignal<ReadonlyArray<ToolRow>>([])
	createEffect(() => {
		const value = rows()
		if (value.length > 0) setLastRows(value)
	})
	// While a turn is starting, its assistant step has no tool calls yet; keep the
	// previous run visible instead of collapsing the panel and popping it back.
	const shown = createMemo(() => (rows().length > 0 ? rows() : running() ? lastRows() : []))

	return (
		<Panel title="TOOLS" count={shown().length || undefined} colors={props.colors}>
			<Show when={shown().length === 0}>
				<text fg={props.colors.dim}>none</text>
			</Show>
				<For each={shown().slice(0, TOOL_LIMIT)}>
					{(row) => (
						<box flexDirection="row" gap={1} minWidth={0}>
							<text
								flexShrink={0}
								fg={
									row.status === "completed"
										? props.colors.success
										: row.status === "error"
											? props.colors.error
											: props.colors.warning
								}
							>
								{row.status === "completed" ? "\u2713" : row.status === "error" ? "\u2717" : "\u25d0"}
							</text>
							<text flexShrink={1} minWidth={0} wrapMode="none" truncate fg={props.colors.base}>
								{row.name}
							</text>
							<Show when={formatDuration(row.duration ?? 0)}>
								{(text: () => string) => (
									<text flexShrink={0} wrapMode="none" fg={props.colors.faint}>
										{text()}
									</text>
								)}
							</Show>
						</box>
					)}
				</For>
			<Show when={shown().length > TOOL_LIMIT}>
				<text fg={props.colors.dim}>{`+${shown().length - TOOL_LIMIT} more`}</text>
			</Show>
		</Panel>
	)
}

type GitState = {
	readonly branch: string
	readonly modified: number
	readonly untracked: number
	readonly conflicts: number
	readonly binary: number
	readonly submodules: number
	readonly added: number
	readonly removed: number
}

type GitInspection = GitState | "not-repo" | "unavailable"

export function parseStatus(stdout: string): GitState | null {
	let head: string | undefined
	let oid: string | undefined
	let modified = 0
	let untracked = 0
	let conflicts = 0
	let submodules = 0

	for (const line of stdout.split("\n")) {
		if (line.startsWith("# branch.head ")) head = line.slice(14).trim()
		else if (line.startsWith("# branch.oid ")) oid = line.slice(13).trim()
		else if (line.startsWith("u ")) {
			conflicts += 1
			modified += 1
		} else if (line.startsWith("? ")) untracked += 1
		else if (/^[12] /.test(line)) {
			modified += 1
			// `1 <XY> <sub> ...`: a submodule entry carries `S<c><m><u>` instead of `N...`.
			const sub = line.split(" ")[2]
			if (sub?.startsWith("S")) submodules += 1
		}
	}

	if (head === undefined && oid === undefined) return null
	const detached = head === undefined || head === "(detached)"
	const sha = oid !== undefined && oid !== "(initial)" ? oid.slice(0, 7) : ""
	return {
		branch: detached ? sha || "detached" : (head as string),
		modified,
		untracked,
		conflicts,
		binary: 0,
		submodules,
		added: 0,
		removed: 0,
	}
}

export function parseNumstat(stdout: string): { added: number; removed: number; binary: number } {
	let added = 0
	let removed = 0
	let binary = 0
	for (const line of stdout.split("\n")) {
		const [left, right] = line.split("\t")
		if (left === undefined || right === undefined) continue
		const plus = Number(left)
		const minus = Number(right)
		if (Number.isFinite(plus)) added += plus
		else if (left === "-") binary += 1
		if (Number.isFinite(minus)) removed += minus
	}
	return { added, removed, binary }
}

function Workspace(props: { context: Plugin.Context; sessionID: string; colors: Colors }) {
	const data = props.context.data
	const directory = createMemo(() => data.session.get(props.sessionID)?.location?.directory)
	const name = createMemo(() => basename(directory() ?? "") || "workspace")
	const [state, setState] = createSignal<GitInspection | undefined>(undefined)
	const entries = createMemo(() => data.session.message.list(props.sessionID).length)

	let running = false
	let queued = false
	let current: string | undefined

	const inspect = async (): Promise<void> => {
		const dir = directory()
		current = dir
		if (dir === undefined) {
			setState("unavailable")
			return
		}
		if (running) {
			queued = true
			return
		}
		running = true
		try {
			const { stdout } = await exec(
				"git",
				["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
				{ cwd: dir, timeout: 3_000, maxBuffer: 4 * 1024 * 1024 },
			)
			const parsed = parseStatus(stdout)
			if (parsed === null) {
				setState("not-repo")
				return
			}
			let totals: { added: number; removed: number; binary: number } | undefined
			for (const args of [
				["diff", "--numstat", "HEAD"],
				["diff", "--numstat"],
			]) {
				try {
					const diff = await exec("git", args, { cwd: dir, timeout: 3_000, maxBuffer: 4 * 1024 * 1024 })
					totals = parseNumstat(diff.stdout)
					break
				} catch {
					continue
				}
			}
			setState({ ...parsed, ...(totals ?? {}) })
		} catch (error) {
			setState((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "unavailable" : "not-repo")
		} finally {
			running = false
			if (queued) {
				queued = false
				if (current === directory()) void inspect()
			}
		}
	}

	createEffect(() => {
		directory()
		void inspect()
		const stops = [
			data.on("session.execution.succeeded", () => void inspect()),
			data.on("session.execution.failed", () => void inspect()),
			data.on("vcs.branch.updated", () => void inspect()),
		]
		onCleanup(() => {
			for (const stop of stops) stop()
		})
	})

	const status = createMemo(() => {
		const value = state()
		if (value === undefined) return { text: "inspecting\u2026", tone: props.colors.dim }
		if (value === "not-repo") return { text: "not a Git repository", tone: props.colors.dim }
		if (value === "unavailable") return { text: "Git unavailable", tone: props.colors.warning }
		if (value.conflicts > 0) return { text: "Conflicts", tone: props.colors.error }
		if (value.modified + value.untracked > 0) return { text: "Modified", tone: props.colors.warning }
		return { text: "Clean", tone: props.colors.dim }
	})
	const git = createMemo(() => {
		const value = state()
		return typeof value === "object" ? value : undefined
	})

	return (
		<Panel title="WORKSPACE" colors={props.colors}>
			<text fg={props.colors.base} wrapMode="none" truncate>
				<b>{name()}</b>
			</text>
			<Show when={git()?.branch}>
				{(branch: () => string) => (
					<text fg={props.colors.syntax.function} wrapMode="none" truncate>
						{`\u2387 ${branch()}`}
					</text>
				)}
			</Show>
			<Pair label="Git" colors={props.colors}>
				<text fg={status().tone} wrapMode="none">
					{status().text}
				</text>
			</Pair>
			<Show when={git()}>
				{(value: () => GitState) => (
					<>
						<Show when={value().modified + value().untracked > 0}>
							<Pair label="Changed" colors={props.colors}>
								<text fg={props.colors.base} wrapMode="none">
									{`${value().modified} ${value().modified === 1 ? "file" : "files"}`}
								</text>
								<text fg={props.colors.success} wrapMode="none">{`+${value().added}`}</text>
								<text fg={props.colors.error} wrapMode="none">{`\u2212${value().removed}`}</text>
							</Pair>
						</Show>
						<Show when={value().conflicts > 0}>
							<Pair label="Conflicts" colors={props.colors}>
								<text fg={props.colors.error}>{value().conflicts}</text>
							</Pair>
						</Show>
						<Show when={value().untracked > 0}>
							<Pair label="Untracked" colors={props.colors}>
								<text fg={props.colors.base}>{value().untracked}</text>
							</Pair>
						</Show>
						<Show when={value().binary > 0}>
							<Pair label="Binary" colors={props.colors}>
								<text fg={props.colors.base}>{value().binary}</text>
							</Pair>
						</Show>
						<Show when={value().submodules > 0}>
							<Pair label="Submodules" colors={props.colors}>
								<text fg={props.colors.base}>{value().submodules}</text>
							</Pair>
						</Show>
					</>
				)}
			</Show>
			<Pair label="History" colors={props.colors}>
				<text fg={props.colors.base}>{`${entries()} entries`}</text>
			</Pair>
			<Pair label="Storage" colors={props.colors}>
				<text fg={props.colors.dim}>Saved</text>
			</Pair>
		</Panel>
	)
}

function Extra(props: { context: Plugin.Context; sessionID: string; colors: Colors }) {
	return (
		<box flexDirection="column" gap={0} flexShrink={0}>
			<Subagents context={props.context} sessionID={props.sessionID} colors={props.colors} />
			<Usage context={props.context} sessionID={props.sessionID} colors={props.colors} />
			<Workspace context={props.context} sessionID={props.sessionID} colors={props.colors} />
			<Tools context={props.context} sessionID={props.sessionID} colors={props.colors} />
		</box>
	)
}

export default Plugin.define({
	id: "oc-sidebar-extra",
	setup(context) {
		const colors = colorsOf(context.theme)
		context.ui.slot({
			append: "sidebar.content",
			render: (input) => <Extra context={context} sessionID={input.sessionID} colors={colors} />,
		})
	},
})
