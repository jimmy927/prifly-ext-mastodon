/** Building tools: argument parsing, and the guard that turns a `UserError` into the tool's answer. */

import type { ExtensionTool, ExtensionToolContext } from "@prifly/extension-api";
import { UserError } from "./errors";

export type Args = Record<string, unknown>;
export type Property = Record<string, unknown>;

export function optStr(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new UserError(`${key} must be text.`);
  return value.trim() === "" ? undefined : value.trim();
}

export function reqStr(args: Args, key: string): string {
  const value = optStr(args, key);
  if (value === undefined) throw new UserError(`${key} is required.`);
  return value;
}

export function optInt(
  args: Args,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new UserError(`${key} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function optEnum<T extends string>(
  args: Args,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = optStr(args, key);
  if (value === undefined) return fallback;
  const found = allowed.find((each) => each === value);
  if (found === undefined) throw new UserError(`${key} must be one of ${allowed.join(", ")}.`);
  return found;
}

/** Body text exactly as given (leading and trailing blanks kept off, inner ones kept). */
export function postText(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new UserError(`${key} is required.`);
  return value.trim();
}

export function defineTool(
  spec: {
    name: string;
    description: string;
    properties: Record<string, Property>;
    required?: string[];
  },
  run: (args: Args, tctx: ExtensionToolContext) => Promise<string>,
): ExtensionTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: "object",
      properties: spec.properties,
      required: spec.required ?? [],
      additionalProperties: false,
    },
    call: async (args, tctx) => {
      try {
        return await run(args, tctx);
      } catch (error) {
        if (error instanceof UserError) return error.message;
        throw error;
      }
    },
  };
}
