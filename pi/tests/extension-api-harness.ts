import type {
	ExecOptions,
	ExecResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
} from "@earendil-works/pi-coding-agent";

type EventType = ExtensionEvent["type"];
type Handler = (event: any, context: ExtensionContext) => unknown | Promise<unknown>;

export interface ExecCall {
	command: string;
	args: string[];
	options?: ExecOptions;
}

export interface HarnessOptions {
	cwd?: string;
	exec?: (call: ExecCall) => ExecResult | Promise<ExecResult>;
	appendEntry?: (type: string, data: unknown) => void;
	branch?: any[];
	activeTools?: string[];
}

export interface RegisteredCommandCall {
	name: string;
	options: any;
}

export class ExtensionHarness {
	readonly entries: { type: string; data: unknown }[] = [];
	readonly execCalls: ExecCall[] = [];
	readonly messages: { content: unknown; options: unknown }[] = [];
	readonly notifications: { message: string; type: string | undefined }[] = [];
	private abortCallCount = 0;

	get abortCalls(): number {
		return this.abortCallCount;
	}
	readonly handlers = new Map<EventType, Handler[]>();
	readonly commands = new Map<string, RegisteredCommandCall["options"]>();
	readonly tools = new Map<string, any>();
	readonly api: ExtensionAPI;
	readonly context: ExtensionContext;
	private activeTools: string[];

	constructor(options: HarnessOptions = {}) {
		this.activeTools = options.activeTools ?? [];
		const branch = options.branch ?? [];
		this.context = {
			cwd: options.cwd ?? "/workspace",
			hasUI: false,
			signal: new AbortController().signal,
			sessionManager: {
				getLeafEntry: () => branch.at(-1),
				getBranch: () => branch,
			} as any,
			ui: {
				notify: (message: string, type?: string) => {
					this.notifications.push({ message, type });
				},
				select: async () => undefined,
				confirm: async () => false,
				input: async () => undefined,
			} as any,
			// Command-handler-only members (ExtensionCommandContext), stubbed here too
			// so commands registered via registerCommand can be exercised directly.
			waitForIdle: async () => undefined,
			abort: () => {
				this.abortCallCount += 1;
			},
		} as unknown as ExtensionContext;

		this.api = {
			on: (event: EventType, handler: Handler) => {
				const handlers = this.handlers.get(event) ?? [];
				handlers.push(handler);
				this.handlers.set(event, handlers);
			},
			exec: async (command: string, args: string[], execOptions?: ExecOptions) => {
				const call = { command, args, options: execOptions };
				this.execCalls.push(call);
				return options.exec?.(call) ?? { code: 0, stdout: "", stderr: "" };
			},
			appendEntry: (type: string, data?: unknown) => {
				options.appendEntry?.(type, data);
				this.entries.push({ type, data });
			},
			sendUserMessage: (content: unknown, messageOptions?: unknown) =>
				this.messages.push({ content, options: messageOptions }),
			getActiveTools: () => [...this.activeTools],
			setActiveTools: (tools: string[]) => {
				this.activeTools = [...tools];
			},
			getAllTools: () => [],
			registerProvider: () => undefined,
			registerTool: (toolDef: any) => {
				this.tools.set(toolDef.name, toolDef);
			},
			registerCommand: (name: string, commandOptions: any) => {
				this.commands.set(name, commandOptions);
			},
			registerShortcut: () => undefined,
			registerFlag: () => undefined,
			getFlag: () => undefined,
			registerMessageRenderer: () => undefined,
			registerEntryRenderer: () => undefined,
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
	}

	async emit<T extends ExtensionEvent>(event: T): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.handlers.get(event.type) ?? []) {
			results.push(await handler(event, this.context));
		}
		return results;
	}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	/** Invoke a previously registered command's handler with this harness's context. */
	invokeCommand(name: string, args: string): Promise<void> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`no command registered: ${name}`);
		return command.handler(args, this.context);
	}
}
