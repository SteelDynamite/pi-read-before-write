interface ExtensionContext {
    cwd: string;
}
interface ExtensionAPI {
    on(name: "tool_call", handler: ExtensionHandler<ToolCallResult | undefined>): void;
    on(name: "tool_result", handler: ExtensionHandler<undefined>): void;
}
type ExtensionHandler<T> = (event: ToolEventWithPath, ctx: ExtensionContext) => T | Promise<T>;
interface ToolCallResult {
    block: true;
    reason: string;
}
interface ToolEventWithPath {
    toolName: string;
    input: {
        path?: unknown;
    };
    isError?: boolean;
}
export declare function resolveTrackedPath(inputPath: string, cwd: string): Promise<string>;
export default function readBeforeWrite(pi: ExtensionAPI): void;
export {};
